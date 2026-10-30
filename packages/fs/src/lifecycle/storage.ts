/**
 * The files-table lifecycle, shared by `@arki/fs/pg` and `@arki/fs/sqlite`.
 *
 *   createUpload ──► pending ──confirm──► ready ──remove──► deleting ──sweep──► (row gone)
 *
 * Two rules decide the design. The server derives every key from the row, and
 * nothing is `ready` until the server has looked at the stored object.
 * Storage I/O never runs inside a database transaction. Each dialect hands
 * in its statements (`./statements.ts`); everything else lives here once.
 *
 * Business and provider outcomes are returned as canonical failures. Static configuration
 * faults throw; unknown policy and implementation defects are supervised by the operation.
 */
import { z } from 'zod';

import { isFailure, UnexpectedDefect } from '@arki/failure';
import { ensure, is, parse, recordSchema } from '@arki/schema';

import type { FileId, UploadRequest } from '../files/types.js';
import type { SignedUploadAdapter, StorageAdapter } from '../storage/types.js';
import type { CleanupOptions } from './cleanup.js';
import type { FileStatements, StatementConfig } from './statements.js';
import type { FileRow, FilesTable, OwnerOf } from './table.js';
import { FILE_ERROR_CODES } from '../files/errors.js';
import { FileUnavailable, FileWrongState, UploadMismatch, UploadPending } from '../files/failures.js';
import { uploadRequest, uploadTicket } from '../files/schemas.js';
import { fileId } from '../files/types.js';
import { executeFs, storageReadFailure, storageWriteFailure } from '../storage/operation.js';
import { cleanupOrphans } from './cleanup.js';
import { fail, filesLog } from './context.js';
import { readStatement, writeStatement } from './database.js';

/** Who may do what. Every check gets the acting owner id. */
export type FilePolicy<T extends FilesTable> = {
  /** Default: everyone may create. */
  canCreate?: (actor: OwnerOf<T>, request: UploadRequest) => boolean | Promise<boolean>;
  /** Default: the owner only. */
  canRead?: (file: FileRow<T>, actor: OwnerOf<T>) => boolean | Promise<boolean>;
  /** Default: the owner only. */
  canRemove?: (file: FileRow<T>, actor: OwnerOf<T>) => boolean | Promise<boolean>;
};

export type FileStorageOptions<T extends FilesTable> = {
  files: T;
  /** Stable binding name stored in every row, e.g. `'uploads'`. Rows of another binding are invisible. */
  bucket: string;
  /** Key prefix. Default `'files'`. Keys are `${keyPrefix}/${fileId}`. */
  keyPrefix?: string;
  /** Required. `allowedMime` takes exact types and `type/*` wildcards. */
  limits: { maxSize: number; allowedMime: readonly string[] };
  /** Life of a PUT URL. Default 300. */
  uploadTtlSeconds?: number;
  /** Default life of a GET URL. Default 300. */
  urlTtlSeconds?: number;
  /** Longest GET URL a caller may ask for; longer is rejected, never clamped. Default 3600. */
  maxUrlTtlSeconds?: number;
  /** How long after a PUT URL expires an upload may still land. Default 900. */
  graceSeconds?: number;
  /** `'head'` (default) checks size and type; `'hash'` also downloads the object and stores its SHA-256. */
  verify?: 'head' | 'hash';
  policy?: FilePolicy<T>;
};

/** Inferred from the owned implementation; underlying Failure kinds cannot be erased. */
export type FileStorage<T extends FilesTable> = ReturnType<typeof createFileStorage<T>>;
export type FileUrlOptions = { expiresIn?: number; disposition?: 'inline' | 'attachment'; filename?: string };

/** S3 SigV4 URLs live at most 7 days. */
const MAX_SIGNED_SECONDS = 604_800;
const seconds = z.number().int().min(1).max(MAX_SIGNED_SECONDS);
const mimePattern = z
  .string()
  .max(255)
  .regex(/^(?:\*\/\*|[a-z0-9][\w.+-]*\/(?:\*|[a-z0-9][\w.+-]*))$/i);

const configSchema = z
  .strictObject({
    bucket: z.string().min(1).max(255),
    keyPrefix: z
      .string()
      .regex(/^[\w.-]+(?:\/[\w.-]+)*$/)
      .default('files'),
    limits: z.strictObject({
      maxSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      allowedMime: z.array(mimePattern).min(1).readonly(),
    }),
    uploadTtlSeconds: seconds.default(300),
    urlTtlSeconds: seconds.default(300),
    maxUrlTtlSeconds: seconds.default(3600),
    graceSeconds: z.number().int().nonnegative().max(MAX_SIGNED_SECONDS).default(900),
    verify: z.enum(['head', 'hash']).default('head'),
  })
  .refine(config => config.urlTtlSeconds <= config.maxUrlTtlSeconds, {
    message: 'urlTtlSeconds must not exceed maxUrlTtlSeconds',
  });

