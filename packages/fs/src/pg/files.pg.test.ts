/**
 * Races on a real Postgres (Docker). Run with `bun run test:pg`; without Docker
 * the container start throws and the file fails. It is never skipped.
 *
 * G6: a ready row never points at an object this library deleted, so confirm
 * and the sweep (or a remove) can never both win.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { defineId } from '@arki/contracts';
import { isFailure, orThrow } from '@arki/failure';

import type { FileId } from '../files/index.js';
import type { FilesDb, FileStorage } from './index.js';
import { FileWrongState, isFileStorageError } from '../files/index.js';
import { memoryUploadAdapter } from '../testing.js';
import { filesTable, fileStorage } from './index.js';

const userId = defineId('usr_');
const files = filesTable({ owner: userId });
const alice = orThrow(userId.create());
const hello = new TextEncoder().encode('hello');

let container: StartedPostgreSqlContainer;
let poolA: pg.Pool;
let poolB: pg.Pool;
let dbA: FilesDb;
let dbB: FilesDb;
let storageA: FileStorage<typeof files>;
let storageB: FileStorage<typeof files>;

const adapter = memoryUploadAdapter();
const options = { files, bucket: 'uploads', limits: { maxSize: 100, allowedMime: ['text/plain'] } };

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  const connectionString = container.getConnectionUri();
  poolA = new pg.Pool({ connectionString, max: 4 });
  poolB = new pg.Pool({ connectionString, max: 4 });
  dbA = drizzle({ client: poolA });
  dbB = drizzle({ client: poolB });
  const { apply } = await pushSchema({ files }, drizzle({ client: poolA }));
  await apply();
  storageA = fileStorage(dbA, adapter, options);
  storageB = fileStorage(dbB, adapter, options);
}, 120_000);

afterAll(async () => {
  await poolA.end();
  await poolB.end();
  await container.stop();
});

async function uploaded(): Promise<FileId> {
  const ticket = orThrow(await storageA.createUpload(alice, { mime: 'text/plain', size: hello.byteLength }));
  expect(await adapter.browserPut(ticket.url, hello, ticket.headers)).toHaveProperty('status', 200);
  return ticket.fileId;
}

async function statusOf(id: FileId) {
  const [row] = await dbA.select({ status: files.status }).from(files).where(eq(files.id, id));
  return row?.status;
}

/** G6, checked over the given rows: ready means the object is still there. */
async function expectNoReadyRowWithoutObject(ids: readonly FileId[]) {
  for (const id of ids) {
    if ((await statusOf(id)) === 'ready') expect(await adapter.exists(`files/${id}`)).toBe(true);
  }
}

describe('sweep', () => {
  it('two sweepers on separate connections remove each orphan exactly once', async () => {
    const deletes = new Map<string, number>();
    const counting = {
      ...adapter,
      delete: (key: string) => {
        deletes.set(key, (deletes.get(key) ?? 0) + 1);
        return adapter.delete(key);
      },
    };
    const sweepA = fileStorage(dbA, counting, options);
    const sweepB = fileStorage(dbB, counting, options);

    const ids: FileId[] = [];
    for (let index = 0; index < 40; index += 1) ids.push(await uploaded());
    await dbA
      .update(files)
      .set({ cleanupAt: sql`now() - interval '1 second'` })
      .where(eq(files.status, 'pending'));

    const drain = async (storage: FileStorage<typeof files>) => {
      let removed = 0;
      for (;;) {
        const result = await storage.cleanupOrphans({ batch: 5 });
        removed += result.removed;
        if (!result.more) return removed;
      }
    };
    const [removedA, removedB] = await Promise.all([drain(sweepA), drain(sweepB)]);

    expect(removedA + removedB).toBe(40);
    for (const id of ids) {
      expect(deletes.get(`files/${id}`)).toBe(1);
      expect(await statusOf(id)).toBeUndefined();
    }
  });

  it('uses files_sweep_idx for its predicate', async () => {
    // Many ready rows and no due ones: the partial index is the only cheap path.
    const bulk = sql`select 'fil_bulk' || g, ${alice}, 'uploads', 'files/fil_bulk' || g, 'text/plain', 1, 'ready', now(), now() from generate_series(1, 20000) g`;
    await dbA.execute(
      sql`insert into files (id, owner_id, bucket, key, mime, size, status, expires_at, confirmed_at) ${bulk}`,
    );
    await dbA.execute(sql`analyze files`);
    const plan = await poolA.query<{ 'QUERY PLAN': string }>(
      `explain select id from files where bucket = 'uploads' and status <> 'ready' and cleanup_at <= now()
       order by cleanup_at, id limit 100 for update skip locked`,
    );
    expect(plan.rows.map(row => row['QUERY PLAN']).join('\n')).toContain('files_sweep_idx');
  });
});

