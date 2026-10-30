/** Canonical storage outcomes. Causes stay private; paths, keys and credentials never enter public data. */
import { defineFailure, SCHEMA_FAILURES, UnexpectedDefect } from '@arki/failure';

/** The requested local file does not exist.
 * @fix Correct the filename or create the file before reading it.
 * @verify bun run test -- src/local/read-first-line.test.ts
 */
export const StorageNotFound = defineFailure('fs.storage_not_found', {
  status: 404,
  message: 'The requested file does not exist.',
  remediation: 'Correct the filename or create the file before reading it.',
});

/** A read could not reach its storage backend.
 * @fix Restore connectivity or filesystem availability before choosing a new attempt.
 * @verify bun run test -- src/storage/outcomes.test.ts
 */
export const StorageUnavailable = defineFailure('fs.storage_unavailable', {
  status: 503,
  message: 'Storage is unavailable.',
  remediation: 'Restore storage availability before choosing a new attempt.',
});

/** Storage explicitly refused an operation without confirming a write.
 * @fix Correct permissions, the object key or the provider request.
 * @verify bun run test -- src/storage/outcomes.test.ts
 */
export const StorageRejected = defineFailure('fs.storage_rejected', {
  status: 403,
  message: 'Storage refused the operation.',
  remediation: 'Correct permissions, the object key or the provider request.',
});

/** An external write may have happened, but its final state was not confirmed.
 * @fix Reconcile the object or durable file row before retrying; cancellation does not undo a write.
 * @verify bun run test -- src/storage/outcomes.test.ts
 */
export const StorageWriteUncertain = defineFailure('fs.storage_write_uncertain', {
  status: 503,
  message: 'The storage write outcome is unconfirmed.',
  remediation: 'Reconcile the object or durable file row before retrying the write.',
});

/** Cancellation prevented the next phase or stopped a read; acknowledged earlier writes remain.
 * @fix Respect cancellation and reconcile earlier upload tickets or durable rows before another attempt.
 * @verify bun run test -- src/storage/outcomes.test.ts
 */
export const StorageCancelled = defineFailure('fs.storage_cancelled', {
  status: 499,
  message: 'The storage operation was cancelled.',
  remediation: 'Respect cancellation; reconcile earlier upload tickets or durable rows before another attempt.',
});

/** Read/signing operations perform no external write. */
export const STORAGE_READ_FAILURES = [
  StorageUnavailable,
  StorageRejected,
  StorageCancelled,
  ...SCHEMA_FAILURES,
  UnexpectedDefect,
] as const;
/** Dispatched writes preserve uncertainty instead of claiming that nothing happened. */
export const STORAGE_WRITE_FAILURES = [...STORAGE_READ_FAILURES, StorageWriteUncertain] as const;
export const FILE_READ_FAILURES = [
  StorageNotFound,
  StorageUnavailable,
  StorageRejected,
  StorageCancelled,
  UnexpectedDefect,
] as const;
