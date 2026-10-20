/**
 * `runTransaction` and `retryableSqlState` against a scripted database.
 *
 * Why these tests exist: a retry is only safe for the two SQLSTATEs PostgreSQL
 * says mean "run the whole transaction again". Retrying anything else repeats
 * work that may have committed (a lost connection at COMMIT) or that the app
 * refused on purpose (an ORPCError). So the classifier must be exact, the loop
 * bounded, and bad config refused before any database call.
 */
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import { PGlite } from '@electric-sql/pglite';
import { ORPCError } from '@orpc/server';
import { DrizzleQueryError } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { describe, expect, it, vi } from 'vitest';

import { MockClock } from '@arki/clock';
import { defineFailure, isFailure } from '@arki/failure';
import { configure, memorySink } from '@arki/log';
import { fakeLog } from '@arki/log/testing';

import type { TransactionalDb } from './transaction.js';
import {
  DB_TRANSACTION_ERROR_CODES,
  DbTransactionError,
  retryableSqlState,
  runTransaction,
  runTransactionOnce,
  TransactionCancelled,
  TransactionCommitUncertain,
  TransactionConflict,
  TransactionDefect,
  TransactionUnavailable,
} from './transaction.js';

type FakeTx = { readonly attempt: number };

const sqlError = (code: string): Error => Object.assign(new Error(`sqlstate ${code}`), { code });

/** A database whose n-th transaction runs the work, then throws `failures[n]` when one is given. */
function scriptedDb(failures: readonly unknown[] = []) {
  const configs: (PgTransactionConfig | undefined)[] = [];
  const db: TransactionalDb<FakeTx> = {
    async transaction(fn, config) {
      configs.push(config);
      const index = configs.length - 1;
      const result = await fn({ attempt: index + 1 });
      if (index < failures.length) throw failures[index];
      return result;
    },
  };
  return { db, configs };
}

/** Run with a mock clock and let every backoff wait pass. */
async function settle<T>(clock: MockClock, run: Promise<T>): Promise<T> {
  const outcome = run.then(
    value => ({ value }),
    (error: unknown) => ({ error }),
  );
  await clock.advanceAsync(10_000);
  const result = await outcome;
  if ('error' in result) throw result.error;
  return result.value;
}

const caught = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    value => value,
    (error: unknown) => error,
  );

describe('runTransaction: settings', () => {
  it('defaults to serializable and 3 retries (at most 4 runs)', async () => {
    const clock = new MockClock();
    const { db, configs } = scriptedDb(Array.from({ length: 10 }, () => sqlError('40001')));
    const error = await caught(
      settle(
        clock,
        runTransaction(db, () => Promise.resolve('never'), { clock }),
      ),
    );
    expect(configs).toHaveLength(4);
    expect(configs[0]).toEqual({ isolationLevel: 'serializable' });
    expect(error).toMatchObject({ code: TransactionConflict.code, data: { attempts: 4 } });
  });

  it('retries: 0 runs once', async () => {
    const { db, configs } = scriptedDb([sqlError('40001')]);
    const error = await caught(runTransaction(db, () => Promise.resolve('x'), { retries: 0 }));
    expect(configs).toHaveLength(1);
    expect(TransactionConflict.is(error)).toBe(true);
  });

  it.each([11, -1, 1.5])('refuses retries %s before any database call: fail loud, never clamp', async retries => {
    const { db, configs } = scriptedDb();
    const error = await caught(runTransaction(db, () => Promise.resolve('x'), { retries }));
    expect(error).toMatchObject({ code: DB_TRANSACTION_ERROR_CODES.invalidOptions });
    expect(configs).toHaveLength(0);
  });

  it('refuses an isolation level other than serializable, and unknown keys from untyped callers', async () => {
    const { db, configs } = scriptedDb();
    // @ts-expect-error -- only 'serializable' type-checks; an untyped caller is still refused at runtime
    const otherLevel = runTransaction(db, () => Promise.resolve('x'), { isolation: 'repeatable read' });
    await expect(otherLevel).rejects.toMatchObject({ code: DB_TRANSACTION_ERROR_CODES.invalidOptions });
    // @ts-expect-error -- a misspelt key is refused, not ignored
    await expect(runTransaction(db, () => Promise.resolve('x'), { retry: 3 })).rejects.toMatchObject({
      code: DB_TRANSACTION_ERROR_CODES.invalidOptions,
    });
    expect(configs).toHaveLength(0);
  });
});

