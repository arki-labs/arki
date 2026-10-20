/**
 * `fileStorage`: the files-table lifecycle on Postgres.
 *
 *   createUpload ──► pending ──confirm──► ready ──remove──► deleting ──sweep──► (row gone)
 *
 * Two rules decide the design. The server derives every key from the row, and
 * nothing is `ready` until the server has looked at the stored object.
 * Storage I/O never runs inside a database transaction.
 *
 * Expected outcomes are returned as failures (`FileUnavailable`, `UploadPending`,
 * `FileWrongState`, `UploadMismatch`); bad input, config and store faults throw.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { FailureOf } from '@arki/failure';
import { isFailure } from '@arki/failure';

import type { CREATE_UPLOAD_FAILURES } from '../files/failures.js';
import type { FileId, SignedFileUrl, UploadRequest, UploadTicket } from '../files/schemas.js';
import type { SignedUploadAdapter, StorageAdapter } from '../storage/types.js';
import type { CleanupOptions, CleanupResult } from './cleanup.js';
import type { FilesContext, FilesDb } from './context.js';
import type { FileRow, FilesTable, OwnerOf } from './table.js';
import { FILE_ERROR_CODES, FileStorageError } from '../files/errors.js';
import { FileUnavailable, FileWrongState, UploadMismatch, UploadPending } from '../files/failures.js';
import { fileId, uploadRequest } from '../files/schemas.js';
import { cleanupOrphans } from './cleanup.js';
import { fail, filesLog } from './context.js';

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

type Unavailable = FailureOf<typeof FileUnavailable>;
type WrongState = FailureOf<typeof FileWrongState>;

export type FileStorage<T extends FilesTable> = {
  /** Writes a pending row, then signs a create-only PUT. Policy and ID refusals return before I/O. */
  createUpload(
    actor: OwnerOf<T>,
    request: UploadRequest,
  ): Promise<UploadTicket | FailureOf<(typeof CREATE_UPLOAD_FAILURES)[number]>>;
  /** Checks the stored object against the row and marks it ready. Idempotent. */
  confirmUpload(
    actor: OwnerOf<T>,
    id: FileId,
  ): Promise<
    FileRow<T> | Unavailable | WrongState | FailureOf<typeof UploadPending> | FailureOf<typeof UploadMismatch>
  >;
  get(actor: OwnerOf<T>, id: FileId): Promise<FileRow<T> | Unavailable>;
  /** A GET URL for a ready file. Store the `FileId`, never this URL. */
  url(
    actor: OwnerOf<T>,
    id: FileId,
    options?: { expiresIn?: number; disposition?: 'inline' | 'attachment'; filename?: string },
  ): Promise<SignedFileUrl | Unavailable | WrongState>;
  /** Marks the file deleting; deletes now when it is safe, else leaves it to the sweep. */
  remove(actor: OwnerOf<T>, id: FileId): Promise<{ physical: 'done' | 'scheduled' } | Unavailable>;
  cleanupOrphans(options?: CleanupOptions): Promise<CleanupResult>;
};

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
  return typeof capabilities === 'object' && capabilities !== null && Reflect.get(capabilities, 'signedPut') === true;
}

/** Runs one object-store call; any failure that is not already coded becomes `ARKI_FS_E007`. */
async function storeCall<R>(what: string, call: () => Promise<R>): Promise<R> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof FileStorageError) throw error;
    return fail(FILE_ERROR_CODES.storage, `object store failed: ${what}`, error);
  }
}

