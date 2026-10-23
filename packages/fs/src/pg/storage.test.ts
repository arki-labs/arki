/**
 * The files lifecycle on PGlite: the table's Postgres DDL and types here, the
 * behavior through the shared suite (`../lifecycle/storage.behavior.ts`).
 */
import { generateDrizzleJson, generateMigration, pushSchema } from 'drizzle-kit/api-postgres';
import { count, defineRelations, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { FailureOf, SuccessOf } from '@arki/failure';
import { pgColumns } from '@arki/db/pg';
import { initDbRuntimeLocal } from '@arki/db/runtime-local';
import { orThrow } from '@arki/failure';

import type { CREATE_UPLOAD_FAILURES, FileId, UploadTicket } from '../files/index.js';
import type { StorageHarness, UserId } from '../lifecycle/storage.behavior.js';
import type { FileRow, FilesDb, FileStorage, FileStorageOptions, OwnerOf } from './index.js';
import { FILE_ERROR_CODES } from '../files/index.js';
import { describeFileStorage, userId } from '../lifecycle/storage.behavior.js';
import { createLocalStorageAdapter } from '../storage/local-adapter';
import { filesTable, fileStorage } from './index.js';

const files = filesTable(pgColumns(), { owner: userId });
const relations = defineRelations({ files });

let closeRuntime: SuccessOf<typeof initDbRuntimeLocal>['close'];
let db: FilesDb;
let migration: string[];
let drift: string[];

beforeAll(async () => {
  const local = await orThrow(initDbRuntimeLocal({ memory: true }, { relations }));
  closeRuntime = local.close;
  db = local.db;
  // The app's path: `drizzle-kit generate` from the table, then apply the SQL.
  migration = await generateMigration(await generateDrizzleJson({}), await generateDrizzleJson({ files }));
  for (const statement of migration) await db.execute(sql.raw(statement));
  const push = await pushSchema({ files }, local.db);
  drift = push.sqlStatements;
});

afterAll(async () => {
  await orThrow(closeRuntime());
});

describe('filesTable', () => {
  it('generates a migration that applies, and the table has nothing left to push', () => {
    expect(migration.join('\n')).toContain('"files_sweep_idx"');
    expect(migration.join('\n')).toContain(`"sha256" ~ '^[0-9a-f]{64}$'`);
    expect(drift).toEqual([]);
  });

  it('types the owner from the app declaration, written once', () => {
    expectTypeOf<FileRow<typeof files>['ownerId']>().toEqualTypeOf<UserId>();
    expectTypeOf<OwnerOf<typeof files>>().toEqualTypeOf<UserId>();
    expectTypeOf<FileRow<typeof files>['id']>().toEqualTypeOf<FileId>();
  });
});

describe('fileStorage types', () => {
  it('keeps upload failures identical to the definitions used by the RPC contract', () => {
    expectTypeOf<Awaited<ReturnType<FileStorage<typeof files>['createUpload']>>>().toEqualTypeOf<
      UploadTicket | FailureOf<(typeof CREATE_UPLOAD_FAILURES)[number]>
    >();
  });
  it('takes the owner type as actor and hands policies typed rows', () => {
    expectTypeOf<FileStorage<typeof files>['createUpload']>().parameter(0).toEqualTypeOf<UserId>();
    type CanRead = NonNullable<NonNullable<FileStorageOptions<typeof files>['policy']>['canRead']>;
    expectTypeOf<CanRead>().parameter(0).toEqualTypeOf<FileRow<typeof files>>();
  });

  // Local returns a public URL for any "signed" URL: no signature, no limits, no create-only.
  it('refuses the local adapter at compile time and at runtime (ARKI_FS_E006)', () => {
    expectTypeOf(createLocalStorageAdapter).returns.not.toExtend<Parameters<typeof fileStorage>[1]>();
    const local = createLocalStorageAdapter({ provider: 'local', basePath: '/tmp/x', baseUrl: 'https://cdn.local' });
    const call = () =>
      Reflect.apply(fileStorage, undefined, [
        db,
        local,
        { files, bucket: 'b', limits: { maxSize: 1, allowedMime: ['*/*'] } },
      ]);
    expect(call).toThrow(expect.objectContaining({ code: FILE_ERROR_CODES.unsupported }));
  });
});

const harness: StorageHarness = {
  storage: (adapter, options) => fileStorage(db, adapter, { ...options, files }),
  spyOnInsert: () => vi.spyOn(db, 'insert'),
  async row(id) {
    const [found] = await db.select().from(files).where(eq(files.id, id));
    return found;
  },
  async rowCount() {
    const [result] = await db.select({ n: count() }).from(files);
    return result?.n ?? 0;
  },
  async newestPending(bucket) {
    const [found] = await db
      .select({ id: files.id })
      .from(files)
      .where(sql`${files.status} = 'pending' and ${files.bucket} = ${bucket}`)
      .orderBy(desc(files.createdAt), desc(files.id))
      .limit(1);
    return found?.id;
  },
  async expire(id) {
    await db
      .update(files)
      .set({ expiresAt: sql`now() - interval '2 hours'`, cleanupAt: sql`now() - interval '1 second'` })
      .where(eq(files.id, id));
  },
  async dueIn(id, offsetMs) {
    await db
      .update(files)
      .set({ cleanupAt: sql`now() + make_interval(secs => ${offsetMs / 1000})` })
      .where(eq(files.id, id));
  },
  async setStatus(id, status) {
    await db.update(files).set({ status }).where(eq(files.id, id));
  },
  async setAttempts(id, attempts) {
    await db.update(files).set({ cleanupAttempts: attempts }).where(eq(files.id, id));
  },
};

describeFileStorage('Postgres (PGlite)', harness);