const urlOptionsSchema = z.strictObject({
  expiresIn: z.number().int().min(1).optional(),
  disposition: z.enum(['inline', 'attachment']).optional(),
  /** Goes into a quoted `Content-Disposition` parameter: no quotes, backslashes or control characters. */
  filename: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^"\\\p{Cc}]+$/u)
    .optional(),
});

function mimeAllowed(mime: string, allowed: readonly string[]): boolean {
  const [type] = mime.toLowerCase().split('/');
  return allowed.some(pattern => {
    const lower = pattern.toLowerCase();
    return lower === mime.toLowerCase() || lower === '*/*' || lower === `${type ?? ''}/*`;
  });
}

/** For JS callers and adapters typed loosely: the type system already refuses the local adapter. */
function signsUploads(adapter: StorageAdapter): boolean {
  const capabilities: unknown = Reflect.get(adapter, 'capabilities');
  return is(capabilities, recordSchema) && Reflect.get(capabilities, 'signedPut') === true;
}

/** Own a custom adapter read/signing throw without changing a returned canonical failure. */
async function storeCall<R>(call: () => Promise<R>) {
  try {
    return await call();
  } catch (error) {
    return storageReadFailure(error);
  }
}

/** The file is in the wrong state for this call; the log says which state. */
function wrongState(fileId: FileId, why: string) {
  filesLog.debug('{fileId}: wrong state ({why})', { fileId, why });
  return FileWrongState({ fileId });
}

const parseId = (id: FileId) => parse(fileId.schema, id);

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Builds the files lifecycle once, at boot, on a dialect's statements.
 * Synchronous and cheap: it only validates `options` (`ARKI_FS_E001`) and the
 * adapter (`ARKI_FS_E006`). Apps call `fileStorage` from `@arki/fs/pg` or
 * `@arki/fs/sqlite`, which pass their statements here.
 */
