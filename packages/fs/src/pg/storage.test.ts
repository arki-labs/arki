/**
 * The files lifecycle on PGlite with the memory adapter. Every step of the
 * plan's § 5 and every error code has a case here; the races on a real
 * Postgres live in `files.pg.test.ts`. Time passing is simulated by moving a
 * row's deadlines into the past.
 */
import type { PGlite } from '@electric-sql/pglite';
import { generateDrizzleJson, generateMigration, pushSchema } from 'drizzle-kit/api-postgres';
import { count, defineRelations, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';

import type { IdOf } from '@arki/contracts';
import { defineId } from '@arki/contracts';
import { initDbRuntimeLocal } from '@arki/db/runtime-local';
import { isFailure, orThrow } from '@arki/failure';
import { fakeLog } from '@arki/log/testing';

import type { FileId } from '../files/index.js';
import type { FileRow, FilesDb, FileStorage, OwnerOf } from './index.js';
import type { FileStorageOptions } from './storage.js';
import {
  FILE_ERROR_CODES,
  fileId,
  fileRecord,
  FileUnavailable,
  FileWrongState,
  isFileStorageError,
  UploadMismatch,
  UploadPending,
} from '../files/index.js';
import { createLocalStorageAdapter } from '../storage/local-adapter';
import { memoryUploadAdapter } from '../testing.js';
import { filesTable, fileStorage, toFileRecord } from './index.js';

const userId = defineId('usr_');
type UserId = IdOf<typeof userId>;
const files = filesTable({ owner: userId });
const relations = defineRelations({ files });

let pglite: PGlite;
let db: FilesDb;
let migration: string[];
let drift: string[];

beforeAll(async () => {
  const local = await initDbRuntimeLocal({ memory: true }, { relations });
  pglite = local.pglite;
  db = local.db;
  // The app's path: `drizzle-kit generate` from the table, then apply the SQL.
  migration = await generateMigration(await generateDrizzleJson({}), await generateDrizzleJson({ files }));
  for (const statement of migration) await db.execute(sql.raw(statement));
  const push = await pushSchema({ files }, local.db);
  drift = push.sqlStatements;
});

afterAll(async () => {
  await pglite.close();
});

const alice = userId.create();
const bob = userId.create();
const hello = new TextEncoder().encode('hello');

type Options = Partial<FileStorageOptions<typeof files>>;
function setup(options: Options = {}) {
  const adapter = memoryUploadAdapter();
  const storage = fileStorage(db, adapter, {
    files,
    bucket: 'uploads',
    limits: { maxSize: 1000, allowedMime: ['text/*', 'image/png'] },
    ...options,
  });
  return { adapter, storage };
}

async function upload(env: ReturnType<typeof setup>, actor: UserId = alice, body = hello, mime = 'text/plain') {
  const ticket = orThrow(await env.storage.createUpload(actor, { mime, size: body.byteLength }));
  const response = await env.adapter.browserPut(ticket.url, body, ticket.headers);
  expect(response.status).toBe(200);
  return ticket;
}

async function row(id: FileId) {
  const [found] = await db.select().from(files).where(eq(files.id, id));
  return found;
}

async function rowCount() {
  const [result] = await db.select({ n: count() }).from(files);
  return result?.n ?? 0;
}

/** Time passes: the PUT URL expired and the grace ran out. */
async function expire(id: FileId) {
  await db
    .update(files)
    .set({ expiresAt: sql`now() - interval '2 hours'`, cleanupAt: sql`now() - interval '1 second'` })
    .where(eq(files.id, id));
}

/**
 * The code a call failed with: a returned failure's dotted code, or a thrown
 * fault's ARKI_FS code. 'resolved' when it did not fail. A failure that was
 * thrown instead of returned comes back as the failure itself, so it never
 * matches a code.
 */
async function codeOf(promise: Promise<unknown>) {
  try {
    const value = await promise;
    return isFailure(value) ? value.code : 'resolved';
  } catch (error) {
    return isFileStorageError(error) ? error.code : error;
  }
}

describe('filesTable', () => {
  it('generates a migration that applies, and the table has nothing left to push', () => {
    expect(migration.join('\n')).toContain('"files_sweep_idx"');
    expect(drift).toEqual([]);
  });

  it('types the owner from the app declaration, written once', () => {
    expectTypeOf<FileRow<typeof files>['ownerId']>().toEqualTypeOf<UserId>();
    expectTypeOf<OwnerOf<typeof files>>().toEqualTypeOf<UserId>();
    expectTypeOf<FileRow<typeof files>['id']>().toEqualTypeOf<FileId>();
  });
});

describe('fileStorage types', () => {
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

  it('refuses bad config with ARKI_FS_E001', () => {
    for (const options of [
      { urlTtlSeconds: 7200 },
      { maxUrlTtlSeconds: 700_000 },
      { limits: { maxSize: 0, allowedMime: ['text/*'] } },
      { limits: { maxSize: 10, allowedMime: [] } },
      { keyPrefix: '/leading/slash' },
    ] satisfies Options[]) {
      expect(() => setup(options)).toThrow(expect.objectContaining({ code: FILE_ERROR_CODES.invalid }));
    }
  });
});

describe('createUpload', () => {
  it('writes a pending row first and returns a create-only ticket for a server-derived key', async () => {
    const env = setup();
    const ticket = orThrow(await env.storage.createUpload(alice, { mime: 'text/plain', size: 5 }));

    expect(fileId.is(ticket.fileId)).toBe(true);
    expect(ticket.method).toBe('PUT');
    expect(ticket.headers).toEqual({ 'Content-Type': 'text/plain', 'If-None-Match': '*' });
    const stored = await row(ticket.fileId);
    expect(stored).toMatchObject({
      status: 'pending',
      ownerId: alice,
      bucket: 'uploads',
      key: `files/${ticket.fileId}`,
    });
    const ttl = (Date.parse(ticket.expiresAt) - Date.now()) / 1000;
    expect(ttl).toBeGreaterThan(290);
    expect(ttl).toBeLessThanOrEqual(301);
  });

  it('rejects limits before any row is written (ARKI_FS_E001)', async () => {
    const { storage } = setup();
    const before = await rowCount();
    expect(await codeOf(storage.createUpload(alice, { mime: 'text/plain', size: 1001 }))).toBe(
      FILE_ERROR_CODES.invalid,
    );
    expect(await codeOf(storage.createUpload(alice, { mime: 'application/pdf', size: 1 }))).toBe(
      FILE_ERROR_CODES.invalid,
    );
    expect(await codeOf(storage.createUpload(alice, { mime: 'text/plain; charset=utf-8', size: 1 }))).toBe(
      FILE_ERROR_CODES.invalid,
    );
    expect(await rowCount()).toBe(before);
  });

  it('matches image/* style wildcards', async () => {
    const { storage } = setup({ limits: { maxSize: 10, allowedMime: ['image/*'] } });
    await expect(storage.createUpload(alice, { mime: 'image/webp', size: 1 })).resolves.toBeDefined();
    expect(await codeOf(storage.createUpload(alice, { mime: 'text/plain', size: 1 }))).toBe(FILE_ERROR_CODES.invalid);
  });

  it('returns FileUnavailable when the policy refuses creation', async () => {
    const { storage } = setup({ policy: { canCreate: actor => actor !== bob } });
    expect(await codeOf(storage.createUpload(bob, { mime: 'text/plain', size: 1 }))).toBe(FileUnavailable.code);
  });

  // G1: the row commits before the URL exists, so a signer failure leaves a row the sweep removes.
  it('leaves a pending row for the sweep when signing throws (ARKI_FS_E007)', async () => {
    const env = setup();
    const broken = fileStorage(
      db,
      { ...env.adapter, getSignedUrl: () => Promise.reject(new Error('signer down')) },
      {
        files,
        bucket: 'uploads',
        limits: { maxSize: 10, allowedMime: ['text/plain'] },
      },
    );
    const before = await rowCount();
    expect(await codeOf(broken.createUpload(alice, { mime: 'text/plain', size: 1 }))).toBe(FILE_ERROR_CODES.storage);
    const [orphan] = await db
      .select()
      .from(files)
      .where(eq(files.status, 'pending'))
      .orderBy(sql`${files.createdAt} desc`)
      .limit(1);
    expect(await rowCount()).toBe(before + 1);
    if (!orphan) throw new Error('no orphan row');
    await expire(orphan.id);
    await env.storage.cleanupOrphans({ batch: 1000 });
    expect(await row(orphan.id)).toBeUndefined();
  });
});

describe('confirmUpload', () => {
  it('runs the happy path: create → PUT → confirm → url → remove', async () => {
    const env = setup();
    using log = fakeLog();
    const ticket = await upload(env);

    const ready = orThrow(await env.storage.confirmUpload(alice, ticket.fileId));
    expect(ready).toMatchObject({ status: 'ready', size: 5, mime: 'text/plain', sha256: null, cleanupAt: null });
    expect(ready.confirmedAt).not.toBeNull();
    expect(fileRecord.parse(toFileRecord(ready))).toEqual(toFileRecord(ready));

    const { url, expiresAt } = orThrow(await env.storage.url(alice, ticket.fileId));
    expect(new URL(url).pathname).toBe(`/files/${ticket.fileId}`);
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());

    expect(await env.storage.remove(alice, ticket.fileId)).toEqual({ physical: 'done' });
    expect(await row(ticket.fileId)).toBeUndefined();
    expect(await env.adapter.exists(`files/${ticket.fileId}`)).toBe(false);

    // Signed URLs are bearer grants: they never reach a log.
    const logged = JSON.stringify(log.records, (_key, value: unknown) =>
      typeof value === 'bigint' ? String(value) : value,
    );
    expect(logged).not.toContain('X-Memory-Token');
    expect(logged).toContain(ticket.fileId);
  });

  it('is idempotent: a retry after a lost response returns the ready row', async () => {
    const env = setup();
    const ticket = await upload(env);
    const first = await env.storage.confirmUpload(alice, ticket.fileId);
    const second = await env.storage.confirmUpload(alice, ticket.fileId);
    expect(second).toEqual(first);
  });

  it('returns UploadPending before the PUT finished and keeps the row pending', async () => {
    const env = setup();
    const ticket = orThrow(await env.storage.createUpload(alice, { mime: 'text/plain', size: 5 }));
    expect(await codeOf(env.storage.confirmUpload(alice, ticket.fileId))).toBe(UploadPending.code);
    expect(await row(ticket.fileId)).toHaveProperty('status', 'pending');
    await env.adapter.browserPut(ticket.url, hello, ticket.headers);
    expect(await env.storage.confirmUpload(alice, ticket.fileId)).toHaveProperty('status', 'ready');
  });

  // G2: ready only when the stored object matches the row. A store that ignored the signed
  // length or type (or a write by another path) must not produce a ready row.
  it('marks the row deleting on a size mismatch (UploadMismatch)', async () => {
    const env = setup();
    const ticket = orThrow(await env.storage.createUpload(alice, { mime: 'text/plain', size: 5 }));
    await env.adapter.put(`files/${ticket.fileId}`, Buffer.from('hello world'), { contentType: 'text/plain' });
    expect(await codeOf(env.storage.confirmUpload(alice, ticket.fileId))).toBe(UploadMismatch.code);
    expect(await row(ticket.fileId)).toHaveProperty('status', 'deleting');
  });

  it('marks the row deleting on a type mismatch (UploadMismatch)', async () => {
    const env = setup();
    const ticket = orThrow(await env.storage.createUpload(alice, { mime: 'text/plain', size: 5 }));
    await env.adapter.put(`files/${ticket.fileId}`, Buffer.from(hello), { contentType: 'image/png' });
    expect(await codeOf(env.storage.confirmUpload(alice, ticket.fileId))).toBe(UploadMismatch.code);
    expect(await row(ticket.fileId)).toHaveProperty('status', 'deleting');
  });

  it("stores the SHA-256 hex with verify: 'hash'", async () => {
    const env = setup({ verify: 'hash' });
    const ticket = await upload(env);
    const ready = orThrow(await env.storage.confirmUpload(alice, ticket.fileId));
    expect(ready.sha256).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('returns FileWrongState once the confirm window passed, even with the object present', async () => {
    const env = setup();
    const ticket = await upload(env);
    await expire(ticket.fileId);
    expect(await codeOf(env.storage.confirmUpload(alice, ticket.fileId))).toBe(FileWrongState.code);
    expect(await row(ticket.fileId)).toHaveProperty('status', 'pending');
  });

  // G6: once the sweep claimed a row, a confirm cannot make it ready.
  it('loses to a sweep that claimed the row first (FileWrongState)', async () => {
    const env = setup();
    const ticket = await upload(env);
    await db.update(files).set({ status: 'deleting' }).where(eq(files.id, ticket.fileId));
    expect(await codeOf(env.storage.confirmUpload(alice, ticket.fileId))).toBe(FileWrongState.code);
  });
});

describe('expected outcomes', () => {
  // A missing file or an unfinished upload is an answer the caller branches on (show a
  // placeholder, confirm again later), not a fault. So it is returned, never thrown.
  it('returns failures as values, with the file id in the data', async () => {
    const env = setup();
    const missing = fileId.create();
    const unavailable = await env.storage.get(alice, missing);
    expect(FileUnavailable.is(unavailable)).toBe(true);
    expect(unavailable).toMatchObject({ code: 'fs.file_unavailable', status: 404, data: { fileId: missing } });

    const ticket = orThrow(await env.storage.createUpload(alice, { mime: 'text/plain', size: 5 }));
    expect(await env.storage.confirmUpload(alice, ticket.fileId)).toMatchObject({
      code: 'fs.upload_pending',
      status: 409,
      data: { fileId: ticket.fileId },
    });
  });

  it('says why an upload mismatched, so the client can show it', async () => {
    const env = setup();
    const ticket = orThrow(await env.storage.createUpload(alice, { mime: 'text/plain', size: 5 }));
    await env.adapter.put(`files/${ticket.fileId}`, Buffer.from('hello world'), { contentType: 'text/plain' });
    expect(await env.storage.confirmUpload(alice, ticket.fileId)).toMatchObject({
      code: 'fs.upload_mismatch',
      status: 422,
      data: { fileId: ticket.fileId, reason: 'size 11 ≠ 5' },
    });
  });
});

describe('access', () => {
  it('denies another owner with the same failure as a missing file (FileUnavailable)', async () => {
    const env = setup();
    const ticket = await upload(env);
    await env.storage.confirmUpload(alice, ticket.fileId);
    for (const call of [
      env.storage.confirmUpload(bob, ticket.fileId),
      env.storage.get(bob, ticket.fileId),
      env.storage.url(bob, ticket.fileId),
      env.storage.remove(bob, ticket.fileId),
      env.storage.get(alice, fileId.create()),
    ]) {
      // Denied and missing look the same, down to the data: nothing tells a prober the file exists.
      const result = await call;
      expect(FileUnavailable.is(result) && Object.keys(result.data)).toEqual(['fileId']);
    }
    expect(await row(ticket.fileId)).toHaveProperty('status', 'ready');
  });

  it('lets a policy widen reads', async () => {
    const env = setup({ policy: { canRead: () => true } });
    const ticket = await upload(env);
    await env.storage.confirmUpload(alice, ticket.fileId);
    expect(await env.storage.get(bob, ticket.fileId)).toHaveProperty('ownerId', alice);
  });

  it('isolates bucket bindings: rows of another binding are invisible', async () => {
    const env = setup();
    const ticket = await upload(env);
    const other = fileStorage(db, env.adapter, {
      files,
      bucket: 'avatars',
      limits: { maxSize: 10, allowedMime: ['*/*'] },
    });
    expect(await codeOf(other.confirmUpload(alice, ticket.fileId))).toBe(FileUnavailable.code);
    await expire(ticket.fileId);
    await other.cleanupOrphans({ batch: 1000 });
    expect(await row(ticket.fileId)).toBeDefined();
  });
});

describe('url', () => {
  it('returns FileWrongState for a pending file', async () => {
    const env = setup();
    const ticket = await upload(env);
    expect(await codeOf(env.storage.url(alice, ticket.fileId))).toBe(FileWrongState.code);
  });

  it('rejects a TTL over the cap instead of clamping it (ARKI_FS_E001)', async () => {
    const env = setup({ maxUrlTtlSeconds: 600 });
    const ticket = await upload(env);
    await env.storage.confirmUpload(alice, ticket.fileId);
    expect(await codeOf(env.storage.url(alice, ticket.fileId, { expiresIn: 601 }))).toBe(FILE_ERROR_CODES.invalid);
    expect(await codeOf(env.storage.url(alice, ticket.fileId, { filename: 'a"b' }))).toBe(FILE_ERROR_CODES.invalid);
    const { url } = orThrow(await env.storage.url(alice, ticket.fileId, { expiresIn: 600 }));
    expect(new URL(url).searchParams.get('X-Memory-Expires')).toBe('600');
  });
});

describe('remove', () => {
  // A PUT accepted before expiry may still land; deleting the object first would leave a late orphan.
  it('keeps a pending object until expires_at + grace, then the sweep removes row and object', async () => {
    const env = setup();
    const ticket = await upload(env);
    expect(await env.storage.remove(alice, ticket.fileId)).toEqual({ physical: 'scheduled' });
    expect(await row(ticket.fileId)).toHaveProperty('status', 'deleting');

    await env.storage.cleanupOrphans({ batch: 1000 });
    expect(await row(ticket.fileId)).toHaveProperty('status', 'deleting');
    expect(await env.adapter.exists(`files/${ticket.fileId}`)).toBe(true);

    await expire(ticket.fileId);
    await env.storage.cleanupOrphans({ batch: 1000 });
    expect(await row(ticket.fileId)).toBeUndefined();
    expect(await env.adapter.exists(`files/${ticket.fileId}`)).toBe(false);
  });

  it('is scheduled when the object delete fails; the sweep finishes it', async () => {
    const env = setup();
    const ticket = await upload(env);
    await env.storage.confirmUpload(alice, ticket.fileId);
    const failing = fileStorage(
      db,
      { ...env.adapter, delete: () => Promise.reject(new Error('store down')) },
      {
        files,
        bucket: 'uploads',
        limits: { maxSize: 10, allowedMime: ['*/*'] },
      },
    );
    expect(await failing.remove(alice, ticket.fileId)).toEqual({ physical: 'scheduled' });
    expect(await row(ticket.fileId)).toHaveProperty('status', 'deleting');
    expect(await env.storage.remove(alice, ticket.fileId)).toEqual({ physical: 'scheduled' });

    await env.storage.cleanupOrphans({ batch: 1000 });
    expect(await row(ticket.fileId)).toBeUndefined();
  });
});

describe('cleanupOrphans', () => {
  it('pages with more, and stale tickets are removed', async () => {
    const env = setup();
    await env.storage.cleanupOrphans({ batch: 1000 });
    const tickets = [];
    for (let index = 0; index < 3; index += 1)
      tickets.push(orThrow(await env.storage.createUpload(alice, { mime: 'text/plain', size: 1 })));
    for (const ticket of tickets) await expire(ticket.fileId);

    expect(await env.storage.cleanupOrphans({ batch: 2 })).toEqual({ removed: 2, failed: 0, more: true });
    expect(await env.storage.cleanupOrphans({ batch: 2 })).toEqual({ removed: 1, failed: 0, more: false });
  });

  it('leaves ready rows and fresh pending rows alone', async () => {
    const env = setup();
    const ready = await upload(env);
    await env.storage.confirmUpload(alice, ready.fileId);
    const fresh = orThrow(await env.storage.createUpload(alice, { mime: 'text/plain', size: 1 }));
    await env.storage.cleanupOrphans({ batch: 1000 });
    expect(await row(ready.fileId)).toHaveProperty('status', 'ready');
    expect(await row(fresh.fileId)).toHaveProperty('status', 'pending');
  });

  // G7: a failing object backs off instead of blocking the queue head forever.
  it('backs off a failing delete so later rows still go', async () => {
    const env = setup();
    await env.storage.cleanupOrphans({ batch: 1000 });
    const stuck = orThrow(await env.storage.createUpload(alice, { mime: 'text/plain', size: 1 }));
    const later = orThrow(await env.storage.createUpload(alice, { mime: 'text/plain', size: 1 }));
    await expire(stuck.fileId);
    await expire(later.fileId);
    await db
      .update(files)
      .set({ cleanupAt: sql`now() - interval '1 minute'` })
      .where(eq(files.id, stuck.fileId));

    const failing = fileStorage(
      db,
      {
        ...env.adapter,
        delete: (key: string) =>
          key.endsWith(stuck.fileId) ? Promise.reject(new Error('locked')) : env.adapter.delete(key),
      },
      { files, bucket: 'uploads', limits: { maxSize: 10, allowedMime: ['*/*'] } },
    );
    expect(await failing.cleanupOrphans({ batch: 1 })).toEqual({ removed: 0, failed: 1, more: true });
    expect(await failing.cleanupOrphans({ batch: 1 })).toEqual({ removed: 1, failed: 0, more: true });
    expect(await row(later.fileId)).toBeUndefined();
    expect(await row(stuck.fileId)).toMatchObject({ status: 'deleting', cleanupAttempts: 1 });
  });

  it('refuses a batch outside 1–1000 (ARKI_FS_E001)', async () => {
    const { storage } = setup();
    expect(await codeOf(storage.cleanupOrphans({ batch: 0 }))).toBe(FILE_ERROR_CODES.invalid);
  });
});
