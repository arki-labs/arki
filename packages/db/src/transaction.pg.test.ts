/**
 * `runTransaction` against a real PostgreSQL (container), with independent
 * pools standing in for concurrent requests.
 *
 * Why these tests exist: PGlite has one connection and never conflicts, so the
 * retry path is only real here. These are the cases the lesson promises: a
 * write skew and a deadlock are retried from a fresh transaction and the
 * invariant holds; a conflict raised by COMMIT itself is retried; a lost
 * connection around COMMIT is NOT retried (the commit may have happened); and
 * nothing is left `idle in transaction`.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { MockClock } from '@arki/clock';
import { defineFailure, isFailure } from '@arki/failure';
import { fakeLog } from '@arki/log/testing';

import type { TransactionalDb } from './transaction.js';
import { createUnitOfWork } from './composition.js';
import {
  retryableSqlState,
  runTransaction,
  runTransactionOnce,
  TransactionCommitUncertain,
  TransactionConflict,
  TransactionRejected,
} from './transaction.js';

type Db = NodePgDatabase;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

let container: StartedPostgreSqlContainer;
const pools: pg.Pool[] = [];
let dbA: Db;
let dbB: Db;

const swallow = (): null => null;

function newPool(options: pg.PoolConfig = {}): pg.Pool {
  const pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 10, ...options });
  // A terminated backend makes node-postgres emit 'error'; without a listener that is an uncaught exception.
  pool.on('error', swallow);
  pool.on('connect', connection => {
    connection.on('error', swallow);
  });
  pools.push(pool);
  return pool;
}

/** Resolves once `parties` callers have arrived: holds both transactions at the same point. */
function barrier(parties: number) {
  let arrived = 0;
  const all = Promise.withResolvers<void>();
  return {
    arrive(): Promise<void> {
      arrived += 1;
      if (arrived === parties) all.resolve();
      return all.promise;
    },
  };
}

async function total(db: Db): Promise<number> {
  const result = await db.execute<{ total: number }>(sql`select coalesce(sum(balance), 0)::int as total from accounts`);
  return result.rows[0]?.total ?? Number.NaN;
}

async function balanceOf(db: Db, id: string): Promise<number | undefined> {
  const result = await db.execute<{ balance: number }>(sql`select balance from accounts where id = ${id}`);
  return result.rows[0]?.balance;
}

/** Withdraw only if the SUM stays non-negative: the classic write skew when two run at once on different rows. */
function withdraw(
  db: Db,
  id: string,
  cents: number,
  options: { retries?: number; bothRead?: { arrive(): Promise<void> } } = {},
) {
  const attempts: number[] = [];
  const run = runTransaction(
    db,
    async (tx, attempt) => {
      attempts.push(attempt);
      const sum = await total(tx);
      if (attempt === 1) await options.bothRead?.arrive();
      if (sum - cents < 0) return 'refused';
      await tx.execute(sql`update accounts set balance = balance - ${cents} where id = ${id}`);
      return 'done';
    },
    { retries: options.retries ?? 3 },
  );
  return { run, attempts };
}

/** Records, per attempt, whether the work had finished when the transaction failed: then COMMIT raised it. */
function observed(db: Db) {
  const outcomes: { workDone: boolean; error?: unknown }[] = [];
  const wrapped: TransactionalDb<Tx> = {
    async transaction(fn, config) {
      const outcome: { workDone: boolean; error?: unknown } = { workDone: false };
      outcomes.push(outcome);
      try {
        return await db.transaction(async tx => {
          const result = await fn(tx);
          outcome.workDone = true;
          return result;
        }, config);
      } catch (error) {
        outcome.error = error;
        throw error;
      }
    },
  };
  return { db: wrapped, outcomes };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  dbA = drizzle({ client: newPool() });
  dbB = drizzle({ client: newPool() });
  await dbA.execute(sql`create table accounts (id text primary key, balance int not null)`);
}, 120_000);

beforeEach(async () => {
  await dbA.execute(sql`delete from accounts`);
  await dbA.execute(sql`insert into accounts values ('a', 100), ('b', 100)`);
});

