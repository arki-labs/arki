/**
 * The files lifecycle on a real SQLite (libSQL, in memory): the table's
 * SQLite DDL, its CHECKs and types here, the behavior through the same suite
 * the Postgres twin runs (`../lifecycle/storage.behavior.ts`).
 */
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/payload/sqlite';
import { count, defineRelations, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { findDatabaseError } from '@arki/db/errors';
import { createLibsqlDb } from '@arki/db/libsql';
import { sqliteColumns } from '@arki/db/sqlite';
import { orThrow } from '@arki/failure';

import type { FileId } from '../files/index.js';
import type { StorageHarness, UserId } from '../lifecycle/storage.behavior.js';
import type { FileRow, FileStorage, OwnerOf } from './index.js';
import { describeFileStorage, userId } from '../lifecycle/storage.behavior.js';
import { memoryUploadAdapter } from '../testing.js';
import { sqliteNowMs as nowMs } from '@arki/db/sqlite';
import { filesTable, fileStorage } from './index.js';

const files = filesTable(sqliteColumns(), { owner: userId });
const { db, close } = createLibsqlDb({ url: ':memory:', relations: defineRelations({ files }) });
let migration: string[];

beforeAll(async () => {
  migration = await generateMigration(await generateDrizzleJson({}), await generateDrizzleJson({ files }));
  for (const statement of migration) await db.run(sql.raw(statement));
});

afterAll(() => {
  close();
});

describe('filesTable on SQLite', () => {
  it('generates the same constraints and the partial sweep index', () => {
    const ddl = migration.join('\n');
    expect(ddl).toContain(`"sha256" regexp '^[0-9a-f]{64}$'`);
    expect(ddl).toMatch(
      /CREATE INDEX `files_sweep_idx` ON `files` \(`cleanup_at`,`id`\) WHERE "files"\."status" <> 'ready'/,
    );
    for (const check of ['size', 'sha256', 'status', 'cleanup_attempts', 'ready', 'cleanup']) {
      expect(ddl).toContain(`CONSTRAINT "files_${check}_check"`);
    }
  });

  it('puts every table and index name behind the prefix', async () => {
    const prefixed = filesTable(sqliteColumns({ prefix: 'app_' }), { owner: userId });
    const statements = await generateMigration(await generateDrizzleJson({}), await generateDrizzleJson({ prefixed }));
    const ddl = statements.join('\n');
    expect(ddl).toContain('CREATE TABLE `app_files`');
    expect(ddl).toContain('`app_files_sweep_idx`');
    expect(ddl).toContain('`app_files_owner_idx`');
  });

  it('types the owner from the app declaration, written once, like the Postgres table', () => {
    expectTypeOf<FileRow<typeof files>['ownerId']>().toEqualTypeOf<UserId>();
    expectTypeOf<OwnerOf<typeof files>>().toEqualTypeOf<UserId>();
    expectTypeOf<FileRow<typeof files>['id']>().toEqualTypeOf<FileId>();
    expectTypeOf<FileStorage<typeof files>['createUpload']>().parameter(0).toEqualTypeOf<UserId>();
  });

  // The CHECKs hold even against raw SQL that skips Drizzle's types. SQLite names the CHECK in its message.
  it.each([
    ['a sha256 that is not lowercase hex', sql`sha256 = ${'A'.repeat(64)}`, 'files_sha256_check'],
    ['a negative size', sql`size = -1`, 'files_size_check'],
    ['an unknown status', sql`status = 'lost'`, 'files_status_check'],
  ])('refuses %s', async (_what, assignment, check) => {
    const storage = fileStorage(db, memoryUploadAdapter(), {
      files,
      bucket: 'checks',
      limits: { maxSize: 10, allowedMime: ['*/*'] },
    });
    const ticket = orThrow(await storage.createUpload(orThrow(userId.create()), { mime: 'text/plain', size: 1 }));
    const error: unknown = await db
      .run(sql`update files set ${assignment} where id = ${ticket.fileId}`)
      .catch((error_: unknown) => error_);
    expect(findDatabaseError(error)?.sqlState).toBe('23514');
    expect(error).toMatchObject({ cause: { message: expect.stringContaining(check) } });
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
      .set({ expiresAt: sql`${nowMs} - 7200000`, cleanupAt: sql`${nowMs} - 1000` })
      .where(eq(files.id, id));
  },
  async dueIn(id, offsetMs) {
    await db
      .update(files)
      .set({ cleanupAt: sql`${nowMs} + ${offsetMs}` })
      .where(eq(files.id, id));
  },
  async setStatus(id, status) {
    await db.update(files).set({ status }).where(eq(files.id, id));
  },
  async setAttempts(id, attempts) {
    await db.update(files).set({ cleanupAttempts: attempts }).where(eq(files.id, id));
  },
};

describeFileStorage('SQLite (libSQL)', harness);
