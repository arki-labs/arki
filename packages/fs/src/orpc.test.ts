/**
 * The four procedures end to end through an oRPC router client, on PGlite
 * with the memory adapter. Outputs carry no bucket, key or owner, and the
 * client output types come from the contract alone.
 */
import type { ContractRouterClient } from '@orpc/contract';
import { createRouterClient, implement, ORPCError } from '@orpc/server';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { defineRelations } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { IdOf } from '@arki/contracts';
import type { SuccessOf } from '@arki/failure';
import { defineId, RandomSourceUnavailable } from '@arki/contracts';
import { pgColumns } from '@arki/db/pg';
import { initDbRuntimeLocal } from '@arki/db/runtime-local';
import { orThrow, UnexpectedDefect } from '@arki/failure';
import { reviveRpcError } from '@arki/failure/orpc';

import type { FileRecord, SignedFileUrl } from './files/index.js';
import type { FileStorage } from './pg/index.js';
import { CREATE_UPLOAD_FAILURES, fileId, FileUnavailable, uploadFile, UploadPending } from './files/index.js';
import { filesContract, filesRouter } from './orpc.js';
import { filesTable, fileStorage } from './pg/index.js';
import { memoryUploadAdapter } from './testing.js';

const userId = defineId('usr_');
type UserId = IdOf<typeof userId>;
const files = filesTable(pgColumns(), { owner: userId });
const alice = orThrow(userId.create());
const bob = orThrow(userId.create());

type AppContext = { userId: UserId | null };
const appContract = { files: filesContract };
const implementer = implement(appContract).$context<AppContext>();

let closeRuntime: SuccessOf<typeof initDbRuntimeLocal>['close'];
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
  const local = await orThrow(initDbRuntimeLocal({ memory: true }, { relations: defineRelations({ files }) }));
  closeRuntime = local.close;
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
  await orThrow(closeRuntime());
});

afterEach(() => vi.restoreAllMocks());

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
  it.each([RandomSourceUnavailable(), UnexpectedDefect({ cause: new Error('private entropy detail') })])(
    'sends $code through the declared upload error map without private causes',
    async failure => {
      vi.spyOn(fileId, 'create').mockReturnValue(failure);
      const caught = await clientFor(alice)
        .files.createUpload({ mime: 'text/plain', size: 1 })
        .catch((error: unknown) => error);
      expect(caught).toMatchObject({ code: failure.code, status: failure.status, defined: true });
      expect(reviveRpcError(caught, CREATE_UPLOAD_FAILURES)).toMatchObject({
        code: failure.code,
        data: failure.data,
      });
      expect(JSON.stringify(caught)).not.toContain('private entropy detail');
    },
  );
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

  // A returned failure is part of the contract: the client gets it declared and typed, and
  // can revive it to branch on. Thrown faults stay plain oRPC codes with the ARKI_FS code in data.
  it('sends returned failures as declared errors, and thrown faults as oRPC codes (E001 → BAD_REQUEST)', async () => {
    const ticket = await clientFor(alice).files.createUpload({ mime: 'text/plain', size: 2 });

    const asBob = await clientFor(bob)
      .files.confirmUpload({ fileId: ticket.fileId })
      .catch((error: unknown) => error);
    expect(asBob).toBeInstanceOf(ORPCError);
    expect(asBob).toMatchObject({
      code: 'fs.file_unavailable',
      status: 404,
      defined: true,
      data: { fileId: ticket.fileId },
    });
    expect(FileUnavailable.is(reviveRpcError(asBob, [FileUnavailable]))).toBe(true);

    const early = await clientFor(alice)
      .files.confirmUpload({ fileId: ticket.fileId })
      .catch((error: unknown) => error);
    expect(early).toMatchObject({ code: 'fs.upload_pending', status: 409, defined: true });
    expect(reviveRpcError(early, [FileUnavailable, UploadPending])).toMatchObject({
      code: 'fs.upload_pending',
      data: { fileId: ticket.fileId },
    });

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
