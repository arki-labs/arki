/**
 * `@arki/db/transaction` — run work in one SERIALIZABLE transaction, and run it
 * again when PostgreSQL says the transaction lost a race.
 *
 * Under SERIALIZABLE, PostgreSQL may abort a transaction with SQLSTATE `40001`
 * (serialization failure) or `40P01` (deadlock). Its documented answer is to run
 * the whole transaction again. `runTransaction` does exactly that, a bounded
 * number of times, with a short jittered wait between tries. Other failures run once and become typed transaction outcomes.
 *
 *   await runTransaction(db, async tx => moveMoney(tx, input), { retries: 3 });
 *
 * Portable: no driver, no oRPC. Jobs, scripts and journal effects use it
 * directly; `@arki/db/orpc` builds its middleware on it.
 */
import { z } from 'zod';

import type { Clock } from '@arki/clock';
import { SleepCancelled } from '@arki/clock';
import { UnexpectedDefect } from '@arki/failure';
import { getLogger } from '@arki/log';
import { backoff, Cancelled as RetryCancelled, createRetryPolicy } from '@arki/resilience';

import type { TransactionConfig, TransactionalDb } from './composition.js';
import type { TransactionFailure } from './errors.js';
import { isTransaction } from './dialect.js';
import { TransactionCancelled, TransactionConflict, TransactionDefect } from './errors.js';
import { assertSafeDriver, classifyTransactionFailure, transactionAttempt } from './owned-transaction.js';
import { findDatabaseError } from './sql-state.js';
import { DB_TRANSACTION_ERROR_CODES, DbTransactionError } from './transaction-errors.js';
import { transactionSettings } from './transaction-settings.js';

export type { TransactionalDb } from './composition.js';

const log = getLogger('arki:db:transaction');

/** The SQLSTATEs PostgreSQL tells you to retry: serialization failure and deadlock. */
export type RetryableSqlState = ReturnType<typeof TransactionConflict>['data']['sqlState'];

export {
  TransactionConflict,
  TransactionUnavailable,
  TransactionRejected,
  TransactionCommitUncertain,
  TransactionCancelled,
  TransactionDefect,
  TRANSACTION_FAILURES,
} from './errors.js';
export { runTransactionOnce } from './owned-transaction.js';
export type { TransactionFailure } from './errors.js';

/** The wait before retry n is about 10 ms × 2^(n-1), varied ±25%, never above 250 ms. */
const RETRY_BACKOFF = backoff.exponential({ base: 10, max: 250, jitter: 0.25 });

/** What a caller may set. An exact type test locks `transactionSettings` to this type. */
export type TransactionSettings = {
  /** The only level in v1. Serializable is what makes "run it again" safe. */
  isolation?: 'serializable' | undefined;
  /** Extra attempts after the first: `3` means at most 4 runs. */
  retries?: number | undefined;
};

/** What a transaction runs with once the defaults are filled in. */
export type ResolvedTransactionSettings = { isolation: 'serializable'; retries: number };

export type TransactionOptions = TransactionSettings & {
  /** Whose timer the wait between attempts uses. Default: the system clock. Pass a `MockClock` in tests. */
  readonly clock?: Clock;
  /** Stops before the next attempt and during the wait. An attempt already running finishes or fails on its own. */
  readonly signal?: AbortSignal;
};

export { DB_TRANSACTION_ERROR_CODES, DbTransactionError, isDbTransactionError } from './transaction-errors.js';
export type { DbTransactionErrorCode } from './transaction-errors.js';

/**
 * The retryable SQLSTATE of `error`, or `undefined`.
 *
 * Reads the database error the way every driver reports it: through Drizzle's
 * `DrizzleQueryError`, in `code` (node-postgres, PGlite) or in `errno` (Bun SQL).
 * The first error in the `cause` chain that has a `code` decides, so an
 * `ORPCError('NOT_FOUND')` or an `ECONNRESET` is final even when an older `40001`
 * sits deeper. When unsure, do not retry.
 */
