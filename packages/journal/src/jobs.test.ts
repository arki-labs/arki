/**
 * Queue rows in the jobs table: `kind = 'queue'` rows that a `JobRunner` runs under the
 * same claim, lease, renewal and fenced ack as effect jobs. `@arki/queue/outbox` writes
 * these rows; here they are inserted by hand so the engine is tested on its own.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { orThrow } from '@arki/failure';

import type { JobRunner, ScheduledJob } from './types.js';
import { jobId } from './id.js';
import { j, meta, openDb, order, orderId, OrderPlaced, tables } from './test-support.js';

let db: PgliteDatabase;
let client: PGlite;
let next = 0;

beforeAll(async () => {
  ({ db, client } = await openDb());
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await db.delete(tables.jobs);
});

/** A journal with no effects: the queue lane must still drain (the journal-less app path). */
const bare = j.compose({});

type Insert = typeof tables.jobs.$inferInsert;

const queueRow = async (name: string, args: unknown, extra?: Partial<Insert>): Promise<string> => {
  const id = jobId();
  await db.insert(tables.jobs).values({ id, kind: 'queue', jobName: name, args, ...extra });
  return id;
};

const rowOf = async (id: string) => {
  const rows = await db.select().from(tables.jobs).where(eq(tables.jobs.id, id));
  return rows[0] ?? null;
};

