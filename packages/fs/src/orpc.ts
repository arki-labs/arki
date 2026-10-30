/**
 * `@arki/fs/orpc`: the files table over oRPC, contract-first.
 *
 * - `filesContract`: the four procedures. Add it to the app contract as `files`.
 * - `filesRouter(implementer.files, { storage, actor })`: their handlers.
 *
 * Output types reach the browser through the contract; nothing is restated.
 * Outputs never carry the bucket, key or owner.
 *
 * Each procedure lists the failures its storage call can return (`errorMap`),
 * so clients get them typed and can `reviveRpcError` them. Thrown faults
 * (`FileStorageError`) become plain `ORPCError`s with the `ARKI_FS_E00x` code in `data`.
 */
import type { Context, ImplementerInternal } from '@orpc/server';
import { oc } from '@orpc/contract';
import { ORPCError } from '@orpc/server';
import { z } from 'zod';

import { InvalidEnvelope } from '@arki/failure';
import { errorMap, orThrowRpc, reviveRpcError } from '@arki/failure/orpc';

import type { FileErrorCode } from './files/errors.js';
import type { UploadClient } from './files/upload-file.js';
import type { FileStorage } from './lifecycle/storage.js';
import type { FilesTable, OwnerOf } from './lifecycle/table.js';
import { FILE_ERROR_CODES, isFileStorageError } from './files/errors.js';
import {
  CONFIRM_UPLOAD_FAILURES,
  CREATE_UPLOAD_FAILURES,
  FILE_URL_FAILURES,
  REMOVE_FILE_FAILURES,
} from './files/failures.js';
import { fileId, fileRecord, signedFileUrl, uploadRequest, uploadTicket } from './files/schemas.js';
import { toFileRecord } from './lifecycle/record.js';
import { StorageWriteUncertain } from './storage/failures.js';

const byFileId = z.strictObject({ fileId: fileId.schema });

export const filesContract = {
  createUpload: oc
    .errors(errorMap(...new Set(CREATE_UPLOAD_FAILURES)))
    .input(uploadRequest)
    .output(uploadTicket),
  confirmUpload: oc
    .errors(errorMap(...new Set(CONFIRM_UPLOAD_FAILURES)))
    .input(byFileId)
    .output(fileRecord),
  url: oc
    .errors(errorMap(...new Set(FILE_URL_FAILURES)))
    .input(z.strictObject({ fileId: fileId.schema, expiresIn: z.number().int().min(1).optional() }))
    .output(signedFileUrl),
  remove: oc
    .errors(errorMap(...new Set(REMOVE_FILE_FAILURES)))
    .input(byFileId)
    .output(z.void()),
};
export type FilesContract = typeof filesContract;

const ORPC_CODES = {
  [FILE_ERROR_CODES.invalid]: 'BAD_REQUEST',
  [FILE_ERROR_CODES.unsupported]: 'INTERNAL_SERVER_ERROR',
  [FILE_ERROR_CODES.storage]: 'INTERNAL_SERVER_ERROR',
} as const satisfies Record<FileErrorCode, string>;

/** Runs one storage call; a thrown `FileStorageError` becomes the matching `ORPCError`, with the `ARKI_FS_E00x` code in `data`. */
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

/** Restore native oRPC rejection at the explicit client bridge before uploadFile owns execution. */
export function filesUploadClient(client: UploadClient): UploadClient {
  return {
    async createUpload(input) {
      try {
        return await client.createUpload(input);
      } catch (error) {
        const failure = reviveRpcError(error, CREATE_UPLOAD_FAILURES);
        return failure === undefined || InvalidEnvelope.is(failure) ? StorageWriteUncertain({ cause: error }) : failure;
      }
    },
    async confirmUpload(input) {
      try {
        return await client.confirmUpload(input);
      } catch (error) {
        const failure = reviveRpcError(error, CONFIRM_UPLOAD_FAILURES);
        return failure === undefined || InvalidEnvelope.is(failure) ? StorageWriteUncertain({ cause: error }) : failure;
      }
    },
  };
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
    createUpload: implementer.createUpload.handler(({ input, context, errors }) =>
      answer(() => orThrowRpc(bind.storage(context).createUpload(bind.actor(context), input), errors)),
    ),
    confirmUpload: implementer.confirmUpload.handler(({ input, context, errors }) =>
      answer(async () =>
        toFileRecord(orThrowRpc(await bind.storage(context).confirmUpload(bind.actor(context), input.fileId), errors)),
      ),
    ),
    url: implementer.url.handler(({ input, context, errors }) =>
      answer(() =>
        orThrowRpc(
          bind.storage(context).url(bind.actor(context), input.fileId, { expiresIn: input.expiresIn }),
          errors,
        ),
      ),
    ),
    remove: implementer.remove.handler(({ input, context, errors }) =>
      answer(async () => {
        orThrowRpc(await bind.storage(context).remove(bind.actor(context), input.fileId), errors);
      }),
    ),
  };
}