export function retryableSqlState(error: unknown): RetryableSqlState | undefined {
  const sqlState = findDatabaseError(error)?.sqlState;
  return sqlState === '40001' || sqlState === '40P01' ? sqlState : undefined;
}

/** Parse `{ isolation, retries }`. Bad values throw `ARKI_DB_TX_E002`; nothing is clamped. */
export function parseTransactionSettings(settings: TransactionSettings): ResolvedTransactionSettings {
  const parsed = transactionSettings.safeParse(settings);
  if (parsed.success) return parsed.data;
  throw new DbTransactionError({
    code: DB_TRANSACTION_ERROR_CODES.invalidOptions,
    message: `[db] invalid transaction options: ${z.prettifyError(parsed.error)}`,
    remediation: "Use isolation 'serializable' (the only level) and retries as a whole number from 0 to 10.",
  });
}

/**
 * Refuse a transaction as the root. A nested `tx.transaction()` is a savepoint:
 * it takes no isolation level, so the work would silently run at the outer level.
 */
function assertTransactionRoot(db: object): void {
  if (!isTransaction(db)) return;
  throw new DbTransactionError({
    code: DB_TRANSACTION_ERROR_CODES.transactionAsRoot,
    message:
      '[db] runTransaction was given a transaction, not a database. A nested transaction cannot set its isolation level.',
    remediation: 'Pass the root database (the pool), or call the work directly with the transaction you already have.',
  });
}

/**
 * Run rollback-safe work at SERIALIZABLE isolation. Returning a Failure rolls
 * back and restores that exact value. Ordinary values commit unchanged.
 * Only SQLSTATE 40001/40P01 retries; COMMIT acknowledgement loss never does.
 * External effects must remain outside the callback because an attempt may rerun.
 * Static configuration misuse still throws DbTransactionError.
 */
export async function runTransaction<Tx, T>(
  db: TransactionalDb<Tx>,
  work: (tx: Tx, attempt: number) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T | TransactionFailure> {
  const { clock, signal, ...settings } = options;
  const { isolation, retries } = parseTransactionSettings(settings);
  assertTransactionRoot(db);
  assertSafeDriver(db);

  let attempts = 0;
  const policy = createRetryPolicy({
    backoff: RETRY_BACKOFF.upTo(retries).while(error => retryableSqlState(error) !== undefined),
    clock,
    onThrow(error) {
      const sqlState = retryableSqlState(error);
      if (sqlState !== undefined) return { value: TransactionConflict({ attempts, sqlState }, { cause: error }) };
      throw error;
    },
  });
  const retried = policy.onRetry(event => {
    try {
      log.debug('transaction conflict, running it again: attempt {attempt}, SQLSTATE {sqlState}, wait {delay} ms', {
        attempt: event.attempt + 1,
        sqlState: 'error' in event ? retryableSqlState(event.error) : undefined,
        delay: event.delay,
      });
    } catch {
      // A broken context/trace source must not change the retry policy.
    }
  });

  // Postgres reads the isolation level. SQLite has one writer, so it is serializable anyway;
  // it reads `behavior`, and `immediate` takes the write lock up front.
  const config: TransactionConfig = { isolationLevel: isolation, behavior: 'immediate' };
  try {
    const outcome = await policy.execute(async () => {
      signal?.throwIfAborted();
      attempts += 1;
      const result = await transactionAttempt(db, tx => work(tx, attempts), config, signal);
      if ('value' in result) return result;
      if (TransactionConflict.is(result.failure)) throw result.failure.cause;
      return { value: result.failure };
    }, signal);
    if (SleepCancelled.is(outcome) || RetryCancelled.is(outcome)) return TransactionCancelled({ cause: outcome });
    if (UnexpectedDefect.is(outcome)) return TransactionDefect({ cause: outcome });
    return outcome.value;
  } catch (error) {
    if (error instanceof DbTransactionError) throw error;
    if (signal?.aborted === true) return TransactionCancelled({ cause: error });
    const sqlState = retryableSqlState(error);
    if (sqlState !== undefined) return TransactionConflict({ attempts, sqlState }, { cause: error });
    return classifyTransactionFailure(error, false, signal);
  } finally {
    retried.dispose();
  }
}
