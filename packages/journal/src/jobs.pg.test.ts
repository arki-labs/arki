/**
 * Queue rows on real Postgres, several connections. PGlite has one connection, so it proves
 * nothing about locking, visibility or the wake channel; this file does.
 * Needs Docker: starts a `postgres:16` container through testcontainers.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { listenOnPool } from '@arki/db/pg';

import type { JobRunner, ScheduledJob } from './types.js';
import { jobId } from './id.js';
import { j, tables } from './test-support.js';

let container: StartedPostgreSqlContainer;
let poolA: pg.Pool;
let poolB: pg.Pool;
let poolListen: pg.Pool;
let dbA: NodePgDatabase;
let dbB: NodePgDatabase;
const journal = j.compose({ tables });

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const runner = (
  run: (job: ScheduledJob, signal: AbortSignal) => Promise<void> | void,
  retryDelay: JobRunner['retryDelay'] = () => 0,
): JobRunner => ({
  names: ['demo'],
  run: async (job, ctx) => {
    await run(job, ctx.signal);
  },
  retryDelay,
});

/** One queue row and its wake, committed on pool A, as `@arki/queue/outbox` writes them. */
const schedule = async (args: unknown = {}): Promise<string> => {
  const id = jobId();
  await dbA.transaction(async tx => {
    await tx.insert(tables.jobs).values({ id, kind: 'queue', jobName: 'demo', args });
    await tx.execute(sql`select pg_notify(${journal.wakeChannel}, '{"queue":1}')`);
  });
  return id;
};

const rowOf = async (id: string) => {
  const rows = await dbA.select().from(tables.jobs).where(eq(tables.jobs.id, id));
  return rows[0] ?? null;
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  const connectionString = container.getConnectionUri();
  poolA = new pg.Pool({ connectionString, max: 1 });
  poolB = new pg.Pool({ connectionString, max: 1 });
  poolListen = new pg.Pool({ connectionString, max: 1 });
  dbA = drizzle({ client: poolA });
  dbB = drizzle({ client: poolB });
  const { apply } = await pushSchema({ ...tables }, dbA);
  await apply();
}, 120_000);

afterAll(async () => {
  await poolA.end();
  await poolB.end();
  await poolListen.end();
  await container.stop();
});

beforeEach(async () => {
  await dbA.delete(tables.jobs).where(sql`true`);
});

