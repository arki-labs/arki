/**
 * The examples compile with the package (`tsconfig` includes `examples/`),
 * and the schedule handler really drains: it loops while the sweep says `more`.
 */
import type { PGlite } from '@electric-sql/pglite';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { defineRelations, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Locker } from '@arki/schedule';
import { initDbRuntimeLocal } from '@arki/db/runtime-local';
import { orThrow } from '@arki/failure';

import type { FilesDb, FileStorage } from './pg/index.js';
import { cleanupSchedule, drain, files, userId } from '../examples/files/server.js';
import { fileStorage } from './pg/index.js';
import { memoryUploadAdapter } from './testing.js';

let pglite: PGlite;
let db: FilesDb;
let storage: FileStorage<typeof files>;

beforeAll(async () => {
  const local = await initDbRuntimeLocal({ memory: true }, { relations: defineRelations({ files }) });
  pglite = local.pglite;
  db = local.db;
  const push = await pushSchema({ files }, local.db);
  await push.apply();
  storage = fileStorage(db, memoryUploadAdapter(), {
    files,
    bucket: 'uploads',
    limits: { maxSize: 10, allowedMime: ['*/*'] },
  });
});

afterAll(async () => {
  await pglite.close();
});

async function staleTickets(count: number) {
  for (let index = 0; index < count; index += 1) {
    const ticket = orThrow(await storage.createUpload(orThrow(userId.create()), { mime: 'text/plain', size: 1 }));
    await db
      .update(files)
      .set({ cleanupAt: sql`now() - interval '1 second'` })
      .where(eq(files.id, ticket.fileId));
  }
}

describe('examples/files/server.ts', () => {
  it('drain loops while the sweep reports more', async () => {
    await staleTickets(5);
    const sweep = vi.spyOn(storage, 'cleanupOrphans');
    expect(await drain(storage, { batch: 2 })).toEqual({ removed: 5, failed: 0 });
    expect(sweep).toHaveBeenCalledTimes(3);
  });

  it('the cleanup schedule runs every 15 minutes under a lock and drains when it fires', async () => {
    await staleTickets(2);
    const locks: Locker = {
      mutex: () => ({
        tryRun: fn => Promise.resolve(fn({ signal: new AbortController().signal, fence: 1n })),
      }),
    };
    const schedule = cleanupSchedule(storage, locks);
    expect(schedule).toMatchObject({ name: 'files.cleanup', every: '15m', lock: { key: 'files.cleanup' } });
    expect(await schedule.handler(undefined, {})).toEqual({ removed: 2, failed: 0 });
  });
});
