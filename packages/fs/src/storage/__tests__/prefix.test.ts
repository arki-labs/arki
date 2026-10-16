/**
 * The key prefix is applied exactly once. Before the fix, Flystorage got the
 * prefix too, so writes landed at `p/p/key` while signed URLs and HEAD used
 * `p/key`: an uploaded object could never be confirmed or served.
 */
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isFileStorageError } from '../../files/errors.js';
import { createS3StorageAdapter } from '../s3-adapter';

type Sent = { readonly command: string; readonly key: string | undefined };

/** Records every command's key (or list prefix) and answers like an S3 bucket holding `p/a.txt`. */
const TEXT_HEAD = { ContentLength: 1, ContentType: 'text/plain' };

function stubClient(head: { ContentLength?: number; ContentType?: string }) {
  const sent: Sent[] = [];
  // `send` is overloaded; the spy takes the callback overload's `void` return, while the SDK awaits the promise one.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  vi.spyOn(S3Client.prototype, 'send').mockImplementation((command: unknown) => {
    if (command instanceof PutObjectCommand) {
      sent.push({ command: 'put', key: command.input.Key });
      return Promise.resolve({ ETag: '"e"' });
    }
    if (command instanceof HeadObjectCommand) {
      sent.push({ command: 'head', key: command.input.Key });
      return Promise.resolve({ ...head, LastModified: new Date(), ETag: '"e"' });
    }
    if (command instanceof DeleteObjectCommand) {
      sent.push({ command: 'delete', key: command.input.Key });
      return Promise.resolve({});
    }
    if (command instanceof ListObjectsV2Command) {
      sent.push({ command: 'list', key: command.input.Prefix });
      return Promise.resolve({ Contents: [{ Key: 'p/a.txt', Size: 1 }], IsTruncated: false });
    }
    return Promise.reject(new Error(`unexpected command ${String(command)}`));
  });
  return sent;
}

const adapter = (prefix?: string) =>
  createS3StorageAdapter({
    provider: 's3',
    bucket: 'b',
    prefix,
    region: 'auto',
    endpoint: 'https://s3.example.com',
    accessKeyId: 'AKIA_TEST',
    secretAccessKey: 'secret_test',
    baseUrl: 'https://cdn.example.com',
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('S3 adapter key prefix', () => {
  it('addresses p/key once for put, HEAD, delete, list and signed URLs', async () => {
    const sent = stubClient(TEXT_HEAD);
    const storage = adapter('p');

    await storage.put('a.txt', Buffer.from('x'), { contentType: 'text/plain' });
    await storage.getMetadata('a.txt');
    await storage.delete('a.txt');
    expect(await storage.list('')).toEqual(['a.txt']);
    const signed = new URL(await storage.getSignedUrl('a.txt', { operation: 'put' }));

    for (const entry of sent.filter(entry => entry.command !== 'list')) expect(entry.key).toBe('p/a.txt');
    expect(sent.map(entry => entry.command)).toEqual(expect.arrayContaining(['put', 'head', 'delete', 'list']));
    expect(signed.pathname).toBe('/b/p/a.txt');
  });

  it('uses the bare key without a prefix', async () => {
    const sent = stubClient(TEXT_HEAD);
    await adapter().getMetadata('a.txt');
    expect(sent).toEqual([{ command: 'head', key: 'a.txt' }]);
  });
});

describe('S3 adapter getMetadata', () => {
  // The files table compares size and type against its row; an invented 0 or octet-stream would lie.
  it('throws ARKI_FS_E007 instead of inventing a size or type', async () => {
    stubClient({ ContentType: 'text/plain' });
    const error: unknown = await adapter()
      .getMetadata('a.txt')
      .catch((error_: unknown) => error_);
    expect(isFileStorageError(error) && error.code).toBe('ARKI_FS_E007');
  });
});
