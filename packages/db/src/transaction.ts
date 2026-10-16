/**
 * `@arki/db/transaction` — run work in one SERIALIZABLE transaction, and run it
 * again when PostgreSQL says the transaction lost a race.
 *
 * Under SERIALIZABLE, PostgreSQL may abort a transaction with SQLSTATE `40001`
 * (serialization failure) or `40P01` (deadlock). Its documented answer is to run
 * the whole transaction again. `runTransaction` does exactly that, a bounded
 * number of times, with a short jittered wait between tries. Every other error
 * runs once and reaches the caller unchanged.
 *
 *   await runTransaction(db, async tx => moveMoney(tx, input), { retries: 3 });
 *
 * Portable: no driver, no oRPC. Jobs, scripts and journal effects use it
 * directly; `@arki/db/orpc` builds its middleware on it.
 */
import { is } from 'drizzle-orm';
import { PgAsyncTransaction } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import type { Clock } from '@arki/clock';
import { getLogger } from '@arki/log';
import { backoff, createRetryPolicy } from '@arki/resilience';

import type { TransactionalDb } from './composition.js';

export type { TransactionalDb } from './composition.js';

const log = getLogger('arki:db:transaction');

/** The SQLSTATEs PostgreSQL tells you to retry: serialization failure and deadlock. */
export type RetryableSqlState = '40001' | '40P01';

/** How far `retryableSqlState` follows `cause`. Same bound as the journal's unique-violation check. */
const MAX_CAUSE_DEPTH = 5;

/** The wait before retry n is about 10 ms × 2^(n-1), varied ±25%, never above 250 ms. */
const RETRY_BACKOFF = backoff.exponential({ base: 10, max: 250, jitter: 0.25 });

const transactionSettings = z.strictObject({
  /** The only level in v1. Serializable is what makes "run it again" safe. */
  isolation: z.literal('serializable').default('serializable'),
  /** Extra attempts after the first: `3` means at most 4 runs. */
  retries: z.int().min(0).max(10).default(3),
});

/** Declared once, as a schema. Everything else infers from it. */
export type TransactionSettings = z.input<typeof transactionSettings>;

/** What a transaction runs with once the defaults are filled in. */
export type ResolvedTransactionSettings = z.output<typeof transactionSettings>;

export type TransactionOptions = TransactionSettings & {
  /** Whose timer the wait between attempts uses. Default: the system clock. Pass a `MockClock` in tests. */
  readonly clock?: Clock;
  /** Stops before the next attempt and during the wait. An attempt already running finishes or fails on its own. */
  readonly signal?: AbortSignal;
};

export const DB_TRANSACTION_ERROR_CODES = {
  retriesExhausted: 'ARKI_DB_TX_E001',
  invalidOptions: 'ARKI_DB_TX_E002',
  nestedTransaction: 'ARKI_DB_TX_E003',
  invalidPipeline: 'ARKI_DB_TX_E004',
  unsupportedOutput: 'ARKI_DB_TX_E005',
  transactionAsRoot: 'ARKI_DB_TX_E006',
} as const;

export type DbTransactionErrorCode = (typeof DB_TRANSACTION_ERROR_CODES)[keyof typeof DB_TRANSACTION_ERROR_CODES];

/** An error of `@arki/db/transaction` or `@arki/db/orpc`. Same shape as `DbCompositionError`. */
export class DbTransactionError extends Error {
  readonly code: DbTransactionErrorCode;
  /** How to fix it. */
  readonly remediation: string;
  /** How many times the work ran. Set for `retriesExhausted`. */
  readonly attempts: number | undefined;
  /** The SQLSTATE of the last failure. Set for `retriesExhausted`. */
  readonly sqlState: RetryableSqlState | undefined;

  constructor(args: {
    readonly code: DbTransactionErrorCode;
    readonly message: string;
    readonly remediation: string;
    readonly attempts?: number;
    readonly sqlState?: RetryableSqlState;
    readonly cause?: unknown;
  }) {
    super(args.message, args.cause === undefined ? undefined : { cause: args.cause });
    this.name = 'DbTransactionError';
    this.code = args.code;
    this.remediation = args.remediation;
    this.attempts = args.attempts;
    this.sqlState = args.sqlState;
  }
}

