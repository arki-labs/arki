/**
 * The retention sweeper on real Postgres with two connections: `SKIP LOCKED` is only visible when a second
 * transaction holds a row lock while the first one runs, which PGlite (one connection) cannot show.
 * Needs Docker: starts a `postgres:16` container through testcontainers, as `http.pg.test.ts` does.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeLog } from '@arki/log/testing';

import type { ArchivedJob, ArchiveSink, JobRetention } from './retention.js';
import { jobId } from './id.js';
import { createJobOps } from './outbox.js';
import { journalTables } from './pg.js';
import { resolveRetention } from './retention.js';
import { j } from './test-support.js';

const tables = journalTables();
let container: StartedPostgreSqlContainer;
let poolA: pg.Pool;
let poolB: pg.Pool;
let dbA: ReturnType<typeof drizzle>;
let dbB: ReturnType<typeof drizzle>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  poolA = new pg.Pool({ connectionString: container.getConnectionUri(), max: 4 });
  poolB = new pg.Pool({ connectionString: container.getConnectionUri(), max: 4 });
  dbA = drizzle({ client: poolA });
  dbB = drizzle({ client: poolB });
  const { apply } = await pushSchema({ ...tables }, dbA);
  await apply();
}, 120_000);

afterAll(async () => {
  await poolA.end();
  await poolB.end();
  await container.stop();
});

beforeEach(async () => {
  await dbA.delete(tables.jobs);
  await dbA.delete(tables.jobArchive);
  await dbA.delete(tables.jobOperations);
});

const DAY = 86_400_000;
const ops = (retention?: JobRetention) =>
  createJobOps({ tables, retention: resolveRetention(retention), wake: vi.fn() });

/** A sink that remembers every batch it was given. `failures` is how many writes throw (after recording) before it works. */
function recordingSink(failures = 0) {
  const batches: ArchivedJob[][] = [];
  let left = failures;
  const sink: ArchiveSink = {
    name: 'test',
    write: async rows => {
      batches.push([...rows]);
      if (left > 0) {
        left -= 1;
        throw new Error('sink is down');
      }
    },
  };
  return { sink, batches, ids: () => batches.flat().map(row => row.id) };
}

type ArchiveInsert = typeof tables.jobArchive.$inferInsert;
const archiveRow = async (extra?: Partial<ArchiveInsert>): Promise<string> => {
  const id = jobId();
  await dbA.insert(tables.jobArchive).values({
    id,
    kind: 'queue',
    jobName: 'demo',
    priority: 0,
    enqueuedAt: new Date(Date.now() - 2 * DAY),
    attempts: 1,
    outcome: 'completed',
    finishedAt: new Date(Date.now() - DAY),
    ...extra,
  });
  return id;
};
const deadJob = async (): Promise<string> => {
  const id = jobId();
  await dbA.insert(tables.jobs).values({
    id,
    kind: 'queue',
    jobName: 'demo',
    args: { n: 1 },
    attempts: 8,
    lastError: 'boom',
    deadAt: new Date(Date.now() - 40 * DAY),
  });
  return id;
};
const archiveIds = async () => (await dbA.select({ id: tables.jobArchive.id }).from(tables.jobArchive)).map(r => r.id);
const operations = () => dbA.select().from(tables.jobOperations);
const past = new Date(Date.now() - DAY);

/** Hold a row lock on `ids` from another connection until `release()`. */
async function lockRows(table: 'jobs' | 'jobArchive', ids: readonly string[]) {
  const client = await poolB.connect();
  const target = table === 'jobs' ? 'journal_jobs' : 'journal_job_archive';
  await client.query('BEGIN');
  await client.query(`SELECT id FROM ${target} WHERE id = ANY($1) FOR UPDATE`, [ids]);
  return {
    release: async () => {
      await client.query('ROLLBACK');
      client.release();
    },
  };
}

