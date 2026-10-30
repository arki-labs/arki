import { defineFailure, UnexpectedDefect } from '@arki/failure';

/**
 * Migration source files could not be read or decoded.
 * @fix Inspect the private cause and restore the generated migration directory before running again.
 * @verify bun run test -- src/migrate-outcomes.test.ts
 */
export const MigrationReadFailed = defineFailure('db.migration_read_failed', {
  status: 500,
  message: 'The migration source could not be read.',
  remediation: 'Inspect the private cause and restore the generated migration files.',
});

/**
 * The current migration bookkeeping state could not be read.
 * @fix Restore database access and inspect its bookkeeping before deciding what to apply.
 * @verify bun run test -- src/migrate-outcomes.test.ts
 */
export const MigrationStateFailed = defineFailure('db.migration_state_failed', {
  status: 503,
  message: 'The database migration state could not be read.',
  remediation: 'Restore database access and inspect the migration bookkeeping.',
});

/**
 * The native migrator did not confirm completion; schema or bookkeeping changes may exist.
 * @fix Reconcile the database schema and migration bookkeeping before explicitly running again. Do not retry blindly.
 * @verify bun run test -- src/migrate-outcomes.test.ts
 */
export const MigrationUnconfirmed = defineFailure('db.migration_unconfirmed', {
  status: 500,
  message: 'Database migration completion is unconfirmed.',
  remediation: 'Inspect the private cause, database schema and migration bookkeeping before explicitly running again.',
});

/** Exact declarations for each owned migration operation. */
export const MIGRATION_READ_FAILURES = [MigrationReadFailed] as const;
export const MIGRATION_STATE_FAILURES = [...MIGRATION_READ_FAILURES, MigrationStateFailed, UnexpectedDefect] as const;
export const MIGRATION_APPLY_FAILURES = [...MIGRATION_READ_FAILURES, MigrationUnconfirmed, UnexpectedDefect] as const;
