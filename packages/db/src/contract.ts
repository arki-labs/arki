/**
 * Everything an oRPC contract needs from the database layer, browser-safe:
 * the failures a transactional procedure returns (for the contract's error
 * map) and their result type. Importing it never loads drizzle-orm or a
 * Postgres driver. Ids come from `defineId` in `@arki/contracts`.
 */
export {
  TRANSACTION_FAILURES,
  TransactionCancelled,
  TransactionCommitUncertain,
  TransactionConflict,
  TransactionDefect,
  TransactionRejected,
  TransactionUnavailable,
} from './errors.js';
export type { TransactionFailure } from './errors.js';
export {
  MIGRATION_APPLY_FAILURES,
  MIGRATION_READ_FAILURES,
  MIGRATION_STATE_FAILURES,
  MigrationReadFailed,
  MigrationStateFailed,
  MigrationUnconfirmed,
} from './migrate-failures.js';