describe('the sweep verbs on two connections', () => {
  it('two workers sweep the same backlog without touching the same row (SKIP LOCKED)', async () => {
    const dead = await Promise.all(Array.from({ length: 12 }, deadJob));
    const held = dead.slice(0, 4);
    const lock = await lockRows('jobs', held);
    const sweeper = ops();
    // The other connection holds 4 rows. A plain FOR UPDATE would wait for it; SKIP LOCKED goes past.
    const first = await sweeper.purgeDead(
      dbA,
      { olderThan: new Date(Date.now() - 31 * DAY), limit: 100 },
      { actor: 'worker-a' },
    );
    expect(first).toMatchObject({ archived: 8, deleted: 0 });
    expect(await archiveIds()).toEqual(expect.not.arrayContaining(held));
    await lock.release();
    const second = await sweeper.purgeDead(
      dbB,
      { olderThan: new Date(Date.now() - 31 * DAY), limit: 100 },
      { actor: 'worker-b' },
    );
    expect(second).toMatchObject({ archived: 4 });

    // And both at once over a fresh backlog: every row archived exactly once, the two operations' ids disjoint.
    const more = await Promise.all(Array.from({ length: 40 }, deadJob));
    await dbA.delete(tables.jobOperations);
    const olderThan = new Date(Date.now() - 31 * DAY);
    await Promise.all([
      sweeper.purgeDead(dbA, { olderThan, limit: 25 }, { actor: 'worker-a' }),
      sweeper.purgeDead(dbB, { olderThan, limit: 25 }, { actor: 'worker-b' }),
    ]);
    await sweeper.purgeDead(dbA, { olderThan, limit: 100 }, { actor: 'worker-a' });
    const touched = (await operations()).flatMap(op => op.jobIds);
    expect(touched).toHaveLength(40);
    expect(new Set(touched)).toEqual(new Set(more));
    expect((await archiveIds()).length).toBe(52);
  });

  it('exportArchive sends each row at least once and never prunes an unexported row while a sink exists', async () => {
    const { sink, batches, ids } = recordingSink(1);
    const sweeper = ops({ archive: { sink } });
    const rows = await Promise.all([archiveRow({ keepUntil: past }), archiveRow({ keepUntil: past })]);

    // The first write records the batch and then throws: the batch was sent, and must be sent again.
    expect(await sweeper.exportArchive(dbA)).toMatchObject({ exported: 0, failed: true });
    expect(await sweeper.pruneArchive(dbA)).toMatchObject({ pruned: 0, operationId: null });
    expect(await archiveIds()).toHaveLength(2);

    expect(await sweeper.exportArchive(dbA)).toMatchObject({ exported: 2, failed: false });
    expect(batches).toHaveLength(2);
    for (const id of rows) expect(ids().filter(seen => seen === id)).toHaveLength(2);

    // Only now does the expired row go.
    expect(await sweeper.pruneArchive(dbA)).toMatchObject({ pruned: 2 });
    expect(await archiveIds()).toEqual([]);
  });

  it('exportArchive skips rows another connection holds, so two exporters never send the same row together', async () => {
    const { sink, ids } = recordingSink();
    const sweeper = ops({ archive: { sink } });
    const rows = await Promise.all(Array.from({ length: 6 }, () => archiveRow()));
    const lock = await lockRows('jobArchive', rows.slice(0, 2));
    expect(await sweeper.exportArchive(dbA)).toMatchObject({ exported: 4 });
    await lock.release();
    expect(await sweeper.exportArchive(dbB)).toMatchObject({ exported: 2 });
    expect(ids().toSorted()).toEqual(rows.toSorted());
  });

  it('a sink that throws leaves the batch unexported and the tick logs a warning', async () => {
    const { sink } = recordingSink(100);
    const sweeper = ops({ archive: { sink } });
    await archiveRow();
    using log = fakeLog();
    await sweeper.sweepOnce(dbA);
    log.assertLogged({ level: 'warn', category: 'arki:journal' });
    const [row] = await dbA.select().from(tables.jobArchive);
    expect(row?.exportedAt).toBeNull();
    expect(await sweeper.archiveStatus(dbA)).toMatchObject({ unexported: 1 });
  });

  it("'untilExported' rows are deleted only after export", async () => {
    const { sink, ids } = recordingSink();
    const sweeper = ops({ archive: { sink, completed: 'untilExported' } });
    // The row as the ack writes it for 'untilExported': keep_until is the archive time.
    const id = await archiveRow({ keepUntil: new Date() });
    expect(await sweeper.pruneArchive(dbA)).toMatchObject({ pruned: 0 });
    expect(await archiveIds()).toEqual([id]);
    await sweeper.exportArchive(dbA);
    expect(ids()).toEqual([id]);
    expect(await sweeper.pruneArchive(dbA)).toMatchObject({ pruned: 1 });
    expect(await archiveIds()).toEqual([]);
  });

  it('max keeps the newest N per name and deletes the oldest', async () => {
    const sweeper = ops({ archive: { dead: { age: 'forever', max: 2 } } });
    const at = (n: number) => new Date(Date.now() - n * 60_000);
    const dead = (jobName: string, n: number) => archiveRow({ jobName, outcome: 'dead', archivedAt: at(n) });
    const [a1, a2, a3, a4] = [await dead('a', 4), await dead('a', 3), await dead('a', 2), await dead('a', 1)];
    const [b1, b2] = [await dead('b', 3), await dead('b', 2)];
    // Another outcome of the same name is its own group, and `completed` has no cap.
    const cancelled = await archiveRow({ jobName: 'a', outcome: 'cancelled', archivedAt: at(9) });
    const completed = await Promise.all([1, 2, 3].map(n => archiveRow({ jobName: 'a', archivedAt: at(n) })));

    const result = await sweeper.pruneArchive(dbA);
    expect(result.pruned).toBe(2);
    const left = new Set(await archiveIds());
    expect(left.has(a1)).toBe(false);
    expect(left.has(a2)).toBe(false);
    for (const id of [a3, a4, b1, b2, cancelled, ...completed]) expect(left.has(id)).toBe(true);
  });

  it('every sweep step writes one operation row with actor system:retention, except pruneOperations', async () => {
    const { sink } = recordingSink();
    const sweeper = ops({ archive: { sink }, operations: 'forever' });
    const dead = await deadJob();
    const expired = await archiveRow({ keepUntil: past, exportedAt: past });
    await sweeper.sweepOnce(dbA);
    const rows = await operations();
    expect(rows.map(row => row.action).toSorted()).toEqual(['exportArchive', 'pruneArchive', 'purgeDead']);
    expect(new Set(rows.map(row => row.actor))).toEqual(new Set(['system:retention']));
    expect(rows.find(row => row.action === 'purgeDead')?.jobIds).toEqual([dead]);
    expect(rows.find(row => row.action === 'pruneArchive')?.jobIds).toEqual([expired]);
    // A tick with nothing to do writes nothing.
    await sweeper.sweepOnce(dbA);
    expect(await operations()).toHaveLength(3);

    // pruneOperations removes the operation rows past their keep and records nothing about doing so.
    const short = ops({ operations: 0.001 });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(await short.pruneOperations(dbA)).toEqual({ pruned: 3 });
    expect(await operations()).toEqual([]);
  });
});

