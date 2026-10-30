/**
 * `@arki/fs/files`: the portable half of the files table. Ids, wire schemas,
 * error codes, failures and the browser upload helper. Runs on Node, Bun, Deno,
 * browsers and Hermes.
 */
export { FILE_ERROR_CODES, FileStorageError, fileStorageError } from './errors.js';
export type { FileErrorCode } from './errors.js';
export {
  CREATE_UPLOAD_FAILURES,
  CONFIRM_UPLOAD_FAILURES,
  FILE_URL_FAILURES,
  REMOVE_FILE_FAILURES,
  UPLOAD_FILE_FAILURES,
  FileUnavailable,
  FileWrongState,
  UploadMismatch,
  UploadPending,
} from './failures.js';
export { fileRecord, fileStatus, mimeSchema, signedFileUrl, uploadRequest, uploadTicket } from './schemas.js';
export type { FileRecord, FileStatus, SignedFileUrl, UploadTicket } from './schemas.js';
export { fileId } from './types.js';
export type { FileId, UploadRequest } from './types.js';
export { uploadFile } from './upload-file.js';
export type { UploadClient, UploadFileOptions } from './upload-file.js';
export * from '../storage/failures.js';
