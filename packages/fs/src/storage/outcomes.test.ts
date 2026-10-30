import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { FailureIn } from '@arki/failure';
import { InvalidInput, isFailure, orThrow, UnexpectedDefect } from '@arki/failure';

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

describe('local adapter cancellation and refusals', () => {
  it('a cancelled signal returns StorageCancelled from every local operation and writes nothing', async () => {
    const { storage } = await fixture();
    const options = { signal: AbortSignal.abort() };
    expect(StorageCancelled.is(await storage.put('new', Buffer.from('x'), options))).toBe(true);
    expect(StorageCancelled.is(await storage.get('new', options))).toBe(true);
    expect(StorageCancelled.is(await storage.delete('new', options))).toBe(true);
    expect(StorageCancelled.is(await storage.getMetadata('new', options))).toBe(true);
    expect(StorageCancelled.is(await storage.exists('new', options))).toBe(true);
    expect(StorageCancelled.is(await storage.list('', options))).toBe(true);
    expect(StorageCancelled.is(await storage.getSignedUrl('new', options))).toBe(true);
    expect(await storage.list('')).toEqual([]);
  });

  it('a key that names a directory is refused with StorageRejected on every operation, and nothing is overwritten', async () => {
    const { base, storage } = await fixture();
    await mkdir(path.join(base, 'dir'));
    expect(StorageRejected.is(await storage.put('dir', Buffer.from('x')))).toBe(true);
    expect(StorageRejected.is(await storage.get('dir'))).toBe(true);
    expect(StorageRejected.is(await storage.delete('dir'))).toBe(true);
    expect(StorageRejected.is(await storage.getMetadata('dir'))).toBe(true);
    expect(StorageRejected.is(await storage.exists('dir'))).toBe(true);
  });

  it('deleteMany stops at the first failure, keeps earlier deletes, and signed URLs use the same key policy', async () => {
    const { storage } = await fixture();
    orThrow(await storage.put('keep/a', Buffer.from('a')));
    orThrow(await storage.put('keep/b', Buffer.from('b')));
    expect(InvalidInput.is(await storage.deleteMany(['keep/a', '../escape', 'keep/b']))).toBe(true);
    expect(await storage.get('keep/a')).toBeNull();
    expect(orThrow(await storage.get('keep/b'))?.toString()).toBe('b');
    expect(InvalidInput.is(await storage.getSignedUrl('../escape'))).toBe(true);
    expect(await storage.getSignedUrl('keep/b')).toBe('https://audit.invalid/keep/b');
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

it('returns the right failure for S3 list, metadata and bulk delete, and never invents a list', async () => {
  const storage = s3();
  refuse(Object.assign(new Error('socket'), { code: 'ECONNRESET' }));
  expect(StorageUnavailable.is(await storage.list(''))).toBe(true);
  expect(StorageUnavailable.is(await storage.getMetadata('key'))).toBe(true);
  expect(StorageWriteUncertain.is(await storage.deleteMany(['a', 'b']))).toBe(true);
  vi.restoreAllMocks();
  refuse(Object.assign(new Error('missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }));
  expect(await storage.getMetadata('key')).toBeNull();
  expect(await storage.exists('key')).toBe(false);
  expect(await storage.get('key')).toBeNull();
  vi.restoreAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- SDK send has a legacy callback overload.
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(command =>
    command instanceof ListObjectsV2Command ? Promise.resolve({ IsTruncated: true, Contents: [] }) : Promise.reject(new Error('unexpected')),
  );
  expect(UnexpectedDefect.is(await storage.list(''))).toBe(true);
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
