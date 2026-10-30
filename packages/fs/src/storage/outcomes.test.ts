import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { FailureIn } from '@arki/failure';
import { InvalidInput, isFailure, orThrow } from '@arki/failure';

import type { LocalStorageAdapter } from './local-adapter.js';
import type { StorageReadFailure, StorageWriteFailure } from './types.js';
import { StorageCancelled, StorageRejected, StorageUnavailable, StorageWriteUncertain } from './failures.js';
import { createLocalStorageAdapter } from './local-adapter.js';
import { storageReadFailure, storageWriteFailure } from './operation.js';
import { S3StorageAdapter } from './s3-adapter.js';

const owned: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of owned.splice(0)) await rm(directory, { recursive: true, force: true });
});

it('keeps a hardware I/O outage distinct from absence and from an unconfirmed dispatched write', () => {
  const error = Object.assign(new Error('owned I/O failure'), { code: 'EIO' });
  expect(StorageUnavailable.is(storageReadFailure(error))).toBe(true);
  expect(StorageWriteUncertain.is(storageWriteFailure(error))).toBe(true);
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'arki-fs-outcomes-'));
  owned.push(directory);
  const base = path.join(directory, 'base');
  await mkdir(base);
  await writeFile(path.join(directory, 'sentinel'), 'outside');
  return {
    directory,
    base,
    storage: createLocalStorageAdapter({ provider: 'local', basePath: base, baseUrl: 'https://audit.invalid' }),
  };
}

describe('local key confinement', () => {
  it('uses one path policy for reads, writes, delete, metadata and list', async () => {
    const { directory, storage } = await fixture();
    for (const key of ['../sentinel', '/absolute', 'a/../../sentinel', 'a\\..\\sentinel']) {
      expect(InvalidInput.is(await storage.get(key))).toBe(true);
      expect(InvalidInput.is(await storage.put(key, Buffer.from('bad')))).toBe(true);
      expect(InvalidInput.is(await storage.delete(key))).toBe(true);
      expect(InvalidInput.is(await storage.exists(key))).toBe(true);
      expect(InvalidInput.is(await storage.getMetadata(key))).toBe(true);
      expect(InvalidInput.is(await storage.list(key))).toBe(true);
    }
    expect(await readFile(path.join(directory, 'sentinel'), 'utf8')).toBe('outside');
  });

  it('refuses leaf and directory symlinks rather than reading or overwriting their targets', async () => {
    const { directory, base, storage } = await fixture();
    await symlink(path.join(directory, 'sentinel'), path.join(base, 'leaf'));
    await symlink(directory, path.join(base, 'linked'));
    for (const key of ['leaf', 'linked/sentinel']) {
      expect(StorageRejected.is(await storage.get(key))).toBe(true);
      expect(StorageRejected.is(await storage.put(key, Buffer.from('bad')))).toBe(true);
      expect(StorageRejected.is(await storage.delete(key))).toBe(true);
      expect(StorageRejected.is(await storage.getMetadata(key))).toBe(true);
      expect(StorageRejected.is(await storage.exists(key))).toBe(true);
    }
    expect(StorageRejected.is(await storage.list('linked'))).toBe(true);
    expect(await storage.list('')).toEqual([]);
    expect(await readFile(path.join(directory, 'sentinel'), 'utf8')).toBe('outside');
  });

  it('preserves backend refusal instead of turning ENOTDIR into absence', async () => {
    const { directory } = await fixture();
    const storage = createLocalStorageAdapter({
      provider: 'local',
      basePath: path.join(directory, 'sentinel'),
      baseUrl: 'https://audit.invalid',
    });
    expect(StorageRejected.is(await storage.exists('child'))).toBe(true);
    expect(StorageRejected.is(await storage.get('child'))).toBe(true);
    expect(StorageRejected.is(await storage.getMetadata('child'))).toBe(true);
  });

  it('keeps intentional missing values and confirmed local writes unwrapped', async () => {
    const { storage } = await fixture();
    expect(await storage.get('missing')).toBeNull();
    expect(await storage.exists('missing')).toBe(false);
    orThrow(await storage.put('folder/file', Buffer.from('owned')));
    expect(orThrow(await storage.get('folder/file'))?.toString()).toBe('owned');
    expect(await storage.list('')).toEqual(['folder/file']);
    orThrow(await storage.delete('folder/file'));
    expect(await storage.get('folder/file')).toBeNull();
  });
});

function s3() {
  return new S3StorageAdapter({
    provider: 's3',
    bucket: 'owned',
    region: 'auto',
    endpoint: 'https://audit.invalid',
    baseUrl: 'https://audit.invalid',
    accessKeyId: 'owned',
    secretAccessKey: 'owned',
  });
}
// The SDK command boundary is injected here; prefix/live conformance suites exercise actual providers separately.
function refuse(error: Error) {
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- SDK send has a legacy callback overload.
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(() => Promise.reject(error));
}

it('distinguishes a failed read, a definite refusal and a dispatched write without acknowledgement', async () => {
  const storage = s3();
  refuse(Object.assign(new Error('private socket detail'), { code: 'ECONNRESET' }));
  expect(StorageUnavailable.is(await storage.exists('key'))).toBe(true);
  expect(StorageWriteUncertain.is(await storage.put('key', Buffer.from('owned')))).toBe(true);
  expect(StorageWriteUncertain.is(await storage.delete('key'))).toBe(true);
  vi.restoreAllMocks();
  refuse(Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }));
  expect(StorageRejected.is(await storage.get('key'))).toBe(true);
  expect(StorageRejected.is(await storage.put('key', Buffer.from('owned')))).toBe(true);
});

it('does not dispatch SDK commands for a pre-cancelled operation', async () => {
  const spy = vi.spyOn(S3Client.prototype, 'send');
  const storage = s3();
  const options = { signal: AbortSignal.abort() };
  expect(StorageCancelled.is(await storage.put('key', Buffer.from('owned'), options))).toBe(true);
  expect(StorageCancelled.is(await storage.get('key', options))).toBe(true);
  expect(StorageCancelled.is(await storage.delete('key', options))).toBe(true);
  expect(spy).not.toHaveBeenCalled();
});

it('keeps a confirmed PUT successful without a fallible follow-up HEAD', async () => {
  const commands: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- SDK send has a legacy callback overload.
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(command => {
    commands.push(command);
    return command instanceof PutObjectCommand
      ? Promise.resolve({ ETag: 'owned' })
      : Promise.reject(new Error('unexpected follow-up'));
  });
  const stored = await s3().put('key', Buffer.from('owned'));
  expect(isFailure(stored)).toBe(false);
  expect(commands).toHaveLength(1);
  expect(commands[0]).toBeInstanceOf(PutObjectCommand);
  expect(commands.some(command => command instanceof HeadObjectCommand || command instanceof DeleteObjectCommand)).toBe(
    false,
  );
});

it('locks the declared read and write failure sets to their canonical source tuples', () => {
  type Storage = ReturnType<typeof createLocalStorageAdapter>;
  expectTypeOf<FailureIn<Awaited<ReturnType<Storage['get']>>>>().toEqualTypeOf<StorageReadFailure>();
  expectTypeOf<FailureIn<Awaited<ReturnType<Storage['put']>>>>().toEqualTypeOf<StorageWriteFailure>();
  expectTypeOf<FailureIn<Awaited<ReturnType<LocalStorageAdapter['get']>>>>().toEqualTypeOf<StorageReadFailure>();
  expectTypeOf<FailureIn<Awaited<ReturnType<LocalStorageAdapter['put']>>>>().toEqualTypeOf<StorageWriteFailure>();
});
