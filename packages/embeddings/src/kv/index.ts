/**
 * `@arki/embeddings/kv`: a `CacheStore` over an `@arki/kv` client (or anything with its `get` and
 * `set`), so `withCache` shares vectors across processes through Redis.
 */
import { z } from 'zod';

import type { Failure } from '@arki/failure';
import { isFailure } from '@arki/failure';
import { getLogger } from '@arki/log';

import type { CacheStore } from '../types.js';

const log = getLogger('arki:embeddings');

/** What `kvCacheStore` stores per key: the cached bytes as base64, because the KV client serialises through JSON. */
const storedValueSchema = z.base64();

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let position = 0; position < binary.length; position++) bytes[position] = binary.codePointAt(position) ?? 0;
  return bytes;
}

/**
 * A `CacheStore` over `kv`. Keys get `prefix` (default `'arki:embeddings:'`); a `ttlMs` becomes
 * whole seconds, rounded up. A stored value that is not base64 (another writer, a stray key) reads
 * as a miss, so `withCache` embeds again instead of decoding junk. A KV failure (Redis down, a
 * cancelled command) is a cache, so it is logged and read as a miss, or the write is skipped.
 *
 * @example
 * const embedder = withCache(base, kvCacheStore(kv, { prefix: 'reader:emb:' }), { ttlMs: 7 * 86_400_000 });
 */
export function kvCacheStore(
  // The two `KV` methods used. `get` checks the value against `storedValueSchema`; a failure is a miss.
  kv: {
    get(key: string, schema: typeof storedValueSchema): Promise<string | undefined | Failure>;
    set(key: string, value: string, expirationSeconds?: number): Promise<unknown>;
  },
  options: { readonly prefix?: string } = {},
): CacheStore {
  const prefix = options.prefix ?? 'arki:embeddings:';
  return {
    async get(key) {
      const stored = await kv.get(prefix + key, storedValueSchema);
      if (isFailure(stored)) {
        log.warn('embedding cache read failed; treated as a miss: {code}: {message}', {
          code: stored.code,
          message: stored.message,
        });
        return;
      }
      return stored === undefined ? undefined : fromBase64(stored);
    },
    async set(key, value, ttlMs) {
      const written = await kv.set(
        prefix + key,
        toBase64(value),
        ttlMs === undefined ? undefined : Math.max(1, Math.ceil(ttlMs / 1000)),
      );
      if (isFailure(written)) {
        log.warn('embedding cache write failed; the vector is returned uncached: {code}: {message}', {
          code: written.code,
          message: written.message,
        });
      }
    },
  };
}