/** The file is in the wrong state for this call; the log says which state. */
function wrongState(fileId: FileId, why: string) {
  filesLog.debug('{fileId}: wrong state ({why})', { fileId, why });
  return FileWrongState({ fileId });
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Builds the files lifecycle once, at boot. Synchronous and cheap: it only
 * validates `options` (`ARKI_FS_E001`) and the adapter (`ARKI_FS_E006`).
 *
 * @example
 * ```ts
 * export const storage = fileStorage(db, createR2Storage({ ... }), {
 *   files, bucket: 'uploads', limits: { maxSize: 20_000_000, allowedMime: ['image/*', 'application/pdf'] },
 * });
 * ```
 */
export function fileStorage<T extends FilesTable>(
  db: FilesDb,
  adapter: SignedUploadAdapter,
  options: FileStorageOptions<T>,
): FileStorage<T> {
  const { files: table, policy = {}, ...rest } = options;
  const parsed = configSchema.safeParse(rest);
  if (!parsed.success) fail(FILE_ERROR_CODES.invalid, `fileStorage: invalid options: ${z.prettifyError(parsed.error)}`);
  if (!signsUploads(adapter)) {
    fail(FILE_ERROR_CODES.unsupported, 'fileStorage: the adapter cannot sign uploads; use the S3 or R2 adapter');
  }
  const config = parsed.data;
  const files: FilesTable = table;
  const context: FilesContext = { db, adapter, files, bucket: config.bucket };
  const grace = sql`make_interval(secs => ${config.graceSeconds})`;

  const canCreate = policy.canCreate ?? (() => true);
  const canRead = policy.canRead ?? ((file, actor) => file.ownerId === actor);
  const canRemove = policy.canRemove ?? ((file, actor) => file.ownerId === actor);

  const parseId = (id: FileId): FileId => {
    const result = fileId.schema.safeParse(id);
    return result.success ? result.data : fail(FILE_ERROR_CODES.invalid, 'not a file id');
  };

  const read = async (id: FileId): Promise<FileRow<T> | undefined> => {
    const [row] = await db
      .select()
      .from(files)
      .where(and(eq(files.id, id), eq(files.bucket, config.bucket)))
      .limit(1);
    return row;
  };

  /** One failure for missing, other binding and denied, so callers cannot probe for existence. The log says which. */
  const load = async (
    actor: OwnerOf<T>,
    id: FileId,
    allowed: (file: FileRow<T>, actor: OwnerOf<T>) => boolean | Promise<boolean>,
  ) => {
    const fileId = parseId(id);
    const row = await read(fileId);
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
    await db
      .update(files)
      .set({ status: 'deleting', cleanupAt: sql`greatest(now(), ${files.expiresAt} + ${grace})` })
      .where(and(eq(files.id, row.id), eq(files.status, 'pending')));
    filesLog.debug('{fileId}: pending → deleting ({reason})', { fileId: row.id, reason });
    return UploadMismatch({ fileId: row.id, reason });
  };

  return {
    async createUpload(actor, request) {
      const parsedRequest = uploadRequest.safeParse(request);
      if (!parsedRequest.success) {
        fail(FILE_ERROR_CODES.invalid, `invalid upload request: ${z.prettifyError(parsedRequest.error)}`);
      }
      const { mime, size } = parsedRequest.data;
      if (size > config.limits.maxSize) {
        fail(FILE_ERROR_CODES.invalid, `size ${String(size)} is over the limit of ${String(config.limits.maxSize)}`);
      }
      if (!mimeAllowed(mime, config.limits.allowedMime))
        fail(FILE_ERROR_CODES.invalid, `type "${mime}" is not allowed`);
      if (!(await canCreate(actor, parsedRequest.data))) {
        filesLog.debug('upload refused by the policy');
        return FileUnavailable({});
      }

      const id = fileId.create();
      if (isFailure(id)) return id;
      const key = `${config.keyPrefix}/${id}`;
      const ttl = config.uploadTtlSeconds;
      // The row commits before any URL exists (G1). If signing fails, the sweep removes the row.
      const [row] = await db
        .insert(files)
        .values({
          id,
          ownerId: actor,
          bucket: config.bucket,
          key,
          mime,
          size,
          status: 'pending',
          expiresAt: sql`now() + make_interval(secs => ${ttl})`,
          cleanupAt: sql`now() + make_interval(secs => ${ttl + config.graceSeconds})`,
        })
        .returning({ expiresAt: files.expiresAt });
      if (!row) return fail(FILE_ERROR_CODES.storage, 'insert returned no row');

      const url = await storeCall('sign PUT', () =>
        adapter.getSignedUrl(key, {
          operation: 'put',
          expiresIn: ttl,
          contentType: mime,
          contentLength: size,
          ifNoneMatch: '*',
        }),
      );
      filesLog.debug('{fileId}: created pending ({size} bytes)', { fileId: id, size });
      return {
        fileId: id,
        url,
        method: 'PUT',
        headers: { 'Content-Type': mime, 'If-None-Match': '*' },
        expiresAt: row.expiresAt.toString(),
      };
    },

    async confirmUpload(actor, id) {
      const row = await load(actor, id, canRead);
      if (FileUnavailable.is(row)) return row;
      if (row.status === 'ready') return row;
      if (row.status === 'deleting') return wrongState(row.id, 'being deleted');

      // No object yet: the PUT has not landed. The row stays pending, so a later confirm can win.
      const meta = await storeCall('HEAD', () => adapter.getMetadata(row.key));
      if (!meta) return UploadPending({ fileId: row.id });
      if (meta.size !== row.size) return reject(row, `size ${String(meta.size)} ≠ ${String(row.size)}`);
      if (meta.contentType.toLowerCase() !== row.mime.toLowerCase()) {
        return reject(row, `type "${meta.contentType}" ≠ "${row.mime}"`);
      }

      let sha256: string | null = null;
      if (config.verify === 'hash') {
        const bytes = await storeCall('GET', () => adapter.get(row.key));
        if (!bytes) return UploadPending({ fileId: row.id });
        if (bytes.byteLength !== row.size) return reject(row, `downloaded ${String(bytes.byteLength)} bytes`);
        sha256 = toHex(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)));
      }

      const [ready] = await db
        .update(files)
        .set({ status: 'ready', etag: meta.etag || null, sha256, confirmedAt: sql`now()`, cleanupAt: null })
        .where(and(eq(files.id, row.id), eq(files.status, 'pending'), sql`${files.cleanupAt} > now()`))
        .returning();
      if (ready) {
        filesLog.debug('{fileId}: pending → ready', { fileId: row.id });
        return ready;
      }

      // Lost the race: a concurrent confirm won (fine), or the sweep or a remove did.
      const now = await read(row.id);
      if (now?.status === 'ready') return now;
      return wrongState(row.id, now ? `${now.status}, confirm window passed` : 'swept');
    },

    async get(actor, id) {
      return load(actor, id, canRead);
    },

    async url(actor, id, options = {}) {
      const parsedOptions = urlOptionsSchema.safeParse(options);
      if (!parsedOptions.success)
        fail(FILE_ERROR_CODES.invalid, `invalid url options: ${z.prettifyError(parsedOptions.error)}`);
      const { expiresIn = config.urlTtlSeconds, disposition = 'attachment', filename } = parsedOptions.data;
      if (expiresIn > config.maxUrlTtlSeconds) {
        fail(
          FILE_ERROR_CODES.invalid,
          `expiresIn ${String(expiresIn)} is over the cap of ${String(config.maxUrlTtlSeconds)}`,
        );
      }

      const row = await load(actor, id, canRead);
      if (FileUnavailable.is(row)) return row;
      if (row.status !== 'ready') return wrongState(row.id, `${row.status}, not ready`);
      // Taken before signing, so the reported deadline is never later than the real one.
      const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
      const url = await storeCall('sign GET', () =>
        adapter.getSignedUrl(row.key, { operation: 'get', expiresIn, disposition, filename }),
      );
      return { url, expiresAt };
    },

    async remove(actor, id) {
      const row = await load(actor, id, canRemove);
      if (FileUnavailable.is(row)) return row;
      // A pending object may still receive a PUT until expires_at + grace; delete only after that.
      const [marked] = await db
        .update(files)
        .set({
          status: 'deleting',
          cleanupAt: sql`case when ${files.status} = 'pending' then greatest(now(), ${files.expiresAt} + ${grace}) else now() end`,
        })
        .where(and(eq(files.id, row.id), ne(files.status, 'deleting')))
        .returning({ key: files.key, due: sql<boolean>`${files.cleanupAt} <= now()` });
      if (!marked) return { physical: 'scheduled' };
      filesLog.debug('{fileId}: {from} → deleting', { fileId: row.id, from: row.status });
      if (!marked.due) return { physical: 'scheduled' };

      try {
        await adapter.delete(marked.key);
      } catch (error) {
        filesLog.warn('{fileId}: object delete failed; the sweep retries it', {
          fileId: row.id,
          error: error instanceof Error ? error : String(error),
        });
        return { physical: 'scheduled' };
      }
      await db.delete(files).where(and(eq(files.id, row.id), eq(files.status, 'deleting')));
      return { physical: 'done' };
    },

    cleanupOrphans(cleanupOptions) {
      return cleanupOrphans(context, cleanupOptions);
    },
  };
}
