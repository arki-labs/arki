/**
 * The job operations on PGlite: the states, the paging, and the verbs that change jobs. Each verb is held to the
 * same two promises: the change is one guarded step, and exactly one operation row says who did it.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { attemptId, jobId } from './id.js';
import { createJobOps } from './outbox.js';
import { resolveRetention } from './retention.js';
import { openDb, tables } from './test-support.js';

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
  await db.delete(tables.jobOperations);
});

const wake = vi.fn();
const ops = createJobOps({ tables, retention: resolveRetention(undefined), wake });
const noArchive = createJobOps({
  tables,
  retention: resolveRetention({ archive: { dead: false } }),
  wake,
});
const alice = { actor: 'alice', reason: 'test' } as const;
const DAY = 86_400_000;

type Insert = typeof tables.jobs.$inferInsert;

const queueRow = async (extra?: Partial<Insert>): Promise<string> => {
  const id = jobId();
  await db.insert(tables.jobs).values({ id, kind: 'queue', jobName: 'demo', args: { n: 1 }, ...extra });
  return id;
};
const deadRow = (extra?: Partial<Insert>) =>
  queueRow({ attempts: 8, lastError: 'boom', deadAt: new Date(Date.now() - 40 * DAY), ...extra });
const runningRow = () => queueRow({ leaseToken: 'tok', leaseUntil: new Date(Date.now() + 60_000), attempts: 1 });

const rowOf = async (id: string) => (await db.select().from(tables.jobs).where(eq(tables.jobs.id, id)))[0];
const operations = () => db.select().from(tables.jobOperations);
const attemptsOf = (id: string) => db.select().from(tables.jobAttempts).where(eq(tables.jobAttempts.jobId, id));
const addAttempt = (id: string, attempt: number, startedAt: Date, outcome: 'retry' | 'dead', error: string) =>
  db.insert(tables.jobAttempts).values({
    id: attemptId(),
    jobId: id,
    attempt,
    startedAt,
    finishedAt: new Date(startedAt.getTime() + 1000),
    outcome,
    error,
  });

describe('job states and reads', () => {
  it('computes ready, delayed, running and dead from the database clock on every row, so a list never shows a stale state', async () => {
    const ready = await queueRow();
    const delayed = await queueRow({ availableAt: new Date(Date.now() + 3_600_000) });
    const running = await runningRow();
    const expiredLease = await queueRow({ leaseToken: 'old', leaseUntil: new Date(Date.now() - 60_000) });
    const dead = await deadRow();

    const { jobs: all } = await ops.jobs(db, { status: 'all' });
    expect(Object.fromEntries(all.map(row => [row.id, row.state]))).toEqual({
      [ready]: 'ready',
      [delayed]: 'delayed',
      [running]: 'running',
      [expiredLease]: 'ready',
      [dead]: 'dead',
    });
    const idsOf = async (status: 'pending' | 'ready' | 'delayed' | 'running' | 'dead') =>
      (await ops.jobs(db, { status })).jobs.map(row => row.id).sort();
    expect(await idsOf('pending')).toEqual([ready, delayed, running, expiredLease].sort());
    expect(await idsOf('ready')).toEqual([ready, expiredLease].sort());
    expect(await idsOf('delayed')).toEqual([delayed]);
    expect(await idsOf('running')).toEqual([running]);
    expect(await idsOf('dead')).toEqual([dead]);
    expect((await ops.jobs(db)).jobs.map(row => row.state)).not.toContain('dead');
  });

  it('jobCounts groups by name and counts each state once', async () => {
    await queueRow();
    await queueRow({ availableAt: new Date(Date.now() + 3_600_000) });
    await runningRow();
    const deadAt = new Date(Date.now() - 2 * DAY);
    await deadRow({ deadAt });
    await deadRow({ jobName: 'other' });
    const counts = await ops.jobCounts(db);
    expect(counts).toEqual([
      { kind: 'queue', name: 'demo', ready: 1, delayed: 1, running: 1, dead: 1, oldestDeadAt: deadAt },
      { kind: 'queue', name: 'other', ready: 0, delayed: 0, running: 0, dead: 1, oldestDeadAt: expect.any(Date) },
    ]);
  });

  it('job returns the row, its attempts oldest first and the operations that touched it', async () => {
    const id = await deadRow();
    await addAttempt(id, 2, new Date('2026-01-02T00:00:00Z'), 'dead', 'second');
    await addAttempt(id, 1, new Date('2026-01-01T00:00:00Z'), 'retry', 'first');
    await ops.retry(db, id, alice);
    const detail = await ops.job(db, id);
    expect(detail).toMatchObject({ id, state: 'ready', event: null });
    expect(detail?.attemptLog.map(a => a.error)).toEqual(['first', 'second']);
    expect(detail?.operations.map(o => [o.action, o.actor])).toEqual([['retry', 'alice']]);
    expect(await ops.job(db, 'job_missing')).toBeUndefined();
  });

  it('refuses a limit outside 1 to 200 with BAD_ARGUMENT, so one call cannot read the whole table', async () => {
    await expect(ops.jobs(db, { limit: 201 })).rejects.toMatchObject({ code: 'BAD_ARGUMENT' });
    await expect(ops.jobs(db, { limit: 0 })).rejects.toMatchObject({ code: 'BAD_ARGUMENT' });
    await expect(ops.archivedJobs(db, { limit: 201 })).rejects.toMatchObject({ code: 'BAD_ARGUMENT' });
  });

  it('cursor paging has no gaps or repeats, even for rows that share a millisecond and differ in microseconds', async () => {
    const ids: string[] = [];
    for (let n = 0; n < 7; n++) ids.push(await queueRow());
    // Three rows in one millisecond, apart by microseconds; the rest on distinct seconds.
    await db.execute(
      sql`update ${tables.jobs} set available_at = '2026-01-01 00:00:00.123456+00' where id = ${ids[0]}`,
    );
    await db.execute(
      sql`update ${tables.jobs} set available_at = '2026-01-01 00:00:00.123789+00' where id = ${ids[1]}`,
    );
    await db.execute(
      sql`update ${tables.jobs} set available_at = '2026-01-01 00:00:00.123100+00' where id = ${ids[2]}`,
    );
    for (const [n, id] of ids.slice(3).entries()) {
      await db.execute(
        sql`update ${tables.jobs} set available_at = ${`2026-01-02 00:00:0${n}+00`}::timestamptz where id = ${id}`,
      );
    }
    const seen: string[] = [];
    let after: string | undefined;
    do {
      const page = await ops.jobs(db, { status: 'all', limit: 2, after });
      seen.push(...page.jobs.map(row => row.id));
      after = page.next ?? undefined;
    } while (after !== undefined);
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(7);
  });

  it('a bad cursor is BAD_ARGUMENT, on every paged read', async () => {
    const notBase64Json = 'not-a-cursor';
    const wrongShape = Buffer.from(JSON.stringify({ at: 1 })).toString('base64url');
    const badTime = Buffer.from(JSON.stringify(['yesterday', 'job_x'])).toString('base64url');
    for (const after of [notBase64Json, wrongShape, badTime, '']) {
      await expect(ops.jobs(db, { after })).rejects.toMatchObject({ code: 'BAD_ARGUMENT' });
      await expect(ops.archivedJobs(db, { after })).rejects.toMatchObject({ code: 'BAD_ARGUMENT' });
      await expect(ops.jobOperations(db, { after })).rejects.toMatchObject({ code: 'BAD_ARGUMENT' });
    }
  });

  it('dead jobs page newest first by dead_at', async () => {
    const old = await deadRow({ deadAt: new Date(Date.now() - 50 * DAY) });
    const mid = await deadRow({ deadAt: new Date(Date.now() - 45 * DAY) });
    const fresh = await deadRow({ deadAt: new Date(Date.now() - 40 * DAY) });
    const first = await ops.jobs(db, { status: 'dead', limit: 2 });
    expect(first.jobs.map(row => row.id)).toEqual([fresh, mid]);
    expect(first.next).not.toBeNull();
    const second = await ops.jobs(db, { status: 'dead', limit: 2, after: first.next ?? undefined });
    expect(second.jobs.map(row => row.id)).toEqual([old]);
    expect(second.next, 'the last page has no cursor').toBeNull();
  });
});

describe('retry', () => {
  it('moves a dead job back to pending under the same id, keeps its earlier attempts and wakes the workers', async () => {
    const id = await deadRow();
    await addAttempt(id, 1, new Date('2026-01-01T00:00:00Z'), 'dead', 'boom');
    wake.mockClear();
    const { operationId } = await ops.retry(db, id, alice);
    expect(await rowOf(id)).toMatchObject({ deadAt: null, attempts: 0, lastError: null, leaseToken: null });
    expect(await attemptsOf(id)).toHaveLength(1);
    expect(await operations()).toMatchObject([
      { id: operationId, action: 'retry', actor: 'alice', reason: 'test', jobIds: [id], count: 1 },
    ]);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('refuses a live job with JOB_NOT_DEAD and writes no operation row', async () => {
    const id = await queueRow();
    await expect(ops.retry(db, id, alice)).rejects.toMatchObject({ code: 'JOB_NOT_DEAD' });
    await expect(ops.retry(db, 'job_missing', alice)).rejects.toThrow('not a dead job');
    expect(await operations()).toEqual([]);
  });

  it('needs an actor, so no operation is anonymous', async () => {
    const id = await deadRow();
    await expect(ops.retry(db, id, { actor: ' ' })).rejects.toMatchObject({ code: 'BAD_ARGUMENT' });
    expect((await rowOf(id))?.deadAt).toBeInstanceOf(Date);
  });
});

describe('discard and cancel', () => {
  it('discard and cancel archive with their outcome, so nothing an operator removed is gone', async () => {
    const dead = await deadRow({ dedupeKey: 'k1' });
    await addAttempt(dead, 1, new Date('2026-01-01T00:00:00Z'), 'dead', 'boom');
    const waiting = await queueRow();
    const discarded = await ops.discard(db, dead, alice);
    const cancelled = await ops.cancel(db, waiting, { actor: 'bob' });

    expect(await rowOf(dead)).toBeUndefined();
    expect(await rowOf(waiting)).toBeUndefined();
    expect(await attemptsOf(dead)).toEqual([]);
    const { jobs: archive } = await ops.archivedJobs(db);
    expect(archive.map(row => [row.id, row.outcome])).toEqual(
      expect.arrayContaining([
        [dead, 'discarded'],
        [waiting, 'cancelled'],
      ]),
    );
    const archivedDead = await ops.archivedJob(db, dead);
    expect(archivedDead).toMatchObject({ jobName: 'demo', dedupeKey: 'k1', attempts: 8, lastError: 'boom' });
    expect(archivedDead?.keepUntil?.getTime()).toBeGreaterThan(Date.now() + 80 * DAY);
    expect((await operations()).map(o => [o.id, o.action, o.actor, o.jobIds]).sort()).toEqual(
      [
        [discarded.operationId, 'discard', 'alice', [dead]],
        [cancelled.operationId, 'cancel', 'bob', [waiting]],
      ].sort(),
    );
  });

  it('discard deletes without an archive row when the policy keeps no dead jobs, and still records the operation', async () => {
    const id = await deadRow();
    await noArchive.discard(db, id, alice);
    expect(await rowOf(id)).toBeUndefined();
    expect(await ops.archivedJob(db, id)).toBeUndefined();
    expect(await operations()).toHaveLength(1);
  });

  it('discard refuses a live job with JOB_NOT_DEAD and leaves it alone', async () => {
    const id = await queueRow();
    await expect(ops.discard(db, id, alice)).rejects.toMatchObject({ code: 'JOB_NOT_DEAD' });
    expect(await rowOf(id)).toBeDefined();
    expect(await operations()).toEqual([]);
  });

  it('cancel refuses a leased job with JOB_RUNNING and a dead one with JOB_NOT_PENDING', async () => {
    const running = await runningRow();
    const dead = await deadRow();
    await expect(ops.cancel(db, running, alice)).rejects.toMatchObject({ code: 'JOB_RUNNING' });
    await expect(ops.cancel(db, dead, alice)).rejects.toMatchObject({ code: 'JOB_NOT_PENDING' });
    await expect(ops.cancel(db, 'job_missing', alice)).rejects.toMatchObject({ code: 'JOB_NOT_PENDING' });
    expect(await rowOf(running)).toBeDefined();
    expect(await rowOf(dead)).toBeDefined();
    expect(await operations()).toEqual([]);
  });

  it('cancel takes a job whose lease expired (its worker is gone) and folds the open attempt as superseded', async () => {
    const id = await queueRow({ leaseToken: 'old', leaseUntil: new Date(Date.now() - 60_000), attempts: 1 });
    await db.insert(tables.jobAttempts).values({ id: attemptId(), jobId: id, attempt: 1 });
    await ops.cancel(db, id, alice);
    const archived = await ops.archivedJob(db, id);
    expect(archived?.attemptLog).toMatchObject([{ attempt: 1, outcome: 'superseded' }]);
  });
});

describe('retryDead', () => {
  it('retries the selected ids in one transaction with one operation row', async () => {
    const a = await deadRow();
    const b = await deadRow();
    const result = await ops.retryDead(db, { ids: [a, b, a] }, alice);
    expect([...result.ids].sort()).toEqual([a, b].sort());
    expect((await rowOf(a))?.deadAt).toBeNull();
    expect((await rowOf(b))?.deadAt).toBeNull();
    expect(await operations()).toMatchObject([{ id: result.operationId, action: 'retryDead', count: 2 }]);
  });

  it('is all-or-nothing: one live id in the selection retries none and writes no operation row', async () => {
    const dead = await deadRow();
    const live = await queueRow();
    await expect(ops.retryDead(db, { ids: [dead, live] }, alice)).rejects.toMatchObject({ code: 'JOB_NOT_DEAD' });
    expect((await rowOf(dead))?.deadAt).toBeInstanceOf(Date);
    expect(await operations()).toEqual([]);
  });

  it('by filter retries the oldest dead jobs first, up to the limit, and only those matching', async () => {
    const oldest = await deadRow({ deadAt: new Date(Date.now() - 60 * DAY) });
    const older = await deadRow({ deadAt: new Date(Date.now() - 50 * DAY) });
    const newer = await deadRow({ deadAt: new Date(Date.now() - 40 * DAY) });
    const other = await deadRow({ jobName: 'other', deadAt: new Date(Date.now() - 70 * DAY) });
    const result = await ops.retryDead(db, { job: 'demo', limit: 2 }, alice);
    expect([...result.ids].sort()).toEqual([oldest, older].sort());
    expect((await rowOf(newer))?.deadAt).toBeInstanceOf(Date);
    expect((await rowOf(other))?.deadAt).toBeInstanceOf(Date);
    const before = await ops.retryDead(db, { job: 'demo', deadBefore: new Date(Date.now() - 100 * DAY) }, alice);
    expect(before).toEqual({ ids: [], operationId: null });
    expect(await operations()).toHaveLength(1);
  });

  it('refuses an empty selection or more than 500 ids with BAD_ARGUMENT', async () => {
    await expect(ops.retryDead(db, { ids: [] }, alice)).rejects.toMatchObject({ code: 'BAD_ARGUMENT' });
    const many = Array.from({ length: 501 }, (_, n) => `job_${n}`);
    await expect(ops.retryDead(db, { ids: many }, alice)).rejects.toMatchObject({ code: 'BAD_ARGUMENT' });
    await expect(ops.retryDead(db, { limit: 501 }, alice)).rejects.toMatchObject({ code: 'BAD_ARGUMENT' });
  });
});

describe('purgeDead', () => {
  it('purgeDead archives or deletes per policy and reports both counts', async () => {
    const a = await deadRow({ deadAt: new Date(Date.now() - 60 * DAY) });
    const b = await deadRow({ deadAt: new Date(Date.now() - 50 * DAY) });
    const recent = await deadRow({ deadAt: new Date(Date.now() - 10 * DAY) });
    const live = await queueRow();
    const bound = new Date(Date.now() - 31 * DAY);

    const kept = await ops.purgeDead(db, { olderThan: bound }, { actor: 'system:retention' });
    expect(kept).toMatchObject({ archived: 2, deleted: 0 });
    expect(await ops.archivedJob(db, a)).toMatchObject({ outcome: 'dead' });
    expect((await ops.archivedJob(db, b))?.finishedAt.getTime()).toBeLessThan(Date.now() - 49 * DAY);
    expect(await rowOf(recent)).toBeDefined();
    expect(await rowOf(live)).toBeDefined();

    const c = await deadRow({ deadAt: new Date(Date.now() - 60 * DAY) });
    const dropped = await noArchive.purgeDead(db, { olderThan: bound }, alice);
    expect(dropped).toMatchObject({ archived: 0, deleted: 1 });
    expect(await ops.archivedJob(db, c)).toBeUndefined();

    const rows = await operations();
    expect(rows.map(o => [o.action, o.count]).sort()).toEqual([
      ['purgeDead', 1],
      ['purgeDead', 2],
    ]);
    expect(rows.find(o => o.id === kept.operationId)?.jobIds).toEqual(expect.arrayContaining([a, b]));
  });

  it('refuses a bound shorter than retryableFor with BAD_ARGUMENT, so a job an operator may still retry is never taken', async () => {
    const id = await deadRow();
    await expect(ops.purgeDead(db, { olderThan: new Date(Date.now() - 5 * DAY) }, alice)).rejects.toMatchObject({
      code: 'BAD_ARGUMENT',
    });
    await expect(ops.purgeDead(db, { olderThan: new Date(Date.now() + DAY) }, alice)).rejects.toMatchObject({
      code: 'BAD_ARGUMENT',
    });
    expect(await rowOf(id)).toBeDefined();
  });

  it('respects the limit and writes no operation row when nothing was purged', async () => {
    await deadRow({ deadAt: new Date(Date.now() - 60 * DAY) });
    await deadRow({ deadAt: new Date(Date.now() - 61 * DAY) });
    const bound = new Date(Date.now() - 31 * DAY);
    expect(await ops.purgeDead(db, { olderThan: bound, limit: 1 }, alice)).toMatchObject({ archived: 1 });
    expect(await ops.purgeDead(db, { olderThan: bound, limit: 5 }, alice)).toMatchObject({ archived: 1 });
    expect(await ops.purgeDead(db, { olderThan: bound }, alice)).toEqual({
      archived: 0,
      deleted: 0,
      operationId: null,
    });
    expect(await operations()).toHaveLength(2);
  });
});

describe('replay', () => {
  it('replay creates a new job with replay_of and a new id, and refuses when the dedupe key is live', async () => {
    const original = await deadRow({ dedupeKey: 'k1', priority: 3, args: { n: 9 } });
    await ops.discard(db, original, alice);

    const { jobId: replayId, operationId } = await ops.replayJob(db, original, { actor: 'carol', reason: 'again' });
    expect(replayId).not.toBe(original);
    expect(await rowOf(replayId)).toMatchObject({
      kind: 'queue',
      jobName: 'demo',
      args: { n: 9 },
      dedupeKey: 'k1',
      priority: 3,
      attempts: 0,
      deadAt: null,
      replayOf: original,
    });
    expect(await ops.archivedJob(db, original)).toBeDefined();
    const row = (await operations()).find(o => o.id === operationId);
    expect(row).toMatchObject({ action: 'replay', actor: 'carol', reason: 'again', count: 1 });
    expect(row?.jobIds).toEqual([original, replayId]);

    await expect(ops.replayJob(db, original, alice)).rejects.toMatchObject({ code: 'JOB_EXISTS' });
    expect((await ops.jobs(db, { status: 'all' })).jobs.length).toBe(1);
    expect(await operations()).toHaveLength(2);
  });

  it('an unknown archived id is BAD_ARGUMENT', async () => {
    await expect(ops.replayJob(db, 'job_missing', alice)).rejects.toMatchObject({ code: 'BAD_ARGUMENT' });
  });
});

describe('the archive reads', () => {
  it('archivedJobs pages newest first and archivedJob folds the attempt log', async () => {
    const ids: string[] = [];
    for (let n = 0; n < 3; n++) {
      const id = await deadRow({ jobName: n === 1 ? 'other' : 'demo' });
      await addAttempt(id, 1, new Date('2026-01-01T00:00:00Z'), 'retry', `try-1-${n}`);
      await addAttempt(id, 2, new Date('2026-01-01T00:05:00Z'), 'dead', `try-2-${n}`);
      await ops.discard(db, id, alice);
      ids.push(id);
    }
    const first = await ops.archivedJobs(db, { limit: 2 });
    expect(first.jobs.map(row => row.id)).toEqual([ids[2], ids[1]]);
    const rest = await ops.archivedJobs(db, { limit: 2, after: first.next ?? undefined });
    expect(rest.jobs.map(row => row.id)).toEqual([ids[0]]);
    expect((await ops.archivedJobs(db, { job: 'other' })).jobs.map(row => row.id)).toEqual([ids[1]]);
    expect((await ops.archivedJobs(db, { outcome: 'completed' })).jobs).toEqual([]);

    const archived = await ops.archivedJob(db, ids[0] ?? '');
    expect(archived?.attemptLog).toMatchObject([
      { attempt: 1, outcome: 'retry', error: 'try-1-0' },
      { attempt: 2, outcome: 'dead', error: 'try-2-0' },
    ]);
    expect(await ops.archivedJob(db, 'job_missing')).toBeUndefined();
  });

  it('archiveStatus counts rows and the ones past keep_until; with no sink nothing is waiting to export', async () => {
    const id = await deadRow();
    await ops.discard(db, id, alice);
    expect(await ops.archiveStatus(db)).toEqual({ rows: 1, unexported: 0, oldestUnexportedAt: null, pastKeepUntil: 0 });
    await db.update(tables.jobArchive).set({ keepUntil: new Date(Date.now() - 1000) });
    expect(await ops.archiveStatus(db)).toMatchObject({ rows: 1, pastKeepUntil: 1 });
  });

  it('jobOperations lists newest first and filters by job', async () => {
    const a = await deadRow();
    const b = await deadRow();
    await ops.retry(db, a, alice);
    await ops.discard(db, b, alice);
    const all = (await ops.jobOperations(db)).operations;
    expect(all.map(o => o.action)).toEqual(['discard', 'retry']);
    expect((await ops.jobOperations(db, { jobId: a })).operations.map(o => o.action)).toEqual(['retry']);
  });
});

describe('operation rows', () => {
  it('every mutating verb writes exactly one operation row, in the same transaction as its change', async () => {
    const retried = await deadRow();
    const discarded = await deadRow();
    const waiting = await queueRow();
    const batchA = await deadRow();
    const batchB = await deadRow();
    const purged = await deadRow({ deadAt: new Date(Date.now() - 60 * DAY) });

    const steps: readonly [string, () => Promise<unknown>][] = [
      ['retry', () => ops.retry(db, retried, alice)],
      ['discard', () => ops.discard(db, discarded, alice)],
      ['cancel', () => ops.cancel(db, waiting, alice)],
      ['retryDead', () => ops.retryDead(db, { ids: [batchA, batchB] }, alice)],
      ['purgeDead', () => ops.purgeDead(db, { olderThan: new Date(Date.now() - 31 * DAY), limit: 1 }, alice)],
      ['replay', () => ops.replayJob(db, discarded, alice)],
    ];
    expect(purged).toBeDefined();
    for (const [action, run] of steps) {
      const before = (await operations()).length;
      await run();
      const rows = await operations();
      expect(rows.length, action).toBe(before + 1);
      expect(
        rows.filter(o => o.action === action),
        action,
      ).toHaveLength(1);
    }
  });

  it('a caller transaction that fails after a verb rolls back the change and its operation row together', async () => {
    const id = await deadRow();
    await expect(
      db.transaction(async tx => {
        await ops.retry(tx, id, alice);
        throw new Error('later step failed');
      }),
    ).rejects.toThrow('later step failed');
    expect((await rowOf(id))?.deadAt).toBeInstanceOf(Date);
    expect(await operations()).toEqual([]);
  });

  it('inside a caller transaction the verb does not wake: the caller wakes after its own commit', async () => {
    const id = await deadRow();
    wake.mockClear();
    await db.transaction(tx => ops.retry(tx, id, alice));
    expect(wake).not.toHaveBeenCalled();
  });
});
