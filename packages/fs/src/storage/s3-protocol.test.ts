/** The actual SDK signs and sends to an owned local HTTP server; no external bucket or credentials. */
import { createServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';

import { invariant, UnexpectedDefect } from '@arki/failure';

import { StorageRejected, StorageWriteUncertain } from './failures.js';
import { createS3StorageAdapter } from './s3-adapter.js';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

async function provider(mode: 'lost-ack' | 'refused' | 'missing' | 'incomplete') {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (mode === 'lost-ack') {
      request.resume();
      request.on('end', () => request.socket.destroy());
      return;
    }
    if (mode === 'incomplete') {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '1' });
      response.end();
      return;
    }
    response.writeHead(mode === 'missing' ? 404 : 403, { 'content-type': 'application/xml' });
    response.end(
      mode === 'missing'
        ? '<Error><Code>NoSuchKey</Code></Error>'
        : '<Error><Code>AccessDenied</Code><Message>owned refusal</Message></Error>',
    );
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  invariant(address !== null && typeof address !== 'string', 'Owned server must have an IP port.');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const storage = createS3StorageAdapter({
    provider: 's3',
    bucket: 'owned',
    region: 'us-east-1',
    endpoint,
    baseUrl: endpoint,
    accessKeyId: 'owned',
    secretAccessKey: 'owned',
  });
  return { storage, requests: () => requests };
}

it('does not replay a real SDK PUT after the local provider consumed its body but lost acknowledgement', async () => {
  const owned = await provider('lost-ack');
  expect(StorageWriteUncertain.is(await owned.storage.put('key', Buffer.from('owned body')))).toBe(true);
  expect(owned.requests()).toBe(1);
});

it('keeps a real provider refusal distinct from a missing object', async () => {
  const refused = await provider('refused');
  expect(StorageRejected.is(await refused.storage.exists('key'))).toBe(true);
  expect(StorageRejected.is(await refused.storage.put('key', Buffer.from('owned body')))).toBe(true);
  const missing = await provider('missing');
  expect(await missing.storage.get('key')).toBeNull();
  expect(await missing.storage.exists('key')).toBe(false);
});

it('never invents a modification timestamp when a provider omits required HEAD metadata', async () => {
  const owned = await provider('incomplete');
  expect(UnexpectedDefect.is(await owned.storage.getMetadata('key'))).toBe(true);
});