export function createFileStorage<T extends FilesTable>(
  adapter: SignedUploadAdapter,
  options: FileStorageOptions<T>,
  statementsFor: (config: StatementConfig) => FileStatements<T>,
) {
  const { files: _files, policy = {}, ...rest } = options;
  const parsed = configSchema.safeParse(rest);
  if (!parsed.success) fail(FILE_ERROR_CODES.invalid, `fileStorage: invalid options: ${z.prettifyError(parsed.error)}`);
  if (!signsUploads(adapter)) {
    fail(FILE_ERROR_CODES.unsupported, 'fileStorage: the adapter cannot sign uploads; use the S3 or R2 adapter');
  }
  const config = parsed.data;
  const statements = statementsFor({ bucket: config.bucket, graceSeconds: config.graceSeconds });

  const canCreate = policy.canCreate ?? (() => true);
  const canRead = policy.canRead ?? ((file, actor) => file.ownerId === actor);
  const canRemove = policy.canRemove ?? ((file, actor) => file.ownerId === actor);

  /** One failure for missing, other binding and denied, so callers cannot probe for existence. The log says which. */
  const load = async (
    actor: OwnerOf<T>,
    id: FileId,
    allowed: (file: FileRow<T>, actor: OwnerOf<T>) => boolean | Promise<boolean>,
  ) => {
    const fileId = parseId(id);
    if (isFailure<unknown>(fileId)) return fileId;
    const row = await readStatement(() => statements.read(fileId));
    if (isFailure<unknown>(row)) return row;
    if (!row) {
      filesLog.debug('{fileId}: unavailable (no row in this bucket)', { fileId });
      return FileUnavailable({ fileId });
    }
    if (!(await allowed(row, actor))) {
      filesLog.debug('{fileId}: unavailable (policy denied)', { fileId });
      return FileUnavailable({ fileId });
    }
    return row;
  };

  /** Ends a pending row whose object is wrong; the sweep deletes it once a late PUT can no longer land. */
  const reject = async (row: FileRow<T>, reason: string) => {
    const outcome = await writeStatement(() => statements.reject(row.id));
    if (isFailure<unknown>(outcome)) return outcome;
    filesLog.debug('{fileId}: pending → deleting ({reason})', { fileId: row.id, reason });
    return UploadMismatch({ fileId: row.id, reason });
  };

  return {
    createUpload(actor: OwnerOf<T>, request: UploadRequest) {
      return executeFs('fs.files.create_upload', async () => {
        const parsedRequest = parse(
          uploadRequest.refine(
            value => value.size <= config.limits.maxSize && mimeAllowed(value.mime, config.limits.allowedMime),
            { message: 'Upload exceeds the size or MIME policy.' },
          ),
          request,
        );
        if (isFailure<unknown>(parsedRequest)) return parsedRequest;
        const { mime, size } = parsedRequest;
        if (!(await canCreate(actor, parsedRequest))) {
          filesLog.debug('upload refused by the policy');
          return FileUnavailable({});
        }

        const id = fileId.create();
        if (isFailure<unknown>(id)) return id;
        const key = `${config.keyPrefix}/${id}`;
        const ttl = config.uploadTtlSeconds;
        // The row commits before any URL exists (G1). If signing fails, the sweep removes the row.
        const expiresAt = await writeStatement(() =>
          statements.insertPending({ id, ownerId: actor, key, mime, size }, ttl),
        );
        if (isFailure<unknown>(expiresAt)) return expiresAt;
        if (!expiresAt) return UnexpectedDefect({ cause: new Error('insert returned no row') });

        const url = await storeCall(() =>
          adapter.getSignedUrl(key, {
            operation: 'put',
            expiresIn: ttl,
            contentType: mime,
            contentLength: size,
            ifNoneMatch: '*',
          }),
        );
        if (isFailure<unknown>(url)) return url;
        filesLog.debug('{fileId}: created pending ({size} bytes)', { fileId: id, size });
        return ensure(
          {
            fileId: id,
            url,
            method: 'PUT' as const,
            headers: { 'Content-Type': mime, 'If-None-Match': '*' },
            expiresAt: expiresAt.toString(),
          },
          uploadTicket,
        );
      });
    },

    confirmUpload(actor: OwnerOf<T>, id: FileId) {
      return executeFs('fs.files.confirm_upload', async () => {
        const row = await load(actor, id, canRead);
        if (isFailure<unknown>(row)) return row;
        if (row.status === 'ready') return row;
        if (row.status === 'deleting') return wrongState(row.id, 'being deleted');

        // No object yet: the PUT has not landed. The row stays pending, so a later confirm can win.
        const meta = await storeCall(() => adapter.getMetadata(row.key));
        if (isFailure<unknown>(meta)) return meta;
        if (!meta) return UploadPending({ fileId: row.id });
        if (meta.size !== row.size) return reject(row, `size ${String(meta.size)} ≠ ${String(row.size)}`);
        if (meta.contentType.toLowerCase() !== row.mime.toLowerCase()) {
          return reject(row, `type "${meta.contentType}" ≠ "${row.mime}"`);
        }

        let sha256: string | null = null;
        if (config.verify === 'hash') {
          const bytes = await storeCall(() => adapter.get(row.key));
          if (isFailure<unknown>(bytes)) return bytes;
          if (!bytes) return UploadPending({ fileId: row.id });
          if (bytes.byteLength !== row.size) return reject(row, `downloaded ${String(bytes.byteLength)} bytes`);
          sha256 = toHex(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)));
        }

        const ready = await writeStatement(() => statements.markReady(row.id, { etag: meta.etag || null, sha256 }));
        if (isFailure<unknown>(ready)) return ready;
        if (ready) {
          filesLog.debug('{fileId}: pending → ready', { fileId: row.id });
          return ready;
        }

        // Lost the race: a concurrent confirm won (fine), or the sweep or a remove did.
        const now = await readStatement(() => statements.read(row.id));
        if (isFailure<unknown>(now)) return now;
        if (now?.status === 'ready') return now;
        return wrongState(row.id, now ? `${now.status}, confirm window passed` : 'swept');
      });
    },

    get(actor: OwnerOf<T>, id: FileId) {
      return executeFs('fs.files.get', () => load(actor, id, canRead));
    },

    url(actor: OwnerOf<T>, id: FileId, options: FileUrlOptions = {}) {
      return executeFs('fs.files.url', async () => {
        const parsedOptions = parse(
          urlOptionsSchema.refine(value => (value.expiresIn ?? config.urlTtlSeconds) <= config.maxUrlTtlSeconds, {
            message: 'expiresIn is over the configured cap.',
          }),
          options,
        );
        if (isFailure<unknown>(parsedOptions)) return parsedOptions;
        const { expiresIn = config.urlTtlSeconds, disposition = 'attachment', filename } = parsedOptions;

        const row = await load(actor, id, canRead);
        if (isFailure<unknown>(row)) return row;
        if (row.status !== 'ready') return wrongState(row.id, `${row.status}, not ready`);
        // Taken before signing, so the reported deadline is never later than the real one.
        const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
        const url = await storeCall(() =>
          adapter.getSignedUrl(row.key, { operation: 'get', expiresIn, disposition, filename }),
        );
        if (isFailure<unknown>(url)) return url;
        return { url, expiresAt };
      });
    },

    remove(actor: OwnerOf<T>, id: FileId) {
      return executeFs('fs.files.remove', async () => {
        const row = await load(actor, id, canRemove);
        if (isFailure<unknown>(row)) return row;
        const marked = await writeStatement(() => statements.markDeleting(row.id));
        if (isFailure<unknown>(marked)) return marked;
        if (!marked || !marked.due) return { physical: 'scheduled' as const };
        const deleted = await adapter.delete(marked.key).catch((error: unknown) => storageWriteFailure(error));
        if (isFailure<unknown>(deleted)) return deleted;
        const removed = await writeStatement(() => statements.deleteRow(row.id));
        if (isFailure<unknown>(removed)) return removed;
        return { physical: 'done' as const };
      });
    },

    cleanupOrphans(cleanupOptions?: CleanupOptions) {
      return cleanupOrphans(statements, adapter, cleanupOptions);
    },
  };
}
