/** Private owned boundary shared by serializable retries and savepoint-capable openers. */

import { isFailure, UnexpectedFailure } from '@arki/failure';
import { getLogger } from '@arki/log';

import type { TransactionConfig, TransactionalDb } from './composition.js';
import type { TransactionFailure } from './errors.js';
import { dialectOf, isLibsql } from './dialect.js';
import {
  TRANSACTION_FAILURES,
  TransactionCancelled,
  TransactionCommitUncertain,
  TransactionConflict,
  TransactionDefect,
  TransactionRejected,
  TransactionUnavailable,
} from './errors.js';
import { findDatabaseError } from './sql-state.js';
import { DB_TRANSACTION_ERROR_CODES, DbTransactionError } from './transaction-errors.js';

const log = getLogger('arki:db:outcome');

/**
 * Refuse SQLite on a sync driver. It runs the callback, then commits when the
 * callback returns, not when its promise settles: after the first `await`, other
 * queries run inside the open transaction and a later throw cannot roll back
 * (docs/arki/research/17-multi-database/spike/results.md).
 */
/** @internal Reject static driver misuse before public policy supervision. */
export function assertSafeDriver(db: object): void {
  if (dialectOf(db) !== 'sqlite' || isLibsql(db)) return;
  throw new DbTransactionError({
    code: DB_TRANSACTION_ERROR_CODES.unsafeSqliteDriver,
    message:
      '[db] this SQLite driver commits when an async callback returns, so a throw after an await keeps its writes.',
    remediation: "Open the database with createLibsqlDb from '@arki/db/libsql', or db({ driver: 'libsql' }).",
  });
}

/** Connection codes emitted by the supported drivers' host networking stack. */
const CONNECTION_ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);

/** The wrapper distinguishes a returned business failure from an owned driver failure. */
export async function transactionAttempt<Tx, T>(
  db: TransactionalDb<Tx>,
  work: (tx: Tx) => Promise<T>,
  config?: TransactionConfig,
  signal?: AbortSignal,
): Promise<{ value: T | TransactionFailure } | { failure: TransactionFailure }> {
  assertSafeDriver(db);
  const rollback = new Error('Transaction callback returned a failure');
  let refused: { value: T | TransactionFailure } | undefined;
  let workCompleted = false;
  try {
    signal?.throwIfAborted();
    const value = await db.transaction(async tx => {
      let result: T | TransactionFailure;
      try {
        result = await work(tx);
      } catch (error) {
        const failure = bridgedTransactionFailure(error);
        if (failure === undefined) throw error;
        result = failure;
      }
      if (isFailure<unknown>(result)) {
        refused = { value: result };
        throw rollback;
      }
      signal?.throwIfAborted();
      workCompleted = true;
      return result;
    }, config);
    return { value };
  } catch (error) {
    if (error === rollback && refused !== undefined) {
      try {
        log.debug('transaction returned a failure and rolled back');
      } catch {
        // Observability cannot replace a confirmed rollback outcome.
      }
      return refused;
    }
    if (refused !== undefined) {
      return {
        failure: TransactionDefect({
          cause: new AggregateError([error, refused.value], 'Rollback failed after a returned failure'),
        }),
      };
    }
    if (error instanceof DbTransactionError) throw error;
    const failure = classifyTransactionFailure(error, workCompleted, signal);
    try {
      log.debug('transaction attempt ended with {code}', { code: failure.code });
    } catch {
      // Observability cannot replace the classified operation outcome.
    }
    return { failure };
  }
}

/** Drizzle's scalar callbacks throw; restore only our declared failure union. */
function bridgedTransactionFailure(error: unknown): TransactionFailure | undefined {
  if (error instanceof UnexpectedFailure) {
    for (const definition of TRANSACTION_FAILURES) {
      if (definition.is(error.failure)) return error.failure;
    }
  }
  return;
}

/** Preserve the caller's isolation/savepoint policy and execute exactly once. */
export async function runTransactionOnce<Tx, T>(db: TransactionalDb<Tx>, work: (tx: Tx) => Promise<T>) {
  const result = await transactionAttempt(db, work);
  return 'value' in result ? result.value : result.failure;
}

export function classifyTransactionFailure(
  cause: unknown,
  workCompleted: boolean,
  signal?: AbortSignal,
): TransactionFailure {
  const sqlState = findDatabaseError(cause)?.sqlState;
  if (sqlState === '40001' || sqlState === '40P01') return TransactionConflict({ attempts: 1, sqlState }, { cause });
  const connectionLost =
    sqlState !== undefined && (sqlState.startsWith('08') || ['57P01', '57P02', '57P03'].includes(sqlState));
  if (workCompleted && (sqlState === undefined || connectionLost)) return TransactionCommitUncertain({ cause });
  if (signal?.aborted === true || (cause instanceof Error && cause.name === 'AbortError'))
    return TransactionCancelled({ cause });
  if (connectionLost) return TransactionUnavailable({ cause });
  if (sqlState !== undefined) return TransactionRejected({ sqlState }, { cause });
  const driverCode = findDriverCode(cause);
  if (driverCode !== undefined && CONNECTION_ERROR_CODES.has(driverCode)) return TransactionUnavailable({ cause });
  return TransactionDefect({ cause });
}

/** A nearest driver code is evidence of an operational rejection, never of a safe retry. */
function findDriverCode(cause: unknown): string | undefined {
  const seen = new Set<object>();
  let node = cause;
  try {
    for (let depth = 0; depth < 5; depth += 1) {
      if (typeof node !== 'object' || node === null || seen.has(node) || node instanceof AggregateError) return;
      seen.add(node);
      if ('code' in node && typeof node.code === 'string') return node.code;
      node = 'cause' in node ? node.cause : undefined;
    }
  } catch {
    // A hostile getter is a defect, never evidence that a retry is safe.
  }
  return;
}
