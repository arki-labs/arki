/**
 * Real Postgres, two connections (spec section 12, item 2). PGlite has one
 * connection and cannot show a second writer waiting on the row lock.
 * Needs Docker: starts a `postgres:16` container through testcontainers.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { listenOnPool } from './listen.js';
import {
  customerOrderCounts,
  j,
  meta,
  order,
  OrderCancelled,
  orderId,
  OrderPaid,
  OrderPlaced,
  orders,
  tables,
} from './test-support.js';

let container: StartedPostgreSqlContainer;
let poolA: pg.Pool;
let poolB: pg.Pool;
let dbA: NodePgDatabase;
let dbB: NodePgDatabase;
let next = 100;
const journal = j.compose({ tables });

/** The test swaps this to script the effect handler per scenario. */
let onPaid: (jobId: string) => Promise<void> | void = () => {
  /* the default handler does nothing */
};
const mail = j.effect('order-mail', order, { OrderPaid: (_e, ctx) => onPaid(ctx.jobId) });
const withJobs = j.compose({ tables, effects: [mail] });

const placeAndPay = async () => {
  const id = orderId(++next);
  await dbA.transaction(tx =>
    withJobs.write(tx, order, id, { meta, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
  );
  const paid = await dbA.transaction(tx =>
    withJobs.write(tx, order, id, { meta, events: () => [OrderPaid({ amount: 1 })] }),
  );
  const [job] = await dbA
    .select()
    .from(tables.jobs)
    .where(eq(tables.jobs.eventSeq, paid.events[0]?.seq ?? -1));
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

/** `work`, or a failure naming `why` after `ms`. A test that hangs on a regression fails instead. */
const withDeadline = <T>(work: Promise<T>, ms: number, why: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(why)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
};

/**
 * Wait for `gate`, which `producer` is expected to open. If `producer` settles
 * first (it failed, or finished without opening the gate), fail with `why`
 * and its reason instead of waiting for the deadline.
 */
const arrival = (gate: Promise<void>, producer: Promise<unknown>, why: string): Promise<void> =>
  withDeadline(
    Promise.race([
      gate,
      producer.then(
        () => {
          throw new Error(`${why}: it finished first`);
        },
        (error: unknown) => {
          throw new Error(`${why}: it failed first`, { cause: error });
        },
      ),
    ]),
    5000,
    `${why}: deadline passed`,
  );

describe('two writers on real Postgres', () => {
  it('appends commit in seq order: a second writer gets no seq until the first commits, so `seq > cursor` is safe', async () => {
    // Why: seq is a bigserial, assigned at insert. Without the append lock, A takes seq 10, B takes 11
    // and commits first, a reader checkpoints at 11, and A's event at 10 is never read.
    const release = deferred();
    const appended = deferred();
    const writerA = dbA.transaction(async tx => {
      const result = await journal.write(tx, order, orderId(++next), {
        meta,
        events: () => [OrderPlaced({ customerId: 'c', total: 1 })],
      });
      appended.resolve();
      await release.promise;
      return result;
    });
    const settle: Promise<unknown>[] = [writerA];
    try {
      await arrival(appended.promise, writerA, 'writer A never appended');
      let settledB = false;
      const writerB = dbB
        .transaction(tx =>
          journal.write(tx, order, orderId(++next), {
            meta,
            events: () => [OrderPlaced({ customerId: 'c', total: 1 })],
          }),
        )
        .then(result => {
          settledB = true;
          return result;
        });
      settle.push(writerB);

      await sleep(300);
      expect(settledB, 'B must wait for the append lock while A holds it').toBe(false);

      release.resolve();
      const resultA = await writerA;
      const resultB = await writerB;
      const seqA = resultA.events[0]?.seq;
      const seqB = resultB.events[0]?.seq;
      if (seqA === undefined || seqB === undefined) throw new Error('no events');
      expect(seqB).toBeGreaterThan(seqA);
    } finally {
      release.resolve();
      await Promise.allSettled(settle);
    }
  }, 30_000);

  it("the second writer waits on the row lock, then sees the first writer's row", async () => {
    const id = orderId(1);
    await dbA.transaction(tx =>
      journal.write(tx, order, id, { meta, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
    );

    const release = deferred();
    const locked = deferred();

    // Writer A locks the row, pays, and keeps the transaction open until released.
    const writerA = dbA.transaction(async tx => {
      await journal.write(tx, order, id, {
        meta,
        events: () => {
          locked.resolve();
          return [OrderPaid({ amount: 1 })];
        },
      });
      await release.promise;
    });
    // A failed assertion must still release A and let B finish, or both connections hang.
    const settle: Promise<unknown>[] = [writerA];
    try {
      await arrival(locked.promise, writerA, 'writer A never reached the row lock');
      let seen: { status: string; version: number } | undefined;
      const writerB = dbB.transaction(tx =>
        journal.write(tx, order, id, {
          meta,
          events: row => {
            if (row === null) throw new Error('row vanished');
            seen = { status: row.status, version: row.version };
            return row.status === 'paid' ? [OrderCancelled({ reason: 'late' })] : [];
          },
        }),
      );
      settle.push(writerB);

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
      const early = await journal.replay(dbB, order, id, { throughVersion: 2 });
      expect(early.row).toMatchObject({ id, status: 'paid', version: 2 });
    } finally {
      release.resolve();
      await Promise.allSettled(settle);
    }
  }, 30_000);

  it('two simultaneous creates of one new id: the second waits at the append lock, sees the first row, and is ROW_EXISTS', async () => {
    // Why: a new id has no row to lock. Before the append lock, both writers read "no row", both
    // inserted, and the unique index turned the loser into CONFLICT. The lock serialises them: the
    // loser loads the winner's row and gets the ordinary answer for a create over a row. The unique
    // index stays as the backstop for a writer that reaches the insert some other way.
    const id = orderId(++next);
    const seen: (string | null)[] = [];
    const placeOn = (db: typeof dbA, customerId: string) =>
      db.transaction(tx =>
        journal.write(tx, order, id, {
          meta,
          events: row => {
            seen.push(row?.customerId ?? null);
            return [OrderPlaced({ customerId, total: 1 })];
          },
        }),
      );
    const results = await Promise.allSettled([placeOn(dbA, 'a'), placeOn(dbB, 'b')]);
    const won = results.filter(result => result.status === 'fulfilled');
    const lost = results.filter(result => result.status === 'rejected');
    expect(won, 'one writer must win').toHaveLength(1);
    expect(lost, 'one writer must lose').toHaveLength(1);
    expect(lost[0]?.reason).toMatchObject({ code: 'ROW_EXISTS' });
    const winner = won[0]?.value.row?.customerId;
    expect(seen.toSorted(), "the loser loaded the winner's row").toEqual([null, winner].toSorted());
    const events = await dbA.select().from(tables.events).where(eq(tables.events.entityId, id));
    expect(events.map(e => e.version)).toEqual([1]);
    const rows = await dbA.select().from(orders).where(eq(orders.id, id));
    expect(rows.map(r => r.customerId)).toEqual([winner]);
  }, 30_000);
});

/**
 * JournalWorker A claims the job and its handler stalls. The lease runs out. JournalWorker B
 * reclaims, runs the handler, and records `bOutcome`. Then A's handler ends with
 * `aOutcome`. Returns the job row after B and after A.
 */
const quiet = () => {
  /* nothing to do */
};

const staleAck = async (aOutcome: 'ok' | 'fail', bOutcome: 'ok' | 'fail') => {
  const job = await placeAndPay();
  const aRelease = deferred();
  let drainA: Promise<number> | undefined;
  try {
    const aStarted = deferred();
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
    drainA = withJobs.drain(dbA);
    await arrival(aStarted.promise, drainA, "drain A never started the job's handler");
    await dbB
      .update(tables.jobs)
      .set({ leaseUntil: sql`now() - interval '1 second'` })
      .where(eq(tables.jobs.id, job.id));
    expect(await withJobs.drain(dbB)).toBe(1);
    const afterB = await jobRow(job.id);
    aRelease.resolve();
    expect(await drainA).toBe(1);
    expect(calls).toBe(2);
    return { afterB, afterA: await jobRow(job.id) };
  } finally {
    // A failed assertion above must not leave A's handler stalled, or its drain never ends.
    aRelease.resolve();
    await drainA?.catch(quiet);
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
    // Without SKIP LOCKED, B's drain waits on A's row lock while A waits on the drain.
    // The deadline turns that deadlock into a failure; `settle` lets the orphaned drain
    // finish once A's transaction has ended, so the next test starts clean.
    const settle: Promise<unknown>[] = [];
    try {
      await dbA.transaction(async tx => {
        await tx.select({ id: tables.jobs.id }).from(tables.jobs).where(eq(tables.jobs.id, locked.id)).for('update');
        const drained = withJobs.drain(dbB, { batchSize: 5 });
        settle.push(drained);
        expect(await withDeadline(drained, 5000, 'the drain waited on the locked job instead of skipping it')).toBe(1);
        expect(seen).toEqual([free.id]);
      });
    } finally {
      await Promise.allSettled(settle);
    }
    expect(await withJobs.drain(dbB, { batchSize: 5 })).toBe(1);
    expect(seen).toEqual([free.id, locked.id]);
    expect(
      await dbA
        .select()
        .from(tables.jobs)
        .where(inArray(tables.jobs.id, [locked.id, free.id])),
    ).toEqual([]);
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

describe('listenOnPool on real Postgres', () => {
  it('a listening worker fires taps for a commit made on another connection, survives a dropped connection, and gives its client back on stop', async () => {
    // Why: taps are the multi-instance realtime path. The listener must hear commits from any
    // connection, reconnect on its own when the connection dies, and leave the pool as it found it.
    const seen: string[] = [];
    const live = j.tap('pg-live', order, {
      OrderPlaced: e => {
        seen.push(e.entityId);
      },
    });
    const tapped = j.compose({ tables, taps: [live] });
    const listenPool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 2 });
    const until = async (check: () => boolean) => {
      const end = Date.now() + 5000;
      while (!check() && Date.now() < end) await sleep(25);
    };
    const placeOnB = async () => {
      const id = orderId(++next);
      await dbB.transaction(tx =>
        tapped.write(tx, order, id, { meta, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
      );
      return id;
    };
    const worker = tapped.worker(drizzle({ client: listenPool }), {
      pollMs: 60_000,
      listen: listenOnPool(listenPool, tapped.wakeChannel, { retryMs: 50 }),
    });
    await worker.start();
    try {
      const first = await placeOnB();
      await until(() => seen.length === 1);
      expect(seen).toEqual([first]);

      // Kill the listening backend from outside; the listener reconnects and hears the next commit.
      await dbB.execute(
        sql`select pg_terminate_backend(pid) from pg_stat_activity where query ilike ${'LISTEN%'} and pid <> pg_backend_pid()`,
      );
      await sleep(300);
      const second = await placeOnB();
      await until(() => seen.length === 2);
      expect(seen).toEqual([first, second]);
    } finally {
      await worker.stop();
    }
    expect(listenPool.totalCount - listenPool.idleCount, 'no client still checked out').toBe(0);
    await listenPool.end();
  }, 30_000);
});

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
    await dbA
      .update(tables.jobs)
      .set({ availableAt: sql`now() - interval '1 second'` })
      .where(eq(tables.jobs.id, job.id));
    expect(await withJobs.drain(dbA)).toBe(1);
    expect(await jobRow(job.id)).toBeNull();
  }, 30_000);
});