const runner = (
  names: readonly string[],
  run: (job: ScheduledJob, signal: AbortSignal) => Promise<void> | void,
  retryDelay: JobRunner['retryDelay'] = () => 0,
): JobRunner => ({
  names,
  run: async (job, ctx) => {
    await run(job, ctx.signal);
  },
  retryDelay,
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('journal_jobs schema', () => {
  it('takes a queue row and refuses a row that mixes the two kinds, so a runner never sees an event job', async () => {
    const id = await queueRow('demo', { a: 1 });
    expect(await rowOf(id)).toMatchObject({ kind: 'queue', jobName: 'demo', args: { a: 1 }, eventSeq: null });
    await expect(
      db.insert(tables.jobs).values({ id: jobId(), kind: 'queue', jobName: 'demo', args: {}, effect: 'order-mail' }),
    ).rejects.toThrow();
    // A queue row needs stored args: SQL NULL is refused, JSON null is a value.
    await expect(db.insert(tables.jobs).values({ id: jobId(), kind: 'queue', jobName: 'demo' })).rejects.toThrow();
    const nullArgs = jobId();
    await db.insert(tables.jobs).values({ id: nullArgs, kind: 'queue', jobName: 'demo', args: sql`'null'::jsonb` });
    expect(await rowOf(nullArgs)).toMatchObject({ args: null });
    // An effect row keeps today's shape: no event, no row.
    await expect(db.insert(tables.jobs).values({ id: jobId(), effect: 'order-mail' })).rejects.toThrow();
  });

  it('dedupes on (job_name, dedupe_key) and only where a key is set', async () => {
    await queueRow('demo', 1, { dedupeKey: 'k' });
    await expect(queueRow('demo', 2, { dedupeKey: 'k' })).rejects.toThrow();
    await queueRow('other', 3, { dedupeKey: 'k' });
    await queueRow('demo', 4);
    await queueRow('demo', 5);
  });
});

describe('drain with a job runner', () => {
  it('runs a queue row with its stored args and id, then deletes it; a journal with no effects still drains', async () => {
    const seen: ScheduledJob[] = [];
    const id = await queueRow('demo', { greeting: 'hi' });
    expect(await bare.drain(db, { jobs: runner(['demo'], job => void seen.push(job)) })).toBe(1);
    expect(seen).toEqual([{ id, name: 'demo', args: { greeting: 'hi' }, attempt: 1 }]);
    expect(await rowOf(id)).toBeNull();
  });

  it('a drain without a runner claims no queue row, so an old worker beside new rows is safe', async () => {
    const id = await queueRow('demo', {});
    const withEffects = j.compose({
      effects: [j.effect('noop', order, { OrderPlaced: () => Promise.resolve() })],
    });
    expect(await withEffects.drain(db)).toBe(0);
    expect(await bare.drain(db)).toBe(0);
    expect(await rowOf(id)).toMatchObject({ attempts: 0, leaseToken: null });
  });

  it('a throw keeps the row with the error and retries after the runner’s delay; the next try succeeds', async () => {
    let calls = 0;
    const jobs = runner(
      ['demo'],
      () => {
        calls += 1;
        if (calls === 1) throw new Error('smtp down');
      },
      () => 60_000,
    );
    const id = await queueRow('demo', {});
    expect(await bare.drain(db, { jobs })).toBe(1);
    const between = await rowOf(id);
    expect(between).toMatchObject({ attempts: 1, leaseToken: null, deadAt: null });
    expect(between?.lastError).toContain('smtp down');
    expect(between?.availableAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
    expect(await bare.drain(db, { jobs }), 'held back until the delay passes').toBe(0);
    await db
      .update(tables.jobs)
      .set({ availableAt: new Date(0) })
      .where(eq(tables.jobs.id, id));
    expect(await bare.drain(db, { jobs })).toBe(1);
    expect(calls).toBe(2);
    expect(await rowOf(id)).toBeNull();
  });

  it('goes dead when retryDelay says stop; journal.retry runs it again under the same id', async () => {
    const attempts: number[] = [];
    let fail = true;
    const jobs = runner(
      ['demo'],
      job => {
        attempts.push(job.attempt);
        if (fail) throw new Error('boom');
      },
      job => (job.attempt < 2 ? 0 : undefined),
    );
    const id = await queueRow('demo', {});
    expect(await bare.drain(db, { jobs })).toBe(2);
    expect(await rowOf(id)).toMatchObject({ attempts: 2, leaseToken: null });
    expect((await rowOf(id))?.deadAt).toBeInstanceOf(Date);
    expect(await bare.drain(db, { jobs })).toBe(0);
    expect((await bare.jobs(db, { status: 'dead', job: 'demo' })).jobs).toHaveLength(1);

    fail = false;
    await bare.retry(db, id, { actor: 'jobs-test' });
    expect(await bare.drain(db, { jobs })).toBe(1);
    expect(attempts).toEqual([1, 2, 1]);
    expect(await rowOf(id)).toBeNull();
  });

  it('a crash between the handler and the ack runs the handler again: execution is at least once', async () => {
    // Why: the ack is a separate statement after the work. Whatever fails in between leaves
    // the row, so the work repeats. Handlers must be idempotent on the job id.
    const handled: string[] = [];
    let crash = true;
    const jobs = runner(['demo'], job => {
      handled.push(job.id);
      if (crash) {
        crash = false;
        throw new Error('crashed after the handler');
      }
    });
    const id = await queueRow('demo', {});
    await bare.drain(db, { jobs });
    await bare.drain(db, { jobs });
    expect(handled).toEqual([id, id]);
    expect(await rowOf(id)).toBeNull();
  });

  it('never claims a name the runner lacks; strandedJobs shows it per kind and name', async () => {
    const id = await queueRow('renamed.v1', {});
    const jobs = runner(['demo'], () => undefined);
    expect(await bare.drain(db, { jobs })).toBe(0);
    expect(await rowOf(id)).toMatchObject({ attempts: 0 });
    expect(await bare.strandedJobs(db, { jobs })).toEqual([{ kind: 'queue', name: 'renamed.v1', jobs: 1 }]);
    // Without the runner the journal cannot judge queue names, so it does not count them.
    expect(await bare.strandedJobs(db)).toEqual([]);
  });

  it('runs effect rows and queue rows from one table in priority order; NORMAL queue rows tie with effects', async () => {
    const ran: string[] = [];
    const lanes = j.compose({
      effects: [j.effect('placed', order, { OrderPlaced: () => void ran.push('effect') })],
    });
    await queueRow('demo', 'background', { priority: -5 });
    await queueRow('demo', 'critical', { priority: 4 });
    const id = orderId(++next);
    orThrow(
      await db.transaction(tx =>
        lanes.write(tx, order, id, { meta, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
      ),
    );
    await queueRow('demo', 'normal', { priority: 0 });
    const jobs = runner(['demo'], job => void ran.push(String(job.args)));
    expect(await lanes.drain(db, { jobs })).toBe(4);
    // Equal priority falls back to available_at: the effect row was due first.
    expect(ran).toEqual(['critical', 'effect', 'normal', 'background']);
  });

  it('a lost lease aborts the runner’s signal and its late ack deletes nothing; the new owner acks', async () => {
    // Why: a stalled worker can lose its row to another worker. The first must stop and must
    // not delete a row it no longer owns; only the current lease holder acknowledges.
    const id = await queueRow('slow', {});
    let release: () => void = () => undefined;
    const second = new Promise<void>(resolve => {
      release = resolve;
    });
    const seen: string[] = [];
    let calls = 0;
    const jobs = runner(['slow'], async (_job, signal) => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 3000);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          });
        });
        seen.push(signal.aborted ? 'first:aborted' : 'first');
        return;
      }
      await second;
      seen.push('second');
    });

    const first = bare.drain(db, { jobs, leaseSeconds: 1 });
    await sleep(150);
    // The first worker stalled: its lease ran out before the next renewal.
    await db
      .update(tables.jobs)
      .set({ leaseUntil: sql`now() - interval '1 second'` })
      .where(eq(tables.jobs.id, id));
    const other = bare.drain(db, { jobs, leaseSeconds: 1 });
    expect(await first).toBe(1);
    expect(seen).toEqual(['first:aborted']);
    expect(await rowOf(id), 'the stale ack deleted nothing').not.toBeNull();
    release();
    expect(await other).toBe(1);
    expect(seen).toEqual(['first:aborted', 'second']);
    expect(await rowOf(id)).toBeNull();
  }, 10_000);

  it('a worker runs a queue row within one poll', async () => {
    const seen: string[] = [];
    const worker = bare.worker(db, { pollMs: 20, jobs: runner(['demo'], job => void seen.push(job.id)) });
    await worker.start();
    const id = await queueRow('demo', {});
    for (let i = 0; i < 50 && seen.length === 0; i++) await sleep(20);
    await worker.stop();
    expect(seen).toEqual([id]);
  });
});