describe('the worker sweeper', () => {
  it('the sweeper stops with the worker', async () => {
    const journal = j.compose({ retention: { sweep: { every: 0.02 } } });
    const archived = async (id: string) =>
      (await dbA.select({ id: tables.jobArchive.id }).from(tables.jobArchive).where(eq(tables.jobArchive.id, id)))
        .length;
    const worker = journal.worker(dbA, { pollMs: 60_000 });
    await worker.start();
    const first = await deadJob();
    await vi.waitFor(async () => expect(await archived(first)).toBe(1), { timeout: 5000 });
    await worker.stop();

    const second = await deadJob();
    await new Promise(resolve => setTimeout(resolve, 200));
    const left = await dbA
      .select({ id: tables.jobs.id })
      .from(tables.jobs)
      .where(inArray(tables.jobs.id, [second]));
    expect(left).toHaveLength(1);
  });

  it('retention.sweep false runs no tick', async () => {
    const journal = j.compose({ retention: { sweep: false } });
    const worker = journal.worker(dbA, { pollMs: 60_000 });
    await worker.start();
    const id = await deadJob();
    await new Promise(resolve => setTimeout(resolve, 150));
    await worker.stop();
    expect(
      await dbA
        .select()
        .from(tables.jobs)
        .where(sql`id = ${id}`),
    ).toHaveLength(1);
  });
});
