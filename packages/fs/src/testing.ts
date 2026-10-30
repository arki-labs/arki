/**
 * `@arki/fs/testing`: an in-memory {@link SignedUploadAdapter} for tests.
 *
 * Signed URLs are real URLs with a random token. `browserPut(url, body, headers)`
 * plays the browser's PUT and enforces what a real store enforces for a
 * signed upload: expiry, `Content-Type`, `Content-Length` and `If-None-Match: *`.
 * Node and Bun only (it uses `node:crypto` and `Buffer`).
 */
import { createHash, randomUUID } from 'node:crypto';

import type { SignedUrlOptions, StoredFile, StoredFileMetadata, StoreOptions } from './storage/types.js';

const BASE_URL = 'https://memory.arki.invalid';

type StoredObject = {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly etag: string;
  readonly lastModified: Date;
};
type Grant = Required<Pick<SignedUrlOptions, 'operation'>> &
  Pick<SignedUrlOptions, 'contentType' | 'contentLength' | 'ifNoneMatch'> & {
    readonly key: string;
    readonly expiresAt: number;
  };

export type MemoryUploadAdapter = ReturnType<typeof memoryUploadAdapter>;

function getUrl(key: string): string {
  return `${BASE_URL}/${encodeURI(key)}`;
}

function etagOf(bytes: Uint8Array): string {
  return `"${createHash('md5').update(bytes).digest('hex')}"`;
}

/** An in-memory store with signed uploads. One instance per test. */
export function memoryUploadAdapter() {
  const objects = new Map<string, StoredObject>();
  const grants = new Map<string, Grant>();

  const store = (key: string, bytes: Uint8Array, contentType: string): StoredObject => {
    const object = { bytes: Uint8Array.from(bytes), contentType, etag: etagOf(bytes), lastModified: new Date() };
    objects.set(key, object);
    return object;
  };

  return {
    capabilities: { signedPut: true as const },

    put(key: string, data: Buffer, options?: StoreOptions): Promise<StoredFile> {
      const object = store(key, data, options?.contentType ?? 'application/octet-stream');
      return Promise.resolve({
        key,
        size: object.bytes.byteLength,
        url: getUrl(key),
        contentType: object.contentType,
        etag: object.etag,
      });
    },

    get(key: string): Promise<Buffer | null> {
      const object = objects.get(key);
      return Promise.resolve(object ? Buffer.from(object.bytes) : null);
    },

    delete(key: string): Promise<void> {
      objects.delete(key);
      return Promise.resolve();
    },

    deleteMany(keys: string[]): Promise<void> {
      for (const key of keys) objects.delete(key);
      return Promise.resolve();
    },

    exists(key: string): Promise<boolean> {
      return Promise.resolve(objects.has(key));
    },

    getUrl,

    getSignedUrl(key: string, options?: SignedUrlOptions): Promise<string> {
      const token = randomUUID();
      const expiresIn = options?.expiresIn ?? 3600;
      grants.set(token, {
        key,
        operation: options?.operation ?? 'get',
        contentType: options?.contentType,
        contentLength: options?.contentLength,
        ifNoneMatch: options?.ifNoneMatch,
        expiresAt: Date.now() + expiresIn * 1000,
      });
      return Promise.resolve(`${getUrl(key)}?X-Memory-Token=${token}&X-Memory-Expires=${String(expiresIn)}`);
    },

    getMetadata(key: string): Promise<StoredFileMetadata | null> {
      const object = objects.get(key);
      if (!object) return Promise.resolve(null);
      return Promise.resolve({
        key,
        size: object.bytes.byteLength,
        contentType: object.contentType,
        lastModified: object.lastModified,
        etag: object.etag,
      });
    },

    list(prefix: string): Promise<string[]> {
      return Promise.resolve([...objects.keys()].filter(key => key.startsWith(prefix)));
    },

    browserPut(url: string, body: Uint8Array, headers: Record<string, string>): Promise<Response> {
      const lower = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
      const grant = grants.get(new URL(url).searchParams.get('X-Memory-Token') ?? '');
      const forbidden = (reason: string) => Promise.resolve(new Response(reason, { status: 403 }));

      if (!grant || grant.operation !== 'put') return forbidden('no PUT grant for this URL');
      if (Date.now() > grant.expiresAt) return forbidden('the URL expired');
      if (grant.contentType !== undefined && lower.get('content-type') !== grant.contentType) {
        return forbidden('Content-Type differs from the signed one');
      }
      if (grant.contentLength !== undefined && body.byteLength !== grant.contentLength) {
        return forbidden('Content-Length differs from the signed one');
      }
      if (grant.ifNoneMatch !== undefined && lower.get('if-none-match') !== grant.ifNoneMatch) {
        return forbidden('If-None-Match was signed but not sent');
      }
      if (grant.ifNoneMatch === '*' && objects.has(grant.key)) {
        return Promise.resolve(new Response('the object exists', { status: 412 }));
      }
      const object = store(grant.key, body, lower.get('content-type') ?? 'application/octet-stream');
      return Promise.resolve(new Response(null, { status: 200, headers: { ETag: object.etag } }));
    },
  };
}
