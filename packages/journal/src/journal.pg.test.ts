/**
 * Real Postgres, two connections (spec section 12, item 2). PGlite has one
 * connection and cannot show a second writer waiting on the row lock.
 * Needs Docker: starts a `postgres:16` container through testcontainers.
 */
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, inArray, sql } from 'drizzle-orm';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { customerOrderCounts, j, meta, order, orderId, OrderCancelled, OrderPaid, OrderPlaced, orders, tables } from './test-support.js';

let container: StartedPostgreSqlContainer;
let poolA: pg.Pool;
let poolB: pg.Pool;
let dbA: NodePgDatabase;
let dbB: NodePgDatabase;
let next = 100;
const journal = j.create({ tables });

/** The test swaps this to script the effect handler per scenario. */
let onPaid: (jobId: string) => Promise<void> | void = () => {
  /* the default handler does nothing */
};
const mail = j.effect('order-mail', order, { OrderPaid: (_e, ctx) => onPaid(ctx.jobId) });
const withJobs = j.create({ tables, effects: [mail] });

const placeAndPay = async () => {
  const id = orderId(++next);
  await dbA.transaction(tx => withJobs.write(tx, order, id, { meta, decide: () => [OrderPlaced({ customerId: 'c', total: 1 })] }));
  const paid = await dbA.transaction(tx => withJobs.write(tx, order, id, { meta, decide: () => [OrderPaid({ amount: 1 })] }));
  const [job] = await dbA.select().from(tables.jobs).where(eq(tables.jobs.eventSeq, paid.events[0]?.seq ?? -1));
  if (job === undefined) throw new Error('no job row');
  return job;
};

const jobRow = async (id: string) => {
  const rows = await dbA.select().from(tables.jobs).where(eq(tables.jobs.id, id));
  return rows[0] ?? null;
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  const connectionString = container.getConnectionUri();
  poolA = new pg.Pool({ connectionString, max: 1 });
  poolB = new pg.Pool({ connectionString, max: 1 });
  dbA = drizzle({ client: poolA });
  dbB = drizzle({ client: poolB });
  const { apply } = await pushSchema({ ...tables, orders, customerOrderCounts }, dbA);
  await apply();
}, 120_000);

