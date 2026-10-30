/**
 * Live provider conformance (T3). Proves on a real S3 or R2 bucket what the
 * offline tests can only show is signed: the store itself rejects a PUT with
 * another type, another length, a missing `If-None-Match`, a second PUT, or an
 * expired URL. Run with `bun run test:live`; it fails without the env below.
 *
 *   ARKI_FS_LIVE_ENDPOINT          https://<account>.r2.cloudflarestorage.com or https://s3.<region>.amazonaws.com
 *   ARKI_FS_LIVE_REGION            'auto' for R2
 *   ARKI_FS_LIVE_BUCKET            a private test bucket
 *   ARKI_FS_LIVE_ACCESS_KEY_ID
 *   ARKI_FS_LIVE_SECRET_ACCESS_KEY
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { orThrow } from '@arki/failure';

import { createS3StorageAdapter } from '../s3-adapter';

const liveEnv = z
  .object({
    ARKI_FS_LIVE_ENDPOINT: z.url(),
    ARKI_FS_LIVE_REGION: z.string().min(1),
    ARKI_FS_LIVE_BUCKET: z.string().min(1),
    ARKI_FS_LIVE_ACCESS_KEY_ID: z.string().min(1),
    ARKI_FS_LIVE_SECRET_ACCESS_KEY: z.string().min(1),
  })
  .parse(process.env);

const storage = createS3StorageAdapter({
  provider: 's3',
  bucket: liveEnv.ARKI_FS_LIVE_BUCKET,
  // An isolated prefix per run; every key is deleted afterwards.
  prefix: `arki-fs-live/${randomUUID()}`,
  region: liveEnv.ARKI_FS_LIVE_REGION,
  endpoint: liveEnv.ARKI_FS_LIVE_ENDPOINT,
  accessKeyId: liveEnv.ARKI_FS_LIVE_ACCESS_KEY_ID,
  secretAccessKey: liveEnv.ARKI_FS_LIVE_SECRET_ACCESS_KEY,
  baseUrl: liveEnv.ARKI_FS_LIVE_ENDPOINT,
});

const body = new TextEncoder().encode('hello, files table');
const used: string[] = [];

async function ticket(expiresIn = 300): Promise<{ key: string; url: string }> {
  const key = `${randomUUID()}.txt`;
  used.push(key);
  const url = orThrow(
    await storage.getSignedUrl(key, {
      operation: 'put',
      expiresIn,
      contentType: 'text/plain',
      contentLength: body.byteLength,
      ifNoneMatch: '*',
    }),
  );
  return { key, url };
}

const put = (url: string, headers: Record<string, string>, payload: Uint8Array = body) =>
  fetch(url, { method: 'PUT', headers, body: payload });

const signed = { 'Content-Type': 'text/plain', 'If-None-Match': '*' };

afterAll(async () => {
  orThrow(await storage.deleteMany(used));
});

describe('signed PUT on a live store', () => {
  it('stores the object when the request matches the signature', async () => {
    const { key, url } = await ticket();
    expect(await put(url, signed)).toHaveProperty('status', 200);
    const meta = orThrow(await storage.getMetadata(key));
    expect(meta).toMatchObject({ size: body.byteLength, contentType: 'text/plain' });
  });

  it('rejects another Content-Type', async () => {
    const { url } = await ticket();
    expect(await put(url, { ...signed, 'Content-Type': 'image/png' })).toHaveProperty('status', 403);
  });

  it('rejects a body of another length', async () => {
    const { url } = await ticket();
    expect(await put(url, signed, new TextEncoder().encode('short'))).toHaveProperty('status', 403);
  });

  it('rejects a PUT without If-None-Match', async () => {
    const { url } = await ticket();
    expect(await put(url, { 'Content-Type': 'text/plain' })).toHaveProperty('status', 403);
  });

  it('refuses a second PUT to the same URL (create-only)', async () => {
    const { url } = await ticket();
    expect(await put(url, signed)).toHaveProperty('status', 200);
    expect(await put(url, signed)).toHaveProperty('status', 412);
  });

  it('rejects an expired URL', async () => {
    const { url } = await ticket(1);
    await new Promise(resolve => setTimeout(resolve, 2500));
    expect(await put(url, signed)).toHaveProperty('status', 403);
  });
});
