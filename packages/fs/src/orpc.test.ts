/**
 * The four procedures end to end through an oRPC router client, on PGlite
 * with the memory adapter. Outputs carry no bucket, key or owner, and the
 * client output types come from the contract alone.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { ContractRouterClient } from '@orpc/contract';
import { createRouterClient, implement, ORPCError } from '@orpc/server';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { defineRelations } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { IdOf } from '@arki/contracts';
import { defineId } from '@arki/contracts';
import { initDbRuntimeLocal } from '@arki/db/runtime-local';

import type { FileRecord, SignedFileUrl } from './files/index.js';
import type { FileStorage } from './pg/index.js';
import { uploadFile } from './files/index.js';
import { filesContract, filesRouter } from './orpc.js';
import { filesTable, fileStorage } from './pg/index.js';
import { memoryUploadAdapter } from './testing.js';

const userId = defineId('usr_');
type UserId = IdOf<typeof userId>;
const files = filesTable({ owner: userId });
const alice = userId.create();
const bob = userId.create();

type AppContext = { userId: UserId | null };
const appContract = { files: filesContract };
const implementer = implement(appContract).$context<AppContext>();

let pglite: PGlite;
let storage: FileStorage<typeof files>;
const adapter = memoryUploadAdapter();

const router = implementer.router({
  files: filesRouter(implementer.files, {
    storage: () => storage,
    actor: context => {
      if (!context.userId) throw new ORPCError('UNAUTHORIZED');
      return context.userId;
    },
  }),
});
const clientFor = (user: UserId | null) => createRouterClient(router, { context: { userId: user } });

beforeAll(async () => {
  const local = await initDbRuntimeLocal({ memory: true }, { relations: defineRelations({ files }) });
  pglite = local.pglite;
  const push = await pushSchema({ files }, local.db);
  await push.apply();
  storage = fileStorage(local.db, adapter, {
    files,
    bucket: 'uploads',
    limits: { maxSize: 100, allowedMime: ['text/*'] },
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await pglite.close();
});

/** Routes the browser's PUT to the memory store. */
function stubStoreFetch() {
  vi.stubGlobal('fetch', async (url: string, init: { body: Blob; headers: Record<string, string> }) =>
    adapter.browserPut(url, new Uint8Array(await init.body.arrayBuffer()), init.headers),
  );
}

describe('filesContract types', () => {
  it('gives clients FileRecord and SignedFileUrl, from the contract alone', () => {
    type Browser = ContractRouterClient<typeof appContract>;
    expectTypeOf<Awaited<ReturnType<Browser['files']['confirmUpload']>>>().toEqualTypeOf<FileRecord>();
    expectTypeOf<Awaited<ReturnType<Browser['files']['url']>>>().toEqualTypeOf<SignedFileUrl>();
    expectTypeOf<
      Awaited<ReturnType<ReturnType<typeof clientFor>['files']['confirmUpload']>>
    >().toEqualTypeOf<FileRecord>();
  });
});

describe('filesRouter', () => {
  it('drives createUpload → PUT → confirmUpload → url → remove, with uploadFile on the client', async () => {
    stubStoreFetch();
    const client = clientFor(alice);
    const record = await uploadFile(client.files, new Blob(['hello'], { type: 'text/plain' }));
    expect(record).toMatchObject({ mime: 'text/plain', size: 5, status: 'ready' });

    const link = await client.files.url({ fileId: record.id });
    expect(Date.parse(link.expiresAt)).toBeGreaterThan(Date.now());
    await expect(client.files.remove({ fileId: record.id })).resolves.toBeUndefined();
    expect(await adapter.exists(`files/${record.id}`)).toBe(false);
  });

  it('never returns the bucket, key or owner', async () => {
    const client = clientFor(alice);
    const ticket = await client.files.createUpload({ mime: 'text/plain', size: 2 });
    await adapter.browserPut(ticket.url, new Uint8Array(2), ticket.headers);
    const record = await client.files.confirmUpload({ fileId: ticket.fileId });
    expect(Object.keys(record).toSorted()).toEqual(['createdAt', 'id', 'mime', 'sha256', 'size', 'status']);
    expect(JSON.stringify(record)).not.toContain('uploads');
    expect(JSON.stringify(record)).not.toContain(alice);
    expect(Object.keys(ticket).toSorted()).toEqual(['expiresAt', 'fileId', 'headers', 'method', 'url']);
  });

  it('maps ARKI_FS codes to oRPC codes: E002 → NOT_FOUND, E001 → BAD_REQUEST, E004 → CONFLICT', async () => {
    const ticket = await clientFor(alice).files.createUpload({ mime: 'text/plain', size: 2 });

    const asBob = await clientFor(bob)
      .files.confirmUpload({ fileId: ticket.fileId })
      .catch((error: unknown) => error);
    expect(asBob).toBeInstanceOf(ORPCError);
    expect(asBob).toMatchObject({ code: 'NOT_FOUND', data: { code: 'ARKI_FS_E002' } });

    const early = await clientFor(alice)
      .files.confirmUpload({ fileId: ticket.fileId })
      .catch((error: unknown) => error);
    expect(early).toMatchObject({ code: 'CONFLICT', data: { code: 'ARKI_FS_E004', retryable: true } });

    const tooBig = await clientFor(alice)
      .files.createUpload({ mime: 'text/plain', size: 101 })
      .catch((error: unknown) => error);
    expect(tooBig).toMatchObject({ code: 'BAD_REQUEST', data: { code: 'ARKI_FS_E001' } });
  });

  it('lets the actor binding refuse anonymous callers', async () => {
    const error = await clientFor(null)
      .files.createUpload({ mime: 'text/plain', size: 1 })
      .catch((error_: unknown) => error_);
    expect(error).toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
