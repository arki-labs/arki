/**
 * `@arki/fs/files`: the portable half of the files table. Ids, wire schemas,
 * error codes, failures and the browser upload helper. Runs on Node, Bun, Deno,
 * browsers and Hermes.
 */
export { FILE_ERROR_CODES, FileStorageError, isFileStorageError } from './errors.js';
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
export { fileId, fileRecord, fileStatus, mimeSchema, signedFileUrl, uploadRequest, uploadTicket } from './schemas.js';
export type { FileId, FileRecord, FileStatus, SignedFileUrl, UploadRequest, UploadTicket } from './schemas.js';
export { uploadFile } from './upload-file.js';
export type { UploadClient, UploadFileOptions } from './upload-file.js';
export * from '../storage/failures.js';