afterEach(async () => {
  // No leaks: every attempt's connection went back to the pool with its transaction closed.
  await vi.waitFor(async () => {
    const result = await dbA.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_stat_activity where usename = current_user and state like 'idle in transaction%'`,
    );
    expect(result.rows[0]?.n).toBe(0);
  });
});

afterAll(async () => {
  await Promise.all(pools.map(pool => pool.end().catch(swallow)));
  await container?.stop();
});

describe('runTransaction on PostgreSQL: conflicts are retried', () => {
  it('write skew: one caller gets 40001, reruns from a fresh transaction, and the invariant holds', async () => {
    using log = fakeLog();
    const bothRead = barrier(2);
    const retries = 3;
    const first = withdraw(dbA, 'a', 150, { bothRead, retries });
    const second = withdraw(dbB, 'b', 150, { bothRead, retries });
    const results = await Promise.all([first.run, second.run]);

    expect(results.toSorted()).toEqual(['done', 'refused']);
    // Assert the retry contract, not one scheduling-dependent conflict count.
    const conflicts = log.records.filter(
      record => record.category === 'arki:db:transaction' && record.fields['sqlState'] === '40001',
    );
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    expect(first.attempts.length + second.attempts.length).toBe(2 + conflicts.length);
    for (const attempts of [first.attempts, second.attempts]) {
      expect(attempts.length).toBeLessThanOrEqual(retries + 1);
      expect(attempts).toEqual(Array.from({ length: attempts.length }, (_, index) => index + 1));
    }
    expect(await total(dbA)).toBe(50);
    log.assertLogged({ category: 'arki:db:transaction', level: 'debug', fields: { sqlState: '40001' } });
  });

  it('deadlock: the victim gets 40P01 and reruns; both transfers land', async () => {
    using log = fakeLog();
    const bothLocked = barrier(2);
    const transfer = (db: Db, from: string, to: string) =>
      runTransaction(db, async (tx, attempt) => {
        await tx.execute(sql`update accounts set balance = balance - 10 where id = ${from}`);
        if (attempt === 1) await bothLocked.arrive();
        await tx.execute(sql`update accounts set balance = balance + 10 where id = ${to}`);
      });
    expect(await Promise.all([transfer(dbA, 'a', 'b'), transfer(dbB, 'b', 'a')])).toEqual([undefined, undefined]);

    expect([await balanceOf(dbA, 'a'), await balanceOf(dbA, 'b')]).toEqual([100, 100]);
    log.assertLogged({ category: 'arki:db:transaction', level: 'debug', fields: { sqlState: '40P01' } });
  });

  it('a 40001 raised by COMMIT itself is retried', async () => {
    const bothWrote = barrier(2);
    const firstCommitted = Promise.withResolvers<void>();
    const late = observed(dbB);

    const write = (db: TransactionalDb<Tx>, id: string, onAttemptOneDone?: Promise<void>) =>
      runTransaction(db, async (tx, attempt) => {
        await total(tx);
        await tx.execute(sql`update accounts set balance = balance - 1 where id = ${id}`);
        if (attempt === 1) {
          await bothWrote.arrive();
          await onAttemptOneDone;
        }
      });

    const early = write(dbA, 'a').then(outcome => {
      firstCommitted.resolve();
      return outcome;
    });
    expect(await Promise.all([early, write(late.db, 'b', firstCommitted.promise)])).toEqual([undefined, undefined]);

    expect(late.outcomes).toHaveLength(2);
    // Attempt 1 finished all its statements; the 40001 came from COMMIT.
    expect(late.outcomes[0]?.workDone).toBe(true);
    expect(retryableSqlState(late.outcomes[0]?.error)).toBe('40001');
    expect(late.outcomes[1]?.error).toBeUndefined();
    expect(await total(dbA)).toBe(198);
  });

  it('out of retries (retries: 0): the loser gets ARKI_DB_TX_E001, nothing it wrote is kept', async () => {
    const bothRead = barrier(2);
    const settled = await Promise.all([
      withdraw(dbA, 'a', 150, { bothRead, retries: 0 }).run,
      withdraw(dbB, 'b', 150, { bothRead, retries: 0 }).run,
    ]);
    const rejected = settled.filter(result => TransactionConflict.is(result));
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      code: TransactionConflict.code,
      data: { attempts: 1, sqlState: '40001' },
    });
    expect(await total(dbA)).toBe(50);
  });

  it('a unique violation under SERIALIZABLE runs once: 23505 is an answer, not a race', async () => {
    let runs = 0;
    const error = await runTransaction(dbA, async tx => {
      runs += 1;
      await tx.execute(sql`insert into accounts values ('a', 1)`);
    }).catch((error_: unknown) => error_);
    expect(runs).toBe(1);
    expect(retryableSqlState(error)).toBeUndefined();
    expect(error).toMatchObject({ code: TransactionRejected.code, data: { sqlState: '23505' } });
  });

  it('the wait between attempts holds no connection: an unrelated call on a 1-connection pool completes', async () => {
    const single = drizzle({ client: newPool({ max: 1 }) });
    const clock = new MockClock();
    const sleep = vi.spyOn(clock, 'sleep');
    let failed = false;
    const flaky: TransactionalDb<Tx> = {
      transaction: (fn, config) =>
        single.transaction(async tx => {
          const result = await fn(tx);
          if (!failed) {
            failed = true;
            throw Object.assign(new Error('scripted serialization failure'), { code: '40001' });
          }
          return result;
        }, config),
    };
    const retrying = runTransaction(
      flaky,
      async tx => tx.execute(sql`update accounts set balance = balance + 1 where id = 'a'`),
      {
        clock,
      },
    );
    await vi.waitFor(() => {
      expect(sleep).toHaveBeenCalledTimes(1);
    });
    // The retry is waiting on the mock clock. The pool's only connection must be free.
    expect(await runTransaction(single, async tx => total(tx))).toBe(200);
    await clock.advanceAsync(1000);
    expect(isFailure(await retrying)).toBe(false);
    expect(await balanceOf(dbA, 'a')).toBe(101);
  });
});

describe('runTransaction on PostgreSQL: an uncertain commit is not retried', () => {
  it('(a) a connection-shaped error after a real COMMIT runs once: the write happened, and is not repeated', async () => {
    let runs = 0;
    const lostAck: TransactionalDb<Tx> = {
      async transaction(fn, config) {
        await dbA.transaction(fn, config);
        throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      },
    };
    const error = await runTransaction(lostAck, async tx => {
      runs += 1;
      await tx.execute(sql`update accounts set balance = balance + 5 where id = 'a'`);
    }).catch((error_: unknown) => error_);

    expect(runs).toBe(1);
    expect(TransactionCommitUncertain.is(error)).toBe(true);
    expect(await balanceOf(dbA, 'a')).toBe(105);
  });

  it('(b) a backend killed right before COMMIT: the driver error is not retried, and the write is gone', async () => {
    let runs = 0;
    const victim = drizzle({ client: newPool({ max: 1 }) });
    const error = await runTransaction(victim, async tx => {
      runs += 1;
      await tx.execute(sql`update accounts set balance = balance + 7 where id = 'a'`);
      const pid = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      await dbA.execute(sql`select pg_terminate_backend(${pid.rows[0]?.pid ?? 0})`);
    }).catch((error_: unknown) => error_);

    expect(runs).toBe(1);
    expect(TransactionCommitUncertain.is(error)).toBe(true);
    expect(retryableSqlState(error)).toBeUndefined();
    expect(await balanceOf(dbA, 'a')).toBe(100);
  });
});

const Refused = defineFailure('test.insert_refused');

describe('returned outcomes on real PostgreSQL', () => {
  it('insert then failure rolls back and returns the same object; success commits unchanged', async () => {
    const failure = Refused();
    const refused = await runTransaction(dbA, async tx => {
      await tx.execute(sql`insert into accounts values ('refused', 20)`);
      return failure;
    });
    expect(refused).toBe(failure);
    expect(await balanceOf(dbA, 'refused')).toBeUndefined();
    const value = { id: 'accepted' };
    const accepted = await runTransaction(dbA, async tx => {
      await tx.execute(sql`insert into accounts values ('accepted', 30)`);
      return value;
    });
    expect(accepted).toBe(value);
    expect(await balanceOf(dbA, 'accepted')).toBe(30);
    expect(isFailure(accepted)).toBe(false);
  });
});

it('single-attempt savepoints and unit-of-work roll back refusals without changing outer transaction policy', async () => {
  const failure = Refused();
  await dbA.transaction(async outer => {
    await outer.execute(sql`insert into accounts values ('outer', 1)`);
    expect(
      await runTransactionOnce(outer, async inner => {
        await inner.execute(sql`insert into accounts values ('inner', 2)`);
        return failure;
      }),
    ).toBe(failure);
  });
  expect(await balanceOf(dbA, 'outer')).toBe(1);
  expect(await balanceOf(dbA, 'inner')).toBeUndefined();
  const unit = createUnitOfWork(dbA, { accounts: tx => tx });
  expect(
    await unit(async scope => {
      await scope.accounts.execute(sql`insert into accounts values ('unit', 3)`);
      return failure;
    }),
  ).toBe(failure);
  expect(await balanceOf(dbA, 'unit')).toBeUndefined();
});
