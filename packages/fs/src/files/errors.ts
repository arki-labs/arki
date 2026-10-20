/**
 * Every fault the files table throws on purpose is a {@link FileStorageError}
 * with a stable `code`. Match on the code, never on the message. Expected
 * outcomes (a missing file, an unfinished upload) are returned instead: see
 * `failures.ts`.
 */

/** Stable error codes of `@arki/fs/files` and `@arki/fs/pg`. E002–E005 are retired: those outcomes are returned failures now. */
export const FILE_ERROR_CODES = {
  /** Bad input or config: TTL over the cap, size over the limit, mime not allowed.
   * @fix Correct the requested TTL, file size, MIME type or storage configuration to match the configured limits.
   * @verify bun run test -- src/files/files.test.ts
   */
  invalid: 'ARKI_FS_E001',
  /** The adapter cannot sign uploads (the local adapter).
   * @fix Use an adapter supporting signed uploads, or upload through the local adapter supported path.
   * @verify bun run test -- src/files/files.test.ts
   */
  unsupported: 'ARKI_FS_E006',
  /** The object store failed.
   * @fix Inspect the private object-store error and restore storage connectivity or credentials before retrying.
   * @verify bun run test -- src/files/files.test.ts
   */
  storage: 'ARKI_FS_E007',
} as const;

/** The code of a {@link FileStorageError}. */
export type FileErrorCode = (typeof FILE_ERROR_CODES)[keyof typeof FILE_ERROR_CODES];

/** Codes where the same call may succeed later without any change. */
const RETRYABLE: ReadonlySet<FileErrorCode> = new Set([FILE_ERROR_CODES.storage]);

/** A coded failure of the files table or one of its adapters. */
export class FileStorageError extends Error {
  readonly code: FileErrorCode;
  /** True when retrying the same call later can succeed (the store hiccuped). */
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
