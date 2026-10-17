/**
 * Attempt rows and the archive at ack. Queue rows are inserted by hand so the worker is tested on its own.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { EffectRetention } from './retention.js';
import type { JobRunner, ScheduledJob } from './types.js';
import { jobId } from './id.js';
import { j, openDb, tables } from './test-support.js';

let db: PgliteDatabase;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await openDb());
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await db.delete(tables.jobs);
  await db.delete(tables.jobArchive);
});

const bare = j.compose({ tables });

const queueRow = async (name: string): Promise<string> => {
  const id = jobId();
  await db.insert(tables.jobs).values({ id, kind: 'queue', jobName: name, args: {} });
  return id;
};

const attemptsOf = (id: string) =>
  db.select().from(tables.jobAttempts).where(eq(tables.jobAttempts.jobId, id)).orderBy(asc(tables.jobAttempts.attempt));

const archiveOf = async (id: string) => {
  const rows = await db.select().from(tables.jobArchive).where(eq(tables.jobArchive.id, id));
  return rows[0] ?? null;
};

const jobOf = async (id: string) => {
  const rows = await db.select().from(tables.jobs).where(eq(tables.jobs.id, id));
  return rows[0] ?? null;
};

const runner = (
  run: (job: ScheduledJob, signal: AbortSignal) => Promise<void> | void,
  extra?: Pick<JobRunner, 'retention'>,
  retryDelay: JobRunner['retryDelay'] = () => 0,
): JobRunner => ({
  names: ['demo'],
  run: async (job, ctx) => {
    await run(job, ctx.signal);
  },
  retryDelay,
  ...extra,
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('attempt rows', () => {
  it('a claim and its attempt row commit together', async () => {
    // Why: a try with no row, or a row for a try that never started, would make the attempt log lie.
    const id = await queueRow('demo');
    let seen: Awaited<ReturnType<typeof attemptsOf>> = [];
    await bare.drain(db, {
      jobs: runner(async () => {
        seen = await attemptsOf(id);
      }),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ attempt: 1, finishedAt: null, outcome: null });
    expect(seen[0]?.id).toMatch(/^att_/);
  });

  it('a fenced failure finishes the open attempt and a stale worker finishes nothing', async () => {
    // Why: only the lease holder may close an attempt. A worker that lost its lease must not
    // rewrite the history of the try that now belongs to someone else.
    const id = await queueRow('demo');
    await bare.drain(db, {
      jobs: runner(() => {
        throw new Error('boom');
      }),
      batchSize: 1,
    });
    expect(await attemptsOf(id)).toMatchObject([
      { attempt: 1, outcome: 'retry', error: expect.stringContaining('boom') },
    ]);
    expect((await attemptsOf(id))[0]?.finishedAt).not.toBeNull();

    // Stale: a slow first worker fails after another worker has reclaimed the job.
    // The retried job above is due again; remove it so the second drain can only take the slow one.
    await db.delete(tables.jobs);
    const slow = await queueRow('demo');
    let calls = 0;
    let release: () => void = () => undefined;
    const second = new Promise<void>(resolve => {
      release = resolve;
    });
    const jobs = runner(async () => {
      calls += 1;
      if (calls === 1) {
        await sleep(400);
        throw new Error('late failure');
      }
      await second;
    });
    const first = bare.drain(db, { jobs, batchSize: 1, leaseSeconds: 60 });
    await sleep(100);
    await db
      .update(tables.jobs)
      .set({ leaseUntil: sql`now() - interval '1 second'` })
      .where(eq(tables.jobs.id, slow));
    const other = bare.drain(db, { jobs, batchSize: 1, leaseSeconds: 60 });
    await first;
    const rows = await attemptsOf(slow);
    expect(rows.map(r => [r.attempt, r.outcome])).toEqual([
      [1, 'superseded'],
      [2, null],
    ]);
    expect(rows[1]?.error, 'the stale failure wrote nothing to the new owner’s attempt').toBeNull();
    release();
    await other;
  }, 10_000);

  it('a dead job’s last attempt ends as dead', async () => {
    // Why: dead is a different end from retry; the log must say which try gave up.
    const id = await queueRow('demo');
    await bare.drain(db, {
      jobs: runner(
        () => {
          throw new Error('nope');
        },
        undefined,
        () => undefined,
      ),
      batchSize: 1,
    });
    expect((await attemptsOf(id)).map(r => r.outcome)).toEqual(['dead']);
    expect((await jobOf(id))?.deadAt).not.toBeNull();
  });

  it('a reclaim marks the previous attempt superseded', async () => {
    // Why: an expired lease means the first try's fate is unknown. The log says so instead of leaving it open forever.
    const again = await queueRow('demo');
    await db.insert(tables.jobAttempts).values({ id: 'att_old2', jobId: again, attempt: 1 });
    await db
      .update(tables.jobs)
      .set({ attempts: 1, leaseToken: 'lease_gone', leaseUntil: sql`now() - interval '1 second'` })
      .where(eq(tables.jobs.id, again));
    let seen: Awaited<ReturnType<typeof attemptsOf>> = [];
    await bare.drain(db, {
      jobs: runner(async () => {
        seen = await attemptsOf(again);
      }),
    });
    expect(seen.map(r => [r.attempt, r.outcome])).toEqual([
      [1, 'superseded'],
      [2, null],
    ]);
    expect(seen[0]?.finishedAt).not.toBeNull();
  });
});

describe('archive at ack', () => {
  it('success moves the job and its attempt log to the archive in one fenced statement, so a lost lease archives nothing', async () => {
    // Why: the delete and the archive insert are one statement. A worker that lost its lease
    // deletes nothing, so it must archive nothing: no phantom completed row beside a live job.
    const id = await queueRow('demo');
    let calls = 0;
    await bare.drain(db, {
      jobs: runner(() => {
        calls += 1;
        if (calls === 1) throw new Error('first try fails');
      }),
      batchSize: 2,
    });
    const archived = await archiveOf(id);
    expect(archived).toMatchObject({ id, kind: 'queue', jobName: 'demo', outcome: 'completed', attempts: 2 });
    expect(archived?.keepUntil).not.toBeNull();
    expect(archived?.attemptLog).toMatchObject([
      { attempt: 1, outcome: 'retry', error: expect.stringContaining('first try fails') },
      { attempt: 2, outcome: 'ok', error: null },
    ]);
    expect(await jobOf(id)).toBeNull();
    expect(await attemptsOf(id), 'the attempt rows went with the job').toEqual([]);

    // Lost lease: another worker reclaims while the first is still running; the first one's late ack does nothing.
    const slow = await queueRow('demo');
    let release: () => void = () => undefined;
    const second = new Promise<void>(resolve => {
      release = resolve;
    });
    let slowCalls = 0;
    const jobs = runner(async () => {
      slowCalls += 1;
      if (slowCalls === 1) {
        await sleep(400);
        return;
      }
      await second;
    });
    const first = bare.drain(db, { jobs, batchSize: 1 });
    await sleep(100);
    await db
      .update(tables.jobs)
      .set({ leaseUntil: sql`now() - interval '1 second'` })
      .where(eq(tables.jobs.id, slow));
    const other = bare.drain(db, { jobs, batchSize: 1 });
    await first;
    expect(await archiveOf(slow), 'the stale ack archived nothing').toBeNull();
    expect(await jobOf(slow)).not.toBeNull();
    release();
    await other;
    expect(await archiveOf(slow)).toMatchObject({ outcome: 'completed', attempts: 2 });
    expect(await jobOf(slow)).toBeNull();
  }, 10_000);

  it('completed: false deletes at ack exactly as before', async () => {
    // Why: an app that opts out must pay nothing and keep nothing.
    const id = await queueRow('demo');
    await bare.drain(db, { jobs: runner(() => undefined, { retention: () => ({ completed: false }) }) });
    expect(await jobOf(id)).toBeNull();
    expect(await archiveOf(id)).toBeNull();
    expect(await attemptsOf(id)).toEqual([]);
  });

  it('a queue job’s retention comes from its runner', async () => {
    // Why: the runner knows the job definition. The same journal keeps one job for a day and another forever.
    const day = await queueRow('demo');
    const seenNames: string[] = [];
    const retention = (job: ScheduledJob): EffectRetention => {
      seenNames.push(job.name);
      return { completed: '1d' };
    };
    await bare.drain(db, { jobs: runner(() => undefined, { retention }) });
    const forever = await queueRow('demo');
    await bare.drain(db, { jobs: runner(() => undefined, { retention: () => ({ completed: 'forever' }) }) });
    const plain = await queueRow('demo');
    await bare.drain(db, { jobs: runner(() => undefined) });

    expect(seenNames).toEqual(['demo']);
    const dayRow = await archiveOf(day);
    const hours = ((dayRow?.keepUntil?.getTime() ?? 0) - (dayRow?.archivedAt.getTime() ?? 0)) / 3_600_000;
    expect(hours).toBeGreaterThan(23);
    expect(hours).toBeLessThan(25);
    expect((await archiveOf(forever))?.keepUntil).toBeNull();
    const plainRow = await archiveOf(plain);
    const plainDays = ((plainRow?.keepUntil?.getTime() ?? 0) - (plainRow?.archivedAt.getTime() ?? 0)) / 86_400_000;
    expect(plainDays, 'no override takes the journal default, 7 days').toBeGreaterThan(6.9);
    expect(plainDays).toBeLessThan(7.1);
  });
});
