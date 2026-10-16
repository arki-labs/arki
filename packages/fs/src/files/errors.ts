/**
 * Every failure the files table raises on purpose is a {@link FileStorageError}
 * with a stable `code`. Match on the code, never on the message.
 */

/** Stable error codes of `@arki/fs/files` and `@arki/fs/pg`. */
export const FILE_ERROR_CODES = {
  /** Bad input or config: TTL over the cap, size over the limit, mime not allowed. */
  invalid: 'ARKI_FS_E001',
  /** Missing, not yours, or another bucket binding. One code on purpose, so callers cannot probe for existence. */
  unavailable: 'ARKI_FS_E002',
  /** Not pending, not ready, or the confirm window passed. */
  wrongState: 'ARKI_FS_E003',
  /** Confirm came before the PUT finished. The row stays pending; a retry is fine. */
  objectMissing: 'ARKI_FS_E004',
  /** The stored size, type or hash differs from the row. */
  mismatch: 'ARKI_FS_E005',
  /** The adapter cannot sign uploads (the local adapter). */
  unsupported: 'ARKI_FS_E006',
  /** The object store failed. */
  storage: 'ARKI_FS_E007',
} as const;

/** The code of a {@link FileStorageError}. */
export type FileErrorCode = (typeof FILE_ERROR_CODES)[keyof typeof FILE_ERROR_CODES];

/** Codes where the same call may succeed later without any change. */
const RETRYABLE: ReadonlySet<FileErrorCode> = new Set([FILE_ERROR_CODES.objectMissing, FILE_ERROR_CODES.storage]);

/** A coded failure of the files table or one of its adapters. */
export class FileStorageError extends Error {
  readonly code: FileErrorCode;
  /** True when retrying the same call later can succeed (the PUT is still running, the store hiccuped). */
  readonly retryable: boolean;

  constructor(code: FileErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FileStorageError';
    this.code = code;
    this.retryable = RETRYABLE.has(code);
  }
}

/** True when `value` is a {@link FileStorageError}. */
export function isFileStorageError(value: unknown): value is FileStorageError {
  return value instanceof FileStorageError;
}