describe('confirm races', () => {
  // A sweep claim that commits while confirm waits on the row lock: confirm re-checks
  // `cleanup_at > now()` on the new row version under READ COMMITTED and loses.
  it('a confirm blocked behind a sweep claim loses with FileWrongState', async () => {
    const id = await uploaded();
    const holder = await poolB.connect();
    try {
      await holder.query('begin');
      await holder.query(
        `update files set status = 'deleting', cleanup_attempts = cleanup_attempts + 1,
         cleanup_at = now() + interval '1 minute' where id = $1`,
        [id],
      );
      const confirm = storageA.confirmUpload(alice, id).then(
        value => (isFailure(value) ? value.code : 'won'),
        (error: unknown) => (isFileStorageError(error) ? error.code : error),
      );
      // Wait until confirm's UPDATE is queued on the row lock.
      for (let tries = 0; tries < 100; tries += 1) {
        const waiting = await poolA.query(`select 1 from pg_stat_activity where wait_event_type = 'Lock'`);
        if (waiting.rowCount) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      await holder.query('commit');
      expect(await confirm).toBe(FileWrongState.code);
      expect(await statusOf(id)).toBe('deleting');
    } finally {
      holder.release();
    }
  });

  it('confirm and the sweep at the deadline: exactly one wins for every row', async () => {
    const ids: FileId[] = [];
    for (let index = 0; index < 30; index += 1) ids.push(await uploaded());
    for (const id of ids) {
      await dbA
        .update(files)
        .set({ cleanupAt: sql`now() + interval '150 milliseconds'` })
        .where(eq(files.id, id));
    }
    await new Promise(resolve => setTimeout(resolve, 150));

    const confirms = ids.map(id =>
      storageA.confirmUpload(alice, id).then(
        value => (isFailure(value) ? value.code : 'won'),
        (error: unknown) => (isFileStorageError(error) ? error.code : error),
      ),
    );
    const sweep = (async () => {
      for (;;) {
        const result = await storageB.cleanupOrphans({ batch: 7 });
        if (!result.more) return;
      }
    })();
    const outcomes = await Promise.all(confirms);
    await sweep;
    await storageB.cleanupOrphans({ batch: 1000 });

    for (const [index, id] of ids.entries()) {
      const status = await statusOf(id);
      if (outcomes[index] === 'won') {
        expect(status).toBe('ready');
        expect(await adapter.exists(`files/${id}`)).toBe(true);
      } else {
        expect(outcomes[index]).toBe(FileWrongState.code);
        expect(status).toBeUndefined();
        expect(await adapter.exists(`files/${id}`)).toBe(false);
      }
    }
    await expectNoReadyRowWithoutObject(ids);
  });

  it('confirm and remove in parallel never leave a ready row without its object', async () => {
    const ids: FileId[] = [];
    for (let index = 0; index < 20; index += 1) ids.push(await uploaded());
    await Promise.all(
      ids.flatMap(id => [
        storageA.confirmUpload(alice, id).catch((error: unknown) => error),
        storageB.remove(alice, id).catch((error: unknown) => error),
      ]),
    );
    for (const id of ids) expect(await statusOf(id)).not.toBe('ready');
    await expectNoReadyRowWithoutObject(ids);
  });
});
