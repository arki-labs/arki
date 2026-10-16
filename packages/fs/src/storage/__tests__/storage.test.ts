import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';

import type { SignedUploadAdapter } from '../types';
import { createLocalStorageAdapter } from '../local-adapter';
import { createR2Storage } from '../r2';

describe('createR2Storage', () => {
  const storage = createR2Storage({
    accountId: 'acct123',
    accessKeyId: 'AKIA_TEST',
    secretAccessKey: 'secret_test',
    bucket: 'my-bucket',
    publicUrl: 'https://cdn.example.com',
  });

  it('exposes the full StorageAdapter interface, including signed URLs and metadata', () => {
    for (const method of [
      'put',
      'get',
      'delete',
      'deleteMany',
      'exists',
      'getUrl',
      'getSignedUrl',
      'getMetadata',
      'list',
    ]) {
      expect(typeof (storage as unknown as Record<string, unknown>)[method]).toBe('function');
    }
  });

  it('serves public URLs from the configured publicUrl', () => {
    expect(storage.getUrl('characters/abc/ref.png')).toBe('https://cdn.example.com/characters/abc/ref.png');
  });

  it('presigns GET URLs against the Cloudflare R2 endpoint (offline)', async () => {
    const url = await storage.getSignedUrl('characters/abc/ref.png', { expiresIn: 600 });

    // The signed URL must target the R2 S3 API host derived from the account id,
    // reference the object key, and carry SigV4 query parameters.
    expect(url).toContain('acct123.r2.cloudflarestorage.com');
    expect(url).toContain('characters/abc/ref.png');
    expect(url).toContain('X-Amz-Signature=');
    expect(url).toContain('X-Amz-Expires=600');
  });

  it('presigns PUT URLs when operation is "put"', async () => {
    const url = await storage.getSignedUrl('uploads/new.png', { operation: 'put' });
    expect(url).toContain('X-Amz-Signature=');
    expect(url).toContain('uploads/new.png');
  });

  // The store rejects an upload only for what the signature covers. Without these three,
  // a leaked PUT URL could store any type, any size, or overwrite a confirmed object.
  it('signs Content-Type, Content-Length and If-None-Match into a PUT URL', async () => {
    const url = new URL(
      await storage.getSignedUrl('uploads/new.png', {
        operation: 'put',
        contentType: 'image/png',
        contentLength: 1234,
        ifNoneMatch: '*',
      }),
    );
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host;if-none-match');
  });

  // SDK 3.1147 defaults to computing a checksum for every request. For a presigned PUT that is
  // the CRC32 of an EMPTY body, so a real upload would fail the check on the store.
  it('puts no empty-body checksum into PUT URLs', async () => {
    const url = await storage.getSignedUrl('uploads/new.png', { operation: 'put', contentType: 'image/png' });
    const names = [...new URL(url).searchParams.keys()].map(name => name.toLowerCase());
    expect(names.filter(name => name.includes('checksum'))).toEqual([]);
  });

  it('is a SignedUploadAdapter; the local adapter is not', () => {
    expect(storage.capabilities.signedPut).toBe(true);
    expectTypeOf(storage).toExtend<SignedUploadAdapter>();
    expectTypeOf(createLocalStorageAdapter).returns.not.toExtend<SignedUploadAdapter>();
  });
});

describe('LocalStorageAdapter (new capabilities)', () => {
  let dir: string;
  let storage: ReturnType<typeof createLocalStorageAdapter>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arki-fs-test-'));
    storage = createLocalStorageAdapter({ provider: 'local', basePath: dir, baseUrl: 'https://cdn.local' });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the public URL as the "signed" URL (local has no signing)', async () => {
    await storage.put('a/b.png', Buffer.from('x'), { contentType: 'image/png' });
    expect(await storage.getSignedUrl('a/b.png')).toBe('https://cdn.local/a/b.png');
  });

  it('returns metadata with size and inferred content type', async () => {
    await storage.put('a/c.json', Buffer.from('{"k":1}'), { contentType: 'application/json' });
    const meta = await storage.getMetadata('a/c.json');

    expect(meta).not.toBeNull();
    expect(meta?.size).toBe(7);
    expect(meta?.contentType).toBe('application/json');
    expect(meta?.lastModified).toBeInstanceOf(Date);
  });

  it('returns null metadata for a missing key', async () => {
    expect(await storage.getMetadata('does/not/exist.png')).toBeNull();
  });
});