describe('runTransaction: what is retried', () => {
  it('40001 then success: returns the result, logs one debug retry, work sees attempt 1 then 2', async () => {
    using fake = fakeLog();
    const clock = new MockClock();
    const { db } = scriptedDb([sqlError('40001')]);
    const seen: number[] = [];
    const result = await settle(
      clock,
      runTransaction(
        db,
        (tx, attempt) => {
          seen.push(attempt);
          expect(tx.attempt).toBe(attempt);
          return Promise.resolve('done');
        },
        { clock },
      ),
    );
    expect(result).toBe('done');
    expect(seen).toEqual([1, 2]);
    const retries = fake.records.filter(r => r.category === 'arki:db:transaction' && r.levelName === 'debug');
    expect(retries).toHaveLength(1);
    expect(retries[0]?.fields).toMatchObject({ attempt: 2, sqlState: '40001' });
  });

  it('a Bun SQL 40001 is retried: Bun puts the SQLSTATE in errno, and its own name in code', async () => {
    const clock = new MockClock();
    const bunError = Object.assign(new Error('could not serialize access'), {
      code: 'ERR_POSTGRES_SERVER_ERROR',
      errno: '40001',
    });
    const { db, configs } = scriptedDb([new DrizzleQueryError('update accounts', [], bunError)]);
    expect(
      await settle(
        clock,
        runTransaction(db, () => Promise.resolve('ok'), { clock }),
      ),
    ).toBe('ok');
    expect(configs).toHaveLength(2);
  });

  it('a Drizzle query error wrapping a 40P01 deadlock is retried: the driver error inside decides', async () => {
    const clock = new MockClock();
    const wrapped = new DrizzleQueryError('update accounts', [], sqlError('40P01'));
    const { db, configs } = scriptedDb([wrapped]);
    expect(
      await settle(
        clock,
        runTransaction(db, () => Promise.resolve('ok'), { clock }),
      ),
    ).toBe('ok');
    expect(configs).toHaveLength(2);
  });

  it.each([
    ['ORPCError FORBIDDEN', new ORPCError('FORBIDDEN')],
    ['ORPCError with a 40001 cause (the app decided)', new ORPCError('CONFLICT', { cause: sqlError('40001') })],
    ['plain Error wrapping an ORPCError', new Error('wrapped', { cause: new ORPCError('NOT_FOUND') })],
    ['23505 unique violation', sqlError('23505')],
    ['23P01 exclusion violation', sqlError('23P01')],
    ['25P02 aborted transaction', sqlError('25P02')],
    ['ECONNRESET (commit outcome unknown)', sqlError('ECONNRESET')],
    [
      'ECONNRESET wrapping an older 40001',
      Object.assign(new Error('reset', { cause: sqlError('40001') }), { code: 'ECONNRESET' }),
    ],
    ['a timeout', Object.assign(new Error('timeout'), { name: 'TimeoutError' })],
  ])('%s runs once and preserves its cause in a typed outcome', async (_name, failure) => {
    const { db, configs } = scriptedDb([failure]);
    expect(await runTransaction(db, () => Promise.resolve('x'))).toMatchObject({ cause: failure });
    expect(configs).toHaveLength(1);
  });

  it('exhaustion: ARKI_DB_TX_E001 with attempts and the last error as cause; no wait after the last failure', async () => {
    const clock = new MockClock();
    const sleep = vi.spyOn(clock, 'sleep');
    const failures = [sqlError('40001'), sqlError('40P01'), sqlError('40001'), sqlError('40P01')];
    const { db } = scriptedDb(failures);
    const error = await caught(
      settle(
        clock,
        runTransaction(db, () => Promise.resolve('x'), { clock, retries: 3 }),
      ),
    );
    expect(isFailure(error)).toBe(true);
    expect(error).toMatchObject({
      code: TransactionConflict.code,
      data: { attempts: 4, sqlState: '40P01' },
      cause: failures[3],
    });
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('a nested exhaustion is final for an outer runTransaction: its code is not a SQLSTATE', () => {
    const inner = new DbTransactionError({
      code: 'ARKI_DB_TX_E001',
      message: 'x',
      remediation: 'y',
      cause: sqlError('40001'),
    });
    expect(retryableSqlState(inner)).toBeUndefined();
  });
});

describe('runTransaction: abort', () => {
  it('an aborted signal stops before the first attempt', async () => {
    const { db, configs } = scriptedDb();
    const controller = new AbortController();
    controller.abort(new Error('client left'));
    await expect(runTransaction(db, () => Promise.resolve('x'), { signal: controller.signal })).resolves.toMatchObject({
      code: TransactionCancelled.code,
      cause: controller.signal.reason,
    });
    expect(configs).toHaveLength(0);
  });

  it('an abort during the wait stops: no further attempt', async () => {
    const clock = new MockClock();
    const controller = new AbortController();
    const { db, configs } = scriptedDb([sqlError('40001')]);
    const sleep = vi.spyOn(clock, 'sleep');
    const run = caught(runTransaction(db, () => Promise.resolve('x'), { clock, signal: controller.signal }));
    await vi.waitFor(() => {
      expect(sleep).toHaveBeenCalledTimes(1);
    });
    controller.abort();
    expect(TransactionCancelled.is(await run)).toBe(true);
    expect(configs).toHaveLength(1);
  });
});

describe('runTransaction: root', () => {
  it('refuses a transaction as root (ARKI_DB_TX_E006): a nested transaction cannot set its isolation', async () => {
    const client = new PGlite();
    const db = drizzle({ client });
    try {
      const error = await db.transaction(tx => caught(runTransaction(tx, () => Promise.resolve('x'))));
      expect(error).toMatchObject({ code: DB_TRANSACTION_ERROR_CODES.transactionAsRoot });
    } finally {
      await client.close();
    }
  });
});

describe('retryableSqlState: the nearest code decides', () => {
  it('returns the code only for 40001 and 40P01', () => {
    expect(retryableSqlState(sqlError('40001'))).toBe('40001');
    expect(retryableSqlState(sqlError('40P01'))).toBe('40P01');
    expect(retryableSqlState(sqlError('40000'))).toBeUndefined();
    expect(retryableSqlState({ code: 40_001 })).toBeUndefined();
    expect(retryableSqlState('40001')).toBeUndefined();
  });

  it('gives up on a cycle, a deep chain, a throwing getter and an AggregateError: when unsure, do not retry', () => {
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(retryableSqlState(cyclic)).toBeUndefined();

    let deep: unknown = sqlError('40001');
    for (let level = 0; level < 6; level += 1) deep = new Error(`level ${String(level)}`, { cause: deep });
    expect(retryableSqlState(deep)).toBeUndefined();

    const getter = Object.defineProperty(new Error('getter'), 'cause', {
      get() {
        throw new Error('boom');
      },
    });
    expect(retryableSqlState(getter)).toBeUndefined();

    expect(retryableSqlState(new AggregateError([sqlError('40001')], 'many'))).toBeUndefined();
  });

  it('follows a short chain without codes down to the driver error', () => {
    const chain = new Error('outer', { cause: new Error('middle', { cause: sqlError('40001') }) });
    expect(retryableSqlState(chain)).toBe('40001');
  });
});

const Refused = defineFailure('test.transaction_refused');

describe('failure-aware transaction boundaries', () => {
  it('a returned conflict failure is restored by identity and never retried', async () => {
    const { db, configs } = scriptedDb();
    const failure = TransactionConflict({ attempts: 1, sqlState: '40001' });
    expect(await runTransaction(db, () => Promise.resolve(failure))).toBe(failure);
    expect(configs).toHaveLength(1);
  });

  it('a callback defect is owned and a foreign lookalike carrier cannot become a business failure', async () => {
    const { db } = scriptedDb();
    const cause = new Error('Transaction callback returned a failure');
    const result = await runTransaction(db, () => Promise.reject(cause));
    expect(TransactionDefect.is(result)).toBe(true);
    expect(result).toMatchObject({ cause });
  });

  it('a failed rollback replaces the original refusal with an owned defect', async () => {
    const cause = new Error('rollback failed');
    const db: TransactionalDb<FakeTx> = {
      async transaction(fn) {
        try {
          return await fn({ attempt: 1 });
        } catch {
          throw cause;
        }
      },
    };
    const failure = Refused();
    const result = await runTransaction(db, () => Promise.resolve(failure));
    expect(TransactionDefect.is(result)).toBe(true);
    expect(result).toMatchObject({ cause: { errors: [cause, failure] } });
    expect(result).not.toBe(failure);
  });

  it('cancellation after work returns rolls back before COMMIT', async () => {
    const controller = new AbortController();
    let committed = false;
    const db: TransactionalDb<FakeTx> = {
      async transaction(fn) {
        const value = await fn({ attempt: 1 });
        committed = true;
        return value;
      },
    };
    const result = await runTransaction(
      db,
      () => {
        controller.abort();
        return Promise.resolve('done');
      },
      { signal: controller.signal },
    );
    expect(TransactionCancelled.is(result)).toBe(true);
    expect(committed).toBe(false);
  });

  it('a cancellation received while COMMIT acknowledgement is lost remains uncertain', async () => {
    const controller = new AbortController();
    const db: TransactionalDb<FakeTx> = {
      async transaction(fn) {
        await fn({ attempt: 1 });
        controller.abort();
        throw controller.signal.reason;
      },
    };
    expect(
      TransactionCommitUncertain.is(
        await runTransaction(db, () => Promise.resolve('done'), { signal: controller.signal }),
      ),
    ).toBe(true);
  });

  it('runTransactionOnce keeps the driver policy and does not retry a conflict', async () => {
    const { db, configs } = scriptedDb([sqlError('40001')]);
    expect(TransactionConflict.is(await runTransactionOnce(db, () => Promise.resolve('done')))).toBe(true);
    expect(configs).toEqual([undefined]);
  });
});

it.each(['08006', '08003', '57P01', '57P02', '57P03'])(
  'SQLSTATE %s after work is uncertain and never retried',
  async code => {
    const { db, configs } = scriptedDb([sqlError(code)]);
    const result = await runTransaction(db, () => Promise.resolve('done'));
    expect(TransactionCommitUncertain.is(result)).toBe(true);
    expect(configs).toHaveLength(1);
  },
);

it('a failed rollback with 40001 does not replay a returned business failure', async () => {
  let runs = 0;
  const cause = sqlError('40001');
  const failure = Refused();
  const db: TransactionalDb<FakeTx> = {
    async transaction(fn) {
      try {
        return await fn({ attempt: 1 });
      } catch {
        throw cause;
      }
    },
  };
  const result = await runTransaction(db, () => {
    runs += 1;
    return Promise.resolve(failure);
  });
  expect(TransactionDefect.is(result)).toBe(true);
  expect(result).toMatchObject({ cause: { errors: [cause, failure] } });
  expect(runs).toBe(1);
});

it.each(['40001', '40P01'] as const)('a business failure whose code is %s stays on the value channel', async code => {
  const failure = defineFailure(code)();
  const { db, configs } = scriptedDb();
  expect(await runTransaction(db, () => Promise.resolve(failure), { retries: 1 })).toBe(failure);
  expect(configs).toHaveLength(1);
});

it.each(['08006', '08003', '57P01', '57P02', '57P03'])(
  'SQLSTATE %s before work is unavailable, without implying a statement rejection',
  async code => {
    let runs = 0;
    const db: TransactionalDb<FakeTx> = {
      transaction() {
        return Promise.reject(sqlError(code));
      },
    };
    expect(
      TransactionUnavailable.is(
        await runTransaction(db, () => {
          runs += 1;
          return Promise.resolve('done');
        }),
      ),
    ).toBe(true);
    expect(runs).toBe(0);
  },
);

it('an aborted reason with code 40001 remains cancellation before the first attempt', async () => {
  const { db, configs } = scriptedDb();
  const controller = new AbortController();
  controller.abort({ code: '40001' });
  expect(
    TransactionCancelled.is(await runTransaction(db, () => Promise.resolve('done'), { signal: controller.signal })),
  ).toBe(true);
  expect(configs).toHaveLength(0);
});

it('throwing telemetry context preserves refusal identity, driver outcomes and bounded retries', async () => {
  const telemetry = configure({
    channels: { records: memorySink() },
    default: { level: 'debug', channels: ['records'] },
    trace() {
      throw new Error('telemetry context failed');
    },
  });
  try {
    const failure = Refused();
    expect(await runTransactionOnce(scriptedDb().db, () => Promise.resolve(failure))).toBe(failure);
    expect(await runTransaction(scriptedDb().db, () => Promise.resolve(failure))).toBe(failure);
    const cause = new Error('callback defect');
    expect(await runTransactionOnce(scriptedDb().db, () => Promise.reject(cause))).toMatchObject({
      code: TransactionDefect.code,
      cause,
    });
    const clock = new MockClock();
    const { db, configs } = scriptedDb([sqlError('40001')]);
    expect(
      await settle(
        clock,
        runTransaction(db, () => Promise.resolve('done'), { clock }),
      ),
    ).toBe('done');
    expect(configs).toHaveLength(2);
  } finally {
    await telemetry.close();
  }
});

it('an arbitrary callback error code is a defect and the nearest code masks older connection failures', async () => {
  const cause = Object.assign(new Error('business bug', { cause: sqlError('ECONNRESET') }), { code: 'business-bug' });
  const result = await runTransaction(scriptedDb().db, () => Promise.reject(cause));
  expect(TransactionDefect.is(result)).toBe(true);
  expect(result).toMatchObject({ cause });
});

it.each(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN'])(
  'host connection code %s is operational before work finishes',
  async code => {
    const cause = sqlError(code);
    const result = await runTransaction(scriptedDb().db, () => Promise.reject(cause));
    expect(TransactionUnavailable.is(result)).toBe(true);
    expect(result).toMatchObject({ cause });
  },
);
