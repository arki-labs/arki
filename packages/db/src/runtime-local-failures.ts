/** Canonical outcomes of opening and closing the embedded local database. */
import { ID_GENERATION_FAILURES, z } from '@arki/contracts';
import { defineFailure } from '@arki/failure';

/**
 * A live process already owns this data directory.
 * @fix Close its existing handle or choose another data directory.
 * @verify bun run test -- src/runtime-local.test.ts
 */
export const DataDirInUse = defineFailure('db.local_data_dir_in_use', {
  status: 409,
  data: z.object({ pid: z.int().positive() }),
  message: 'The local database directory is already owned by process {pid}.',
  remediation: 'Close the existing database handle or choose another data directory.',
});

/**
 * The owner lock kept changing throughout the bounded acquisition attempts.
 * @fix Wait for competing openers to finish before opening the directory again.
 * @verify bun run test -- src/owner-lock.test.ts
 */
export const OwnerLockContended = defineFailure('db.local_owner_lock_contended', {
  status: 503,
  message: 'The local database owner lock kept changing.',
  remediation: 'Wait for competing openers to finish before trying again.',
});

/**
 * The filesystem temporarily could not perform the local database operation.
 * @fix Restore filesystem capacity or availability before trying again.
 * @verify bun run test -- src/owner-lock.test.ts
 */
export const LocalRuntimeUnavailable = defineFailure('db.local_runtime_unavailable', {
  status: 503,
  message: 'The local database filesystem is unavailable.',
  remediation: 'Inspect the private cause and restore filesystem availability or capacity.',
});

/**
 * The filesystem rejected the selected local database path or operation.
 * @fix Choose a writable directory with the required filesystem permissions.
 * @verify bun run test -- src/owner-lock.test.ts
 */
export const LocalRuntimeRefused = defineFailure('db.local_runtime_refused', {
  status: 500,
  message: 'The filesystem refused the local database operation.',
  remediation: 'Inspect the private cause and choose a writable data directory.',
});

/**
 * Closing resources or releasing their owner lock could not be confirmed.
 * @fix Inspect the private causes; retain ownership until the handle is confirmed closed.
 * @verify bun run test -- src/runtime-local-cleanup.test.ts
 */
export const LocalRuntimeCleanupFailed = defineFailure('db.local_runtime_cleanup_failed', {
  status: 500,
  message: 'Local database cleanup is unconfirmed; resources or their owner lock may remain.',
  remediation: 'Inspect the private causes; do not reopen the directory until cleanup is confirmed.',
});

/** Exact owner acquisition failures; entropy failures keep their original identity. */
export const OWNER_LOCK_FAILURES = [
  DataDirInUse,
  OwnerLockContended,
  LocalRuntimeUnavailable,
  LocalRuntimeRefused,
  LocalRuntimeCleanupFailed,
  ...ID_GENERATION_FAILURES,
] as const;
export type OwnerLockFailure = ReturnType<(typeof OWNER_LOCK_FAILURES)[number]>;

/** The owned close operation reports cleanup uncertainty explicitly. */
export const LOCAL_RUNTIME_CLOSE_FAILURES = [LocalRuntimeCleanupFailed] as const;
export type LocalRuntimeCloseFailure = ReturnType<(typeof LOCAL_RUNTIME_CLOSE_FAILURES)[number]>;

/** One source for the public local runtime's exact failure union. */
export const LOCAL_RUNTIME_FAILURES = OWNER_LOCK_FAILURES;
export type LocalRuntimeFailure = ReturnType<(typeof LOCAL_RUNTIME_FAILURES)[number]>;