/** True when `error` is a `DbTransactionError`, and has `code` when one is given. */
export function isDbTransactionError(error: unknown, code?: DbTransactionErrorCode): error is DbTransactionError {
  return error instanceof DbTransactionError && (code === undefined || error.code === code);
}

/**
 * The retryable SQLSTATE of `error`, or `undefined`.
 *
 * Walks `error`, then its `cause`, and stops at the FIRST object with a string
 * `code`: that code decides. So a Drizzle `DrizzleQueryError` (no code) defers
 * to the driver error inside it, while an `ORPCError('NOT_FOUND')` or an
 * `ECONNRESET` is final even when an older `40001` sits deeper. Messages are
 * never matched. A cycle, a deep chain, a throwing getter or an `AggregateError`
 * gives `undefined`: when unsure, do not retry.
 */
export function retryableSqlState(error: unknown): RetryableSqlState | undefined {
  const seen = new Set<object>();
  let node: unknown = error;
  try {
    for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
      if (typeof node !== 'object' || node === null || seen.has(node) || node instanceof AggregateError) return;
      seen.add(node);
      const code: unknown = 'code' in node ? node.code : undefined;
      if (typeof code === 'string') return code === '40001' || code === '40P01' ? code : undefined;
      node = 'cause' in node ? node.cause : undefined;
    }
  } catch {
    // A getter threw while we looked. Not a database answer we can trust.
  }
  return;
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
  if (!is(db, PgAsyncTransaction)) return;
  throw new DbTransactionError({
    code: DB_TRANSACTION_ERROR_CODES.transactionAsRoot,
    message:
      '[db] runTransaction was given a transaction, not a database. A nested transaction cannot set its isolation level.',
    remediation: 'Pass the root database (the pool), or call the work directly with the transaction you already have.',
  });
}

/**
 * Run `work` in one transaction at `isolation`. When it fails with `40001` or
 * `40P01`, run it again in a fresh transaction, up to `retries` more times.
 *
 * - `work` gets the transaction and the attempt number (1 for the first run).
 *   It runs again from the start, so it must not do anything a rerun repeats:
 *   no `fetch`, no queue writes (`db/no-effects-in-transaction` reports them).
 * - Waits only after Drizzle rolled back and released the connection.
 * - Out of retries: `DbTransactionError` `ARKI_DB_TX_E001`, with the last error as `cause`.
 * - Any other error, including a lost connection around `COMMIT`, runs once and
 *   reaches the caller unchanged: the commit may have happened.
 */
export async function runTransaction<Tx, T>(
  db: TransactionalDb<Tx>,
  work: (tx: Tx, attempt: number) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const { clock, signal, ...settings } = options;
  const { isolation, retries } = parseTransactionSettings(settings);
  assertTransactionRoot(db);

  const policy = createRetryPolicy({
    backoff: RETRY_BACKOFF.upTo(retries).while(error => retryableSqlState(error) !== undefined),
    clock,
  });
  const retried = policy.onRetry(event => {
    log.debug('transaction conflict, running it again: attempt {attempt}, SQLSTATE {sqlState}, wait {delay} ms', {
      attempt: event.attempt + 1,
      sqlState: 'error' in event ? retryableSqlState(event.error) : undefined,
      delay: event.delay,
    });
  });

  let attempts = 0;
  try {
    return await policy.execute(() => {
      signal?.throwIfAborted();
      attempts += 1;
      const attempt = attempts;
      return db.transaction(tx => work(tx, attempt), { isolationLevel: isolation });
    }, signal);
  } catch (error) {
    const sqlState = retryableSqlState(error);
    if (sqlState === undefined || attempts < retries + 1) throw error;
    throw new DbTransactionError({
      code: DB_TRANSACTION_ERROR_CODES.retriesExhausted,
      message: `[db] the transaction failed with SQLSTATE ${sqlState} on all ${String(attempts)} attempts.`,
      remediation:
        'Another transaction kept winning the race. Keep the transaction short, touch rows in a fixed order, or raise `retries` (at most 10).',
      attempts,
      sqlState,
      cause: error,
    });
  } finally {
    retried.dispose();
  }
}