afterAll(async () => {
  await poolA.end();
  await poolB.end();
  await container.stop();
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('two writers on real Postgres', () => {
  it('the second writer waits on the row lock, then sees the first writer\'s row', async () => {
    const id = orderId(1);
    await dbA.transaction(tx =>
      journal.write(tx, order, id, { meta, decide: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
    );

    const release = deferred();
    const locked = deferred();

    // Writer A locks the row, pays, and keeps the transaction open until released.
    const writerA = dbA.transaction(async tx => {
      await journal.write(tx, order, id, {
        meta,
        decide: () => {
          locked.resolve();
          return [OrderPaid({ amount: 1 })];
        },
      });
      await release.promise;
    });

    await locked.promise;
    let seen: { status: string; version: number } | undefined;
    const writerB = dbB.transaction(tx =>
      journal.write(tx, order, id, {
        meta,
        decide: row => {
          if (row === null) throw new Error('row vanished');
          seen = { status: row.status, version: row.version };
          return row.status === 'paid' ? [OrderCancelled({ reason: 'late' })] : [];
        },
      }),
    );

    await sleep(300);
    expect(seen, 'B must block at FOR UPDATE while A holds the row').toBeUndefined();

    release.resolve();
    await writerA;
    const resultB = await writerB;

    expect(seen).toEqual({ status: 'paid', version: 2 });
    expect(resultB.row).toBeNull();
    expect(resultB.events.map(e => e.version)).toEqual([3]);

    // Replay on real Postgres folds the same three events to the same end state.
    const replayed = await journal.replay(dbB, order, id);
    expect(replayed.row).toBeNull();
    expect(replayed.events.map(e => e.type)).toEqual(['OrderPlaced', 'OrderPaid', 'OrderCancelled']);
    const early = await journal.replay(dbB, order, id, { upTo: 2 });
    expect(early.row).toMatchObject({ id, status: 'paid', version: 2 });
  }, 30_000);

  it('two simultaneous creates of one new id: one wins, the other is CONFLICT, the log has one version 1', async () => {
    // A new id has no row to lock, so the unique index is the only guard. Both writers
    // must have read "no row" before either inserts, or this would be ROW_EXISTS.
    const id = orderId(++next);
    let arrived = 0;
    const bothLoaded = deferred();
    const decide = (customerId: string) => async () => {
      arrived += 1;
      if (arrived === 2) bothLoaded.resolve();
      await bothLoaded.promise;
      return [OrderPlaced({ customerId, total: 1 })];
    };
    const results = await Promise.allSettled([
      dbA.transaction(tx => journal.write(tx, order, id, { meta, decide: decide('a') })),
      dbB.transaction(tx => journal.write(tx, order, id, { meta, decide: decide('b') })),
    ]);
    const won = results.filter(result => result.status === 'fulfilled');
    const lost = results.filter(result => result.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]?.reason).toMatchObject({ code: 'CONFLICT' });
    const events = await dbA.select().from(tables.events).where(eq(tables.events.entityId, id));
    expect(events.map(e => e.version)).toEqual([1]);
    const rows = await dbA.select().from(orders).where(eq(orders.id, id));
    expect(rows.map(r => r.customerId)).toEqual([won[0]?.value.row?.customerId]);
  }, 30_000);
});

/**
 * Worker A claims the job and its handler stalls. The lease runs out. Worker B
 * reclaims, runs the handler, and records `bOutcome`. Then A's handler ends with
 * `aOutcome`. Returns the job row after B and after A.
 */
const staleAck = async (aOutcome: 'ok' | 'fail', bOutcome: 'ok' | 'fail') => {
  const job = await placeAndPay();
  try {
    const aStarted = deferred();
    const aRelease = deferred();
    let calls = 0;
    onPaid = async () => {
      calls += 1;
      if (calls === 1) {
        aStarted.resolve();
        await aRelease.promise;
        if (aOutcome === 'fail') throw new Error('A failed late');
        return;
      }
      if (bOutcome === 'fail') throw new Error('B failed');
    };
    const drainA = withJobs.drain(dbA);
    await aStarted.promise;
    await dbB.update(tables.jobs).set({ leaseUntil: sql`now() - interval '1 second'` }).where(eq(tables.jobs.id, job.id));
    expect(await withJobs.drain(dbB)).toBe(1);
    const afterB = await jobRow(job.id);
    aRelease.resolve();
    expect(await drainA).toBe(1);
    expect(calls).toBe(2);
    return { afterB, afterA: await jobRow(job.id) };
  } finally {
    // A failed B leaves the job pending with a short backoff. A later test's drain
    // would claim it. The snapshots above are what the assertions need.
    await dbA.delete(tables.jobs).where(eq(tables.jobs.id, job.id));
  }
};

describe('two workers on real Postgres', () => {
  it('a drain skips a due job another connection holds locked and takes the next one (SKIP LOCKED); finished jobs are gone', async () => {
    // Two drains racing can pass by claiming one after the other. Holding a row lock
    // on connection A while B drains proves the claim query skips, not waits.
    const locked = await placeAndPay();
    const free = await placeAndPay();
    const seen: string[] = [];
    onPaid = jobId => {
      seen.push(jobId);
    };
    await dbA.transaction(async tx => {
      await tx.select({ id: tables.jobs.id }).from(tables.jobs).where(eq(tables.jobs.id, locked.id)).for('update');
      expect(await withJobs.drain(dbB, { limit: 5 })).toBe(1);
      expect(seen).toEqual([free.id]);
    });
    expect(await withJobs.drain(dbB, { limit: 5 })).toBe(1);
    expect(seen).toEqual([free.id, locked.id]);
    expect(await dbA.select().from(tables.jobs).where(inArray(tables.jobs.id, [locked.id, free.id]))).toEqual([]);
  }, 30_000);

  it('a stale success cannot delete a job another worker already failed and scheduled for retry', async () => {
    // Otherwise a retry that B promised would vanish.
    const { afterB, afterA } = await staleAck('ok', 'fail');
    expect(afterB).toMatchObject({ attempts: 2, leaseToken: null });
    expect(afterB?.lastError).toContain('B failed');
    expect(afterA).toEqual(afterB);
  }, 30_000);

  it('a stale failure cannot overwrite the error and retry time another worker recorded', async () => {
    const { afterB, afterA } = await staleAck('fail', 'fail');
    expect(afterB?.lastError).toContain('B failed');
    expect(afterA).toEqual(afterB);
  }, 30_000);

  it('a stale success after the other worker finished the job finds nothing to acknowledge', async () => {
    const { afterB, afterA } = await staleAck('ok', 'ok');
    expect(afterB).toBeNull();
    expect(afterA).toBeNull();
  }, 30_000);
});

const quiet = () => {
  /* nothing to do */
};

describe('database clock on real Postgres', () => {
  // The container has its own clock. Faking `Date` moves only the worker's clock.
  it('a worker with a fast clock cannot take a lease the database still sees as live', async () => {
    onPaid = quiet;
    const job = await placeAndPay();
    await dbA
      .update(tables.jobs)
      .set({ leaseToken: 'live', leaseUntil: sql`now() + interval '60 seconds'`, attempts: 1 })
      .where(eq(tables.jobs.id, job.id));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 3_600_000);
      expect(await withJobs.drain(dbA)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    expect(await jobRow(job.id)).toMatchObject({ leaseToken: 'live', attempts: 1 });
    await dbA.update(tables.jobs).set({ leaseToken: null, leaseUntil: null }).where(eq(tables.jobs.id, job.id));
    expect(await withJobs.drain(dbA)).toBe(1);
    expect(await jobRow(job.id)).toBeNull();
  }, 30_000);

  it('retry time comes from the database clock, so a fast worker clock does not delay the retry', async () => {
    onPaid = () => {
      throw new Error('smtp down');
    };
    const job = await placeAndPay();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 3_600_000);
      expect(await withJobs.drain(dbA)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
    const after = await jobRow(job.id);
    // The first retry backs off about one second. An hour ahead means the worker clock leaked in.
    expect(after?.lastError).toContain('smtp down');
    expect(after?.availableAt.getTime()).toBeLessThan(Date.now() + 60_000);
    onPaid = quiet;
    await dbA.update(tables.jobs).set({ availableAt: sql`now() - interval '1 second'` }).where(eq(tables.jobs.id, job.id));
    expect(await withJobs.drain(dbA)).toBe(1);
    expect(await jobRow(job.id)).toBeNull();
  }, 30_000);
});
