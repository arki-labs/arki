import { z } from 'zod';

import { ID_GENERATION_FAILURES } from '@arki/contracts';
import { defineFailure } from '@arki/failure';

/**
 * Questions about a Postgres error, answered the same way for every driver
 * (node-postgres, PGlite, Bun SQL) and through Drizzle's `DrizzleQueryError`.
 */
import { findDatabaseError } from './sql-state.js';

export type { DatabaseErrorFacts } from './sql-state.js';
/** The SQL-standard SQLSTATE (and constraint, on Postgres) of a database error, on either dialect. */
export { findDatabaseError } from './sql-state.js';

/** SQLSTATE `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/**
 * True when the database refused a write because a unique index already holds
 * the value: the "insert, and answer CONFLICT on a duplicate" check. Pass
 * `constraint` to match one named index only.
 *
 * @example
 * try {
 *   await db.insert(Source).values(row);
 * } catch (error) {
 *   if (isUniqueViolation(error, 'idx_sources_user_sender')) throw new ORPCError('CONFLICT');
 *   throw error;
 * }
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const facts = findDatabaseError(error);
  if (facts?.sqlState !== UNIQUE_VIOLATION) return false;
  return constraint === undefined || facts.constraint === constraint;
}

/**
 * PostgreSQL aborted every allowed attempt with a serialization conflict or deadlock.
 * @fix Shorten transactions or retry the operation later.
 * @verify bun run test -- src/transaction.pg.test.ts
 */
export const TransactionConflict = defineFailure('db.transaction_conflict', {
  status: 409,
  data: z.object({ attempts: z.int().positive(), sqlState: z.enum(['40001', '40P01']) }),
  message: 'The transaction exhausted its conflict retries.',
  remediation: 'Retry later; keep transactions short and acquire rows in a consistent order.',
});

/**
 * The driver could not execute the transaction because its connection failed.
 * @fix Inspect the private cause and restore database connectivity.
 * @verify bun run test -- src/transaction.test.ts
 */
export const TransactionUnavailable = defineFailure('db.transaction_unavailable', {
  status: 503,
  message: 'The database could not execute the transaction.',
  remediation: 'Inspect the private cause before deciding whether this operation may be retried.',
});

/**
 * PostgreSQL explicitly rejected a statement or COMMIT, including constraint violations.
 * @fix Correct the write using the SQLSTATE; this does not imply a transient outage.
 * @verify bun run test -- src/transaction.pg.test.ts
 */
export const TransactionRejected = defineFailure('db.transaction_rejected', {
  status: 500,
  data: z.object({ sqlState: z.string() }),
  message: 'The database rejected the transaction.',
  remediation: 'Inspect the SQLSTATE and correct the operation before retrying.',
});

/**
 * Work completed but the driver did not confirm COMMIT; writes may already be durable.
 * @fix Reconcile using an idempotency key or durable receipt; never blindly repeat the write.
 * @verify bun run test -- src/transaction.pg.test.ts
 */
export const TransactionCommitUncertain = defineFailure('db.transaction_commit_uncertain', {
  status: 503,
  message: 'The database did not confirm whether the transaction committed.',
  remediation: 'Reconcile the operation using its idempotency key or durable receipt.',
});

/**
 * Cancellation stopped work before COMMIT or while waiting for another attempt.
 * @fix Respect the caller cancellation; start a new operation only under a new policy.
 * @verify bun run test -- src/transaction.test.ts
 */
export const TransactionCancelled = defineFailure('db.transaction_cancelled', {
  status: 499,
  message: 'The transaction was cancelled.',
  remediation: 'Respect cancellation; do not automatically restart this operation.',
});

/**
 * Transaction work or its driver threw an unclassified defect.
 * @fix Inspect the private cause and fix the failing implementation.
 * @verify bun run test -- src/transaction.test.ts
 */
export const TransactionDefect = defineFailure('db.transaction_defect', {
  status: 500,
  message: 'The transaction could not complete.',
  remediation: 'Inspect the private cause and fix the operation.',
});

/**
 * A stored value cannot be read as the column's type: Postgres `infinity`, a BC date, malformed text, or
 * SQLite milliseconds that are NaN or out of range. Drizzle's `fromDriver` cannot return a failure, so the
 * column codecs throw this as an `UnexpectedFailure` (`error.failure` is this value); the raw `RangeError` is its `cause`.
 * @fix Repair or remove the stored value, or read the column as text and handle the special value yourself.
 * @verify bun run test -- src/temporal.test.ts
 */
export const StoredValueUnreadable = defineFailure('db.stored_value_unreadable', {
  status: 500,
  data: z.object({ kind: z.enum(['date', 'timestamp', 'sqlite_instant']) }),
  message: 'A stored {kind} value cannot be read.',
  remediation: 'Repair or remove the stored value; infinity, BC dates and malformed text are not supported.',
});

/** One source for transaction failures, native contract maps and exact result unions. */
export const TRANSACTION_FAILURES = [
  TransactionConflict,
  TransactionUnavailable,
  TransactionRejected,
  TransactionCommitUncertain,
  TransactionCancelled,
  TransactionDefect,
  ...ID_GENERATION_FAILURES,
] as const;

export type TransactionFailure = ReturnType<(typeof TRANSACTION_FAILURES)[number]>;