describe('queue rows on Postgres', () => {
  it('two workers compete for 50 rows: every row runs, none twice', async () => {
    const ran: string[] = [];
    const jobs = runner(job => {
      ran.push(job.id);
    });
    const ids = await Promise.all(Array.from({ length: 50 }, (_, index) => schedule({ index })));
    const [a, b] = await Promise.all([
      journal.drain(dbA, { jobs, batchSize: 100 }),
      journal.drain(dbB, { jobs, batchSize: 100 }),
    ]);
    expect(a + b).toBe(50);
    expect(ran.toSorted()).toEqual(ids.toSorted());
    expect(await dbA.select().from(tables.jobs)).toEqual([]);
  });

  it('a locked row does not block another due row (SKIP LOCKED)', async () => {
    const ran: string[] = [];
    const jobs = runner(job => {
      ran.push(job.id);
    });
    const locked = await schedule({ n: 1 });
    const free = await schedule({ n: 2 });
    await dbA.transaction(async tx => {
      await tx.select().from(tables.jobs).where(eq(tables.jobs.id, locked)).for('update');
      expect(await journal.drain(dbB, { jobs })).toBe(1);
    });
    expect(ran).toEqual([free]);
    expect(await rowOf(locked)).toMatchObject({ attempts: 0 });
  });

  it('a row in an uncommitted transaction is invisible to a worker on another connection', async () => {
    const jobs = runner(() => undefined);
    await dbA.transaction(async tx => {
      await tx.insert(tables.jobs).values({ id: jobId(), kind: 'queue', jobName: 'demo', args: {} });
      expect(await journal.drain(dbB, { jobs })).toBe(0);
    });
    expect(await journal.drain(dbB, { jobs })).toBe(1);
  });

  it('a worker that crashed after its claim leaves a row the next worker takes once the lease runs out', async () => {
    const ran: string[] = [];
    const jobs = runner(job => {
      ran.push(job.id);
    });
    const id = await schedule();
    // What a crash between claim and run leaves: a lease nobody renews.
    await dbA
      .update(tables.jobs)
      .set({ leaseToken: 'crashed', leaseUntil: sql`now() + interval '1 second'`, attempts: 1 })
      .where(eq(tables.jobs.id, id));
    expect(await journal.drain(dbB, { jobs })).toBe(0);
    await sleep(1100);
    expect(await journal.drain(dbB, { jobs })).toBe(1);
    expect(ran).toEqual([id]);
  });

  it('a crash after the external effect, before the ack, repeats the job under the same id', async () => {
    const effects: string[] = [];
    let crash = true;
    const jobs = runner(job => {
      effects.push(job.id);
      if (crash) {
        crash = false;
        throw new Error('process died before the ack');
      }
    });
    const id = await schedule();
    await journal.drain(dbB, { jobs });
    // At least once: the external system must dedupe on this id.
    expect(effects).toEqual([id, id]);
  });

  it('a reclaimed lease rejects the stale worker: its renewal aborts it and its ack deletes nothing', async () => {
    const id = await schedule();
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const seen: string[] = [];
    let calls = 0;
    const jobs = runner(async (_job, signal) => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 5000);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          });
        });
        seen.push(signal.aborted ? 'stale:aborted' : 'stale');
        return;
      }
      await held;
      seen.push('owner');
    });
    const stale = journal.drain(dbA, { jobs, leaseSeconds: 1 });
    await sleep(150);
    // The stale worker stalled past its lease; another worker on another connection takes the row.
    await dbB
      .update(tables.jobs)
      .set({ leaseUntil: sql`now() - interval '1 second'` })
      .where(eq(tables.jobs.id, id));
    const owner = journal.drain(dbB, { jobs, leaseSeconds: 1 });
    expect(await stale).toBe(1);
    expect(seen).toEqual(['stale:aborted']);
    expect(await rowOf(id)).not.toBeNull();
    release();
    expect(await owner).toBe(1);
    expect(await rowOf(id)).toBeNull();
  }, 15_000);

  it('the commit’s NOTIFY wakes a worker on another connection well before its poll', async () => {
    let ranAt = 0;
    const worker = journal.worker(dbB, {
      pollMs: 10_000,
      listen: listenOnPool(poolListen, journal.wakeChannel),
      jobs: runner(() => {
        ranAt = Date.now();
      }),
    });
    await worker.start();
    try {
      await sleep(200);
      const committedAt = Date.now();
      await schedule();
      for (let i = 0; i < 100 && ranAt === 0; i++) await sleep(10);
      expect(ranAt).toBeGreaterThan(0);
      // Far below the 10 s poll, so only the NOTIFY can have woken it. Idle, this is under 200 ms;
      // the bound leaves room for a loaded machine running other test files in parallel.
      expect(ranAt - committedAt).toBeLessThan(2000);
    } finally {
      await worker.stop();
    }
  });

  it('a killed listener connection reconnects, and polling covers the gap', async () => {
    const ran: string[] = [];
    const worker = journal.worker(dbB, {
      pollMs: 300,
      listen: listenOnPool(poolListen, journal.wakeChannel, { retryMs: 50 }),
      jobs: runner(job => {
        ran.push(job.id);
      }),
    });
    await worker.start();
    try {
      await sleep(100);
      await dbA.execute(
        sql`select pg_terminate_backend(pid) from pg_stat_activity where query ilike ${'listen %'} and pid <> pg_backend_pid()`,
      );
      const id = await schedule();
      for (let i = 0; i < 100 && ran.length === 0; i++) await sleep(20);
      expect(ran).toEqual([id]);
      // Reconnected: the next wake is heard again.
      await sleep(300);
      const second = await schedule();
      for (let i = 0; i < 100 && ran.length === 1; i++) await sleep(20);
      expect(ran).toEqual([id, second]);
    } finally {
      await worker.stop();
    }
  });

  it('an old worker (a drain built without jobs) claims none of the queue rows', async () => {
    const effects = j.compose({
      tables,
      effects: [],
    });
    const id = await schedule();
    expect(await effects.drain(dbB)).toBe(0);
    expect(await rowOf(id)).toMatchObject({ attempts: 0, leaseToken: null });
  });
});
