/**
 * `@arki/embeddings/kv`: a `CacheStore` over an `@arki/kv` client (or anything with its `get` and
 * `set`), so `withCache` shares vectors across processes through Redis.
 */
import { z } from 'zod';

import type { CacheStore } from '../types.js';

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
 * as a miss, so `withCache` embeds again instead of decoding junk.
 *
 * @example
 * const embedder = withCache(base, kvCacheStore(kv, { prefix: 'reader:emb:' }), { ttlMs: 7 * 86_400_000 });
 */
export function kvCacheStore(
  // The two `KV` methods used. `get` answers `unknown`: the value is checked, not trusted to a type argument.
  kv: {
    get(key: string): Promise<unknown>;
    set(key: string, value: string, expirationSeconds?: number): Promise<unknown>;
  },
  options: { readonly prefix?: string } = {},
): CacheStore {
  const prefix = options.prefix ?? 'arki:embeddings:';
  return {
    async get(key) {
      const parsed = storedValueSchema.safeParse(await kv.get(prefix + key));
      return parsed.success ? fromBase64(parsed.data) : undefined;
    },
    async set(key, value, ttlMs) {
      await kv.set(
        prefix + key,
        toBase64(value),
        ttlMs === undefined ? undefined : Math.max(1, Math.ceil(ttlMs / 1000)),
      );
    },
  };
}
