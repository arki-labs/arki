/**
 * The files lifecycle as one behavior suite, run against every dialect: PGlite
 * (`../pg/storage.test.ts`) and libSQL (`../sqlite/storage.test.ts`), each with
 * the memory adapter. Every step of the plan's § 5 and every error code has a
 * case here; the races on a real Postgres live in `../pg/files.pg.test.ts`.
 * Time passing is simulated by moving a row's deadlines into the past.
 */
import type { MockInstance } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IdOf } from '@arki/contracts';
import type { Dialect } from '@arki/db/columns';
import { defineId, RandomSourceUnavailable } from '@arki/contracts';
import { InvalidInput, isFailure, orThrow, UnexpectedDefect } from '@arki/failure';
import { fakeLog } from '@arki/log/testing';

import type { FileId } from '../files/schemas.js';
import type { SignedUploadAdapter } from '../storage/types.js';
import type { FileStorage, FileStorageOptions } from './storage.js';
import type { FileRow, FilesTable } from './table.js';
import { FILE_ERROR_CODES, isFileStorageError } from '../files/errors.js';
import { FileUnavailable, FileWrongState, UploadMismatch, UploadPending } from '../files/failures.js';
import { fileId, fileRecord } from '../files/schemas.js';
import { StorageUnavailable, StorageWriteUncertain } from '../storage/failures.js';
import { memoryUploadAdapter } from '../testing.js';
import { toFileRecord } from './record.js';

export const userId = defineId('usr_');
export type UserId = IdOf<typeof userId>;
/** The suite's table on either dialect. */
export type UserFiles = FilesTable<Dialect, UserId>;
export type StorageSetup = Omit<FileStorageOptions<UserFiles>, 'files'>;

/** What the suite needs from one dialect: its `fileStorage` and a few direct reads and writes. */
export type StorageHarness = {
  storage: (adapter: SignedUploadAdapter, options: StorageSetup) => FileStorage<UserFiles>;
  spyOnInsert: () => MockInstance;
  row: (id: FileId) => Promise<FileRow<UserFiles> | undefined>;
  rowCount: () => Promise<number>;
  /** The newest pending row of `bucket`. */
  newestPending: (bucket: string) => Promise<FileId | undefined>;
  /** Time passes: the PUT URL expired two hours ago and the grace ran out a second ago. */
  expire: (id: FileId) => Promise<void>;
  /** Moves `cleanup_at` to `offsetMs` from now (database time); negative is overdue. */
  dueIn: (id: FileId, offsetMs: number) => Promise<void>;
  setStatus: (id: FileId, status: 'deleting') => Promise<void>;
  setAttempts: (id: FileId, attempts: number) => Promise<void>;
};

const alice = orThrow(userId.create());
const bob = orThrow(userId.create());
const hello = new TextEncoder().encode('hello');
const MINUTE = 60_000;
const DAY = 86_400_000;

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

