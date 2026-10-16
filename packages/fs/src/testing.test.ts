import { describe, expect, it } from 'vitest';

import { memoryUploadAdapter } from './testing.js';

const body = new TextEncoder().encode('hello');
const signed = { 'Content-Type': 'text/plain', 'If-None-Match': '*' };

async function grant(adapter = memoryUploadAdapter(), expiresIn = 60) {
  const url = await adapter.getSignedUrl('files/a', {
    operation: 'put',
    expiresIn,
    contentType: 'text/plain',
    contentLength: body.byteLength,
    ifNoneMatch: '*',
  });
  return { adapter, url };
}

// The memory adapter stands in for S3/R2 in the lifecycle tests, so it must refuse what they refuse.
describe('memoryUploadAdapter', () => {
  it('stores a PUT that matches the signed headers', async () => {
    const { adapter, url } = await grant();
    expect(await adapter.browserPut(url, body, signed)).toHaveProperty('status', 200);
    expect(await adapter.getMetadata('files/a')).toMatchObject({ size: 5, contentType: 'text/plain' });
  });

  it('refuses another type, another length, or a missing If-None-Match with 403', async () => {
    const { adapter, url } = await grant();
    expect(await adapter.browserPut(url, body, { ...signed, 'Content-Type': 'image/png' })).toHaveProperty(
      'status',
      403,
    );
    expect(await adapter.browserPut(url, new Uint8Array(3), signed)).toHaveProperty('status', 403);
    expect(await adapter.browserPut(url, body, { 'Content-Type': 'text/plain' })).toHaveProperty('status', 403);
    expect(await adapter.exists('files/a')).toBe(false);
  });

  it('refuses a second PUT with 412: the grant is create-only', async () => {
    const { adapter, url } = await grant();
    await adapter.browserPut(url, body, signed);
    expect(await adapter.browserPut(url, body, signed)).toHaveProperty('status', 412);
  });

  it('refuses an expired URL and a GET URL used for PUT', async () => {
    const expired = await grant(memoryUploadAdapter(), -1);
    expect(await expired.adapter.browserPut(expired.url, body, signed)).toHaveProperty('status', 403);
    const adapter = memoryUploadAdapter();
    const getUrl = await adapter.getSignedUrl('files/a');
    expect(await adapter.browserPut(getUrl, body, signed)).toHaveProperty('status', 403);
  });
});
