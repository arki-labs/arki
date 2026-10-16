/**
 * `@arki/fs/orpc`: the files table over oRPC, contract-first.
 *
 * - `filesContract`: the four procedures. Add it to the app contract as `files`.
 * - `filesRouter(implementer.files, { storage, actor })`: their handlers.
 *
 * Output types reach the browser through the contract; nothing is restated.
 * Outputs never carry the bucket, key or owner.
 */
import type { Context, ImplementerInternal } from '@orpc/server';
import { oc } from '@orpc/contract';
import { ORPCError } from '@orpc/server';
import { z } from 'zod';

import type { FileErrorCode } from './files/errors.js';
import type { FilesTable, FileStorage, OwnerOf } from './pg/index.js';
import { FILE_ERROR_CODES, isFileStorageError } from './files/errors.js';
import { fileId, fileRecord, signedFileUrl, uploadRequest, uploadTicket } from './files/schemas.js';
import { toFileRecord } from './pg/record.js';

const byFileId = z.strictObject({ fileId: fileId.schema });

export const filesContract = {
  createUpload: oc.input(uploadRequest).output(uploadTicket),
  confirmUpload: oc.input(byFileId).output(fileRecord),
  url: oc
    .input(z.strictObject({ fileId: fileId.schema, expiresIn: z.number().int().min(1).optional() }))
    .output(signedFileUrl),
  remove: oc.input(byFileId).output(z.void()),
};
export type FilesContract = typeof filesContract;

const ORPC_CODES = {
  [FILE_ERROR_CODES.invalid]: 'BAD_REQUEST',
  [FILE_ERROR_CODES.unavailable]: 'NOT_FOUND',
  [FILE_ERROR_CODES.wrongState]: 'CONFLICT',
  [FILE_ERROR_CODES.objectMissing]: 'CONFLICT',
  [FILE_ERROR_CODES.mismatch]: 'CONFLICT',
  [FILE_ERROR_CODES.unsupported]: 'INTERNAL_SERVER_ERROR',
  [FILE_ERROR_CODES.storage]: 'INTERNAL_SERVER_ERROR',
} as const satisfies Record<FileErrorCode, string>;

/** Runs one storage call; a `FileStorageError` becomes the matching `ORPCError`, with the `ARKI_FS_E00x` code in `data`. */
async function answer<R>(call: () => Promise<R>): Promise<R> {
  try {
    return await call();
  } catch (error) {
    if (!isFileStorageError(error)) throw error;
    throw new ORPCError(ORPC_CODES[error.code], {
      message: error.message,
      data: { code: error.code, retryable: error.retryable },
      cause: error,
    });
  }
}

/**
 * The handlers of {@link filesContract}. `storage` returns the service built
 * once at boot; `actor` returns the acting owner id (throw `UNAUTHORIZED` there
 * when there is none).
 *
 * @example
 * ```ts
 * const implementer = implement(appContract).$context<AppContext>();
 * export const router = implementer.router({
 *   files: filesRouter(implementer.files, { storage: () => storage, actor: ctx => ctx.userId }),
 * });
 * ```
 */
export function filesRouter<TInitialContext extends Context, TCurrentContext extends Context, T extends FilesTable>(
  implementer: ImplementerInternal<FilesContract, TInitialContext, TCurrentContext>,
  bind: { storage: (context: TCurrentContext) => FileStorage<T>; actor: (context: TCurrentContext) => OwnerOf<T> },
) {
  return {
    createUpload: implementer.createUpload.handler(({ input, context }) =>
      answer(() => bind.storage(context).createUpload(bind.actor(context), input)),
    ),
    confirmUpload: implementer.confirmUpload.handler(({ input, context }) =>
      answer(async () => toFileRecord(await bind.storage(context).confirmUpload(bind.actor(context), input.fileId))),
    ),
    url: implementer.url.handler(({ input, context }) =>
      answer(() => bind.storage(context).url(bind.actor(context), input.fileId, { expiresIn: input.expiresIn })),
    ),
    remove: implementer.remove.handler(({ input, context }) =>
      answer(async () => {
        await bind.storage(context).remove(bind.actor(context), input.fileId);
      }),
    ),
  };
}