/** Runs the whole lifecycle suite on one dialect; `label` names it in the test output. */
export function describeFileStorage(label: string, harness: StorageHarness) {
  afterEach(() => vi.restoreAllMocks());

  function setup(options: Partial<StorageSetup> = {}) {
    const adapter = memoryUploadAdapter();
    const storage = harness.storage(adapter, {
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

  const { row, rowCount, expire } = harness;

  describe(`fileStorage on ${label}`, () => {
    it('refuses bad config with ARKI_FS_E001', () => {
      for (const options of [
        { urlTtlSeconds: 7200 },
        { maxUrlTtlSeconds: 700_000 },
        { limits: { maxSize: 0, allowedMime: ['text/*'] } },
        { limits: { maxSize: 10, allowedMime: [] } },
        { keyPrefix: '/leading/slash' },
      ] satisfies Partial<StorageSetup>[]) {
        expect(() => setup(options)).toThrow(expect.objectContaining({ code: FILE_ERROR_CODES.invalid }));
      }
    });

    describe('createUpload', () => {
      it.each([RandomSourceUnavailable(), UnexpectedDefect({ cause: new Error('private entropy detail') })])(
        'returns $code unchanged before inserting or signing',
        async failure => {
          const env = setup();
          const before = await rowCount();
          vi.spyOn(fileId, 'create').mockReturnValue(failure);
          const insert = harness.spyOnInsert();
          const sign = vi.spyOn(env.adapter, 'getSignedUrl');
          expect(await env.storage.createUpload(alice, { mime: 'text/plain', size: 1 })).toBe(failure);
          expect(insert).not.toHaveBeenCalled();
          expect(sign).not.toHaveBeenCalled();
          expect(await rowCount()).toBe(before);
        },
      );
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
        // The sweep may act once the PUT URL died and the grace (900 s by default) ran out.
        expect(stored?.cleanupAt?.epochMilliseconds).toBe(Date.parse(ticket.expiresAt) + 900_000);
      });

      it('rejects limits before any row is written (InvalidInput)', async () => {
        const { storage } = setup();
        const before = await rowCount();
        expect(await codeOf(storage.createUpload(alice, { mime: 'text/plain', size: 1001 }))).toBe(InvalidInput.code);
        expect(await codeOf(storage.createUpload(alice, { mime: 'application/pdf', size: 1 }))).toBe(InvalidInput.code);
        expect(await codeOf(storage.createUpload(alice, { mime: 'text/plain; charset=utf-8', size: 1 }))).toBe(
          InvalidInput.code,
        );
        expect(await rowCount()).toBe(before);
      });

      it('matches image/* style wildcards', async () => {
        const { storage } = setup({ limits: { maxSize: 10, allowedMime: ['image/*'] } });
        await expect(storage.createUpload(alice, { mime: 'image/webp', size: 1 })).resolves.toBeDefined();
        expect(await codeOf(storage.createUpload(alice, { mime: 'text/plain', size: 1 }))).toBe(InvalidInput.code);
      });

      it('returns FileUnavailable when the policy refuses creation', async () => {
        const { storage } = setup({ policy: { canCreate: actor => actor !== bob } });
        expect(await codeOf(storage.createUpload(bob, { mime: 'text/plain', size: 1 }))).toBe(FileUnavailable.code);
      });

      // G1: the row commits before the URL exists, so a signer failure leaves a row the sweep removes.
      it('leaves a pending row for the sweep when signing throws (StorageUnavailable)', async () => {
        const env = setup();
        const broken = harness.storage(
          {
            ...env.adapter,
            getSignedUrl: () => Promise.reject(Object.assign(new Error('signer down'), { code: 'ECONNRESET' })),
          },
          { bucket: 'broken-signer', limits: { maxSize: 10, allowedMime: ['text/plain'] } },
        );
        const before = await rowCount();
        expect(await codeOf(broken.createUpload(alice, { mime: 'text/plain', size: 1 }))).toBe(StorageUnavailable.code);
        const orphan = await harness.newestPending('broken-signer');
        expect(await rowCount()).toBe(before + 1);
        if (!orphan) throw new Error('no orphan row');
        await expire(orphan);
        orThrow(await broken.cleanupOrphans({ batch: 1000 }));
        expect(await row(orphan)).toBeUndefined();
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
        orThrow(
          await env.adapter.put(`files/${ticket.fileId}`, Buffer.from('hello world'), { contentType: 'text/plain' }),
        );
        expect(await codeOf(env.storage.confirmUpload(alice, ticket.fileId))).toBe(UploadMismatch.code);
        const rejected = await row(ticket.fileId);
        expect(rejected).toHaveProperty('status', 'deleting');
        // Due only once a late PUT can no longer land: expires_at + grace.
        expect(rejected?.cleanupAt?.epochMilliseconds).toBe(Date.parse(ticket.expiresAt) + 900_000);
      });

      it('marks the row deleting on a type mismatch (UploadMismatch)', async () => {
        const env = setup();
        const ticket = orThrow(await env.storage.createUpload(alice, { mime: 'text/plain', size: 5 }));
        orThrow(await env.adapter.put(`files/${ticket.fileId}`, Buffer.from(hello), { contentType: 'image/png' }));
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
        await harness.setStatus(ticket.fileId, 'deleting');
        expect(await codeOf(env.storage.confirmUpload(alice, ticket.fileId))).toBe(FileWrongState.code);
      });
    });

    describe('expected outcomes', () => {
      // A missing file or an unfinished upload is an answer the caller branches on (show a
      // placeholder, confirm again later), not a fault. So it is returned, never thrown.
      it('returns failures as values, with the file id in the data', async () => {
        const env = setup();
        const missing = orThrow(fileId.create());
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
        orThrow(
          await env.adapter.put(`files/${ticket.fileId}`, Buffer.from('hello world'), { contentType: 'text/plain' }),
        );
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
        await orThrow(env.storage.confirmUpload(alice, ticket.fileId));
        for (const call of [
          env.storage.confirmUpload(bob, ticket.fileId),
          env.storage.get(bob, ticket.fileId),
          env.storage.url(bob, ticket.fileId),
          env.storage.remove(bob, ticket.fileId),
          env.storage.get(alice, orThrow(fileId.create())),
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
        await orThrow(env.storage.confirmUpload(alice, ticket.fileId));
        expect(await env.storage.get(bob, ticket.fileId)).toHaveProperty('ownerId', alice);
      });

      it('isolates bucket bindings: rows of another binding are invisible', async () => {
        const env = setup();
        const ticket = await upload(env);
        const other = harness.storage(env.adapter, {
          bucket: 'avatars',
          limits: { maxSize: 10, allowedMime: ['*/*'] },
        });
        expect(await codeOf(other.confirmUpload(alice, ticket.fileId))).toBe(FileUnavailable.code);
        await expire(ticket.fileId);
        orThrow(await other.cleanupOrphans({ batch: 1000 }));
        expect(await row(ticket.fileId)).toBeDefined();
      });
    });

    describe('url', () => {
      it('returns FileWrongState for a pending file', async () => {
        const env = setup();
        const ticket = await upload(env);
        expect(await codeOf(env.storage.url(alice, ticket.fileId))).toBe(FileWrongState.code);
      });

      it('rejects a TTL over the cap instead of clamping it (InvalidInput)', async () => {
        const env = setup({ maxUrlTtlSeconds: 600 });
        const ticket = await upload(env);
        await orThrow(env.storage.confirmUpload(alice, ticket.fileId));
        expect(await codeOf(env.storage.url(alice, ticket.fileId, { expiresIn: 601 }))).toBe(InvalidInput.code);
        expect(await codeOf(env.storage.url(alice, ticket.fileId, { filename: 'a"b' }))).toBe(InvalidInput.code);
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
        const marked = await row(ticket.fileId);
        expect(marked).toHaveProperty('status', 'deleting');
        expect(marked?.cleanupAt?.epochMilliseconds).toBe(Date.parse(ticket.expiresAt) + 900_000);

        orThrow(await env.storage.cleanupOrphans({ batch: 1000 }));
        expect(await row(ticket.fileId)).toHaveProperty('status', 'deleting');
        expect(await env.adapter.exists(`files/${ticket.fileId}`)).toBe(true);

        await expire(ticket.fileId);
        orThrow(await env.storage.cleanupOrphans({ batch: 1000 }));
        expect(await row(ticket.fileId)).toBeUndefined();
        expect(await env.adapter.exists(`files/${ticket.fileId}`)).toBe(false);
      });

      it('returns uncertainty when deletion is unconfirmed and retains the sweep duty', async () => {
        const env = setup();
        const ticket = await upload(env);
        await orThrow(env.storage.confirmUpload(alice, ticket.fileId));
        const failing = harness.storage(
          { ...env.adapter, delete: () => Promise.reject(new Error('store down')) },
          { bucket: 'uploads', limits: { maxSize: 10, allowedMime: ['*/*'] } },
        );
        expect(StorageWriteUncertain.is(await failing.remove(alice, ticket.fileId))).toBe(true);
        expect(await row(ticket.fileId)).toHaveProperty('status', 'deleting');
        expect(await env.storage.remove(alice, ticket.fileId)).toEqual({ physical: 'scheduled' });

        orThrow(await env.storage.cleanupOrphans({ batch: 1000 }));
        expect(await row(ticket.fileId)).toBeUndefined();
      });
    });

    describe('cleanupOrphans', () => {
      it('pages with more, and stale tickets are removed', async () => {
        const env = setup();
        orThrow(await env.storage.cleanupOrphans({ batch: 1000 }));
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
        await orThrow(env.storage.confirmUpload(alice, ready.fileId));
        const fresh = orThrow(await env.storage.createUpload(alice, { mime: 'text/plain', size: 1 }));
        orThrow(await env.storage.cleanupOrphans({ batch: 1000 }));
        expect(await row(ready.fileId)).toHaveProperty('status', 'ready');
        expect(await row(fresh.fileId)).toHaveProperty('status', 'pending');
      });

      // The sweep predicate (the partial index): not ready, due now, this bucket; oldest first.
      it('sweeps due rows oldest first and skips ready rows and rows not yet due', async () => {
        const deleted: string[] = [];
        const env = setup({ bucket: 'sweep-order' });
        const sweeper = harness.storage(
          {
            ...env.adapter,
            delete: (key: string) => {
              deleted.push(key);
              return env.adapter.delete(key);
            },
          },
          { bucket: 'sweep-order', limits: { maxSize: 10, allowedMime: ['*/*'] } },
        );
        const create = async () => orThrow(await env.storage.createUpload(alice, { mime: 'text/plain', size: 5 }));
        const [later, oldest, notYet] = [await create(), await create(), await create()];
        const ready = await upload(env);
        await orThrow(env.storage.confirmUpload(alice, ready.fileId));
        await harness.dueIn(later.fileId, -MINUTE);
        await harness.dueIn(oldest.fileId, -3 * MINUTE);
        await harness.dueIn(notYet.fileId, MINUTE);

        expect(await sweeper.cleanupOrphans({ batch: 1 })).toEqual({ removed: 1, failed: 0, more: true });
        expect(await sweeper.cleanupOrphans({ batch: 1 })).toEqual({ removed: 1, failed: 0, more: true });
        expect(await sweeper.cleanupOrphans({ batch: 1 })).toEqual({ removed: 0, failed: 0, more: false });
        expect(deleted).toEqual([`files/${oldest.fileId}`, `files/${later.fileId}`]);
        expect(await row(notYet.fileId)).toHaveProperty('status', 'pending');
        expect(await row(ready.fileId)).toHaveProperty('status', 'ready');
      });

      // G7: a failing object backs off instead of blocking the queue head forever.
      it('backs off a failing delete so later rows still go', async () => {
        const env = setup();
        orThrow(await env.storage.cleanupOrphans({ batch: 1000 }));
        const stuck = orThrow(await env.storage.createUpload(alice, { mime: 'text/plain', size: 1 }));
        const later = orThrow(await env.storage.createUpload(alice, { mime: 'text/plain', size: 1 }));
        await expire(stuck.fileId);
        await expire(later.fileId);
        await harness.dueIn(stuck.fileId, -MINUTE);

        const failing = harness.storage(
          {
            ...env.adapter,
            delete: (key: string) =>
              key.endsWith(stuck.fileId) ? Promise.reject(new Error('locked')) : env.adapter.delete(key),
          },
          { bucket: 'uploads', limits: { maxSize: 10, allowedMime: ['*/*'] } },
        );
        expect(StorageWriteUncertain.is(await failing.cleanupOrphans({ batch: 1 }))).toBe(true);
        expect(await failing.cleanupOrphans({ batch: 1 })).toEqual({ removed: 1, failed: 0, more: true });
        expect(await row(later.fileId)).toBeUndefined();
        expect(await row(stuck.fileId)).toMatchObject({ status: 'deleting', cleanupAttempts: 1 });
      });

      // Same numbers on every dialect: 1 minute after the first claim, doubling, never more than a day.
      it('backs off on one schedule: 1 min, 2 min, 4 min, …, capped at 1 day', async () => {
        const env = setup({ bucket: 'backoff' });
        const failing = harness.storage(
          { ...env.adapter, delete: () => Promise.reject(new Error('locked')) },
          { bucket: 'backoff', limits: { maxSize: 10, allowedMime: ['*/*'] } },
        );
        const ticket = orThrow(await env.storage.createUpload(alice, { mime: 'text/plain', size: 1 }));
        await expire(ticket.fileId);

        /** One failed claim; returns how far out it pushed `cleanup_at`, in ms (database and test share the clock). */
        const claimOnce = async () => {
          await harness.dueIn(ticket.fileId, -1000);
          const before = Date.now();
          expect(StorageWriteUncertain.is(await failing.cleanupOrphans({ batch: 1 }))).toBe(true);
          const after = Date.now();
          const claimed = await row(ticket.fileId);
          const next = claimed?.cleanupAt?.epochMilliseconds ?? Number.NaN;
          return { earliest: next - after, latest: next - before };
        };
        const expectBackoff = (window: { earliest: number; latest: number }, ms: number) => {
          // Millisecond clocks: allow one tick either side of the measured window.
          expect(window.earliest).toBeLessThanOrEqual(ms + 1);
          expect(window.latest).toBeGreaterThanOrEqual(ms - 1);
        };

        expectBackoff(await claimOnce(), MINUTE);
        expectBackoff(await claimOnce(), 2 * MINUTE);
        expectBackoff(await claimOnce(), 4 * MINUTE);
        await harness.setAttempts(ticket.fileId, 10);
        expectBackoff(await claimOnce(), 1024 * MINUTE);
        await harness.setAttempts(ticket.fileId, 40);
        expectBackoff(await claimOnce(), DAY);
        expect(await row(ticket.fileId)).toHaveProperty('cleanupAttempts', 41);
      });

      it('refuses a batch outside 1–1000 (InvalidInput)', async () => {
        const { storage } = setup();
        expect(await codeOf(storage.cleanupOrphans({ batch: 0 }))).toBe(InvalidInput.code);
      });
    });
  });
}
