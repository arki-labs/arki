import { z } from 'zod';

import { invariant, isFailure } from '@arki/failure';
import { getLogger } from '@arki/log';

import type {
  CacheStore,
  Embedder,
  Embedding,
  EmbeddingSpace,
  EmbedInput,
  EmbedMiddleware,
  EmbedOptions,
  Quantization,
} from './types.js';
import { InvalidOutput } from './failures.js';
import { withMiddleware } from './middleware.js';
import { sha256Hex } from './sha256.js';
import { spaceId } from './space.js';

/** The first byte of a cached value: which typed array the rest of the bytes hold. */
const DTYPE_TAG = { float32: 0, int8: 1, binary: 2 } as const satisfies Record<Quantization, number>;

/** Options `withCache` takes after the store. */
type CacheOptions = {
  /**
   * `true` (default): a cached vector whose length or dtype disagrees with the space is
   * `InvalidOutput`. `false`: such an entry counts as a miss and is embedded again.
   */
  readonly strict?: boolean;
  /** Mixed into every key, so two caches can share one store without sharing entries. */
  readonly namespace?: string;
  /** Passed to `store.set`; absent = the store's own default (no expiry for `memoryCacheStore`). */
  readonly ttlMs?: number;
};

/** Little-endian, so a cache shared through Redis reads the same on every machine. */
function encode(vector: Embedding['vector']): Uint8Array {
  if (vector instanceof Float32Array) {
    const bytes = new Uint8Array(1 + vector.length * 4);
    bytes[0] = DTYPE_TAG.float32;
    const view = new DataView(bytes.buffer);
    for (const [position, value] of vector.entries()) view.setFloat32(1 + position * 4, value, true);
    return bytes;
  }
  const bytes = new Uint8Array(1 + vector.length);
  bytes[0] = vector instanceof Int8Array ? DTYPE_TAG.int8 : DTYPE_TAG.binary;
  bytes.set(new Uint8Array(vector.buffer, vector.byteOffset, vector.length), 1);
  return bytes;
}

/** A store's bytes → the vector they hold: a known dtype tag, then a whole number of values. */
const cachedVectorSchema = z.instanceof(Uint8Array).transform((bytes, context): Embedding['vector'] => {
  const tag = bytes[0];
  const body = bytes.subarray(1);
  if (tag === DTYPE_TAG.int8) return new Int8Array(new Uint8Array(body).buffer);
  if (tag === DTYPE_TAG.binary) return new Uint8Array(body);
  if (tag === DTYPE_TAG.float32 && body.length % 4 === 0) {
    const view = new DataView(body.buffer, body.byteOffset, body.length);
    const vector = new Float32Array(body.length / 4);
    for (let position = 0; position < vector.length; position++) vector[position] = view.getFloat32(position * 4, true);
    return vector;
  }
  context.addIssue({ code: 'custom', message: `unknown dtype tag ${String(tag)} or a partial value` });
  return z.NEVER;
});

/** Whether a decoded vector belongs to the space: its dtype and its length (one bit per dimension when binary). */
function fits(vector: Embedding['vector'], space: EmbeddingSpace): boolean {
  if (space.quantization === 'binary')
    return vector instanceof Uint8Array && vector.length === Math.ceil(space.dimensions / 8);
  const dtype = space.quantization === 'int8' ? Int8Array : Float32Array;
  return vector instanceof dtype && vector.length === space.dimensions;
}

/** The text a cacheable input embeds; `undefined` for an image input, which always goes to the provider. */
function cacheableText(input: EmbedInput): string | undefined {
  if (typeof input === 'string') return input;
  return input.image === undefined ? input.text : undefined;
}

/**
 * The format of a cached value (`encode`), first in every key. A new format gets a new version, so
 * its values sit under other keys: an old entry misses instead of failing strict mode.
 */
const VALUE_FORMAT = 'v1';

/**
 * sha256 over everything that changes the vector: the value format, the space (model, revision,
 * size, dtype, instruction version), the purpose (it picks the prefix), the truncation choice, the
 * namespace and the exact text. The fields are hashed as a JSON array, so a separator inside one
 * field never shifts into the next. Plain TypeScript, so the key is the same on every runtime,
 * Hermes included.
 */
function cacheKey(space: EmbeddingSpace, options: EmbedOptions, namespace: string, text: string): string {
  const material = JSON.stringify([
    VALUE_FORMAT,
    spaceId(space),
    options.purpose ?? '',
    space.dimensions,
    space.quantization,
    options.onTooLong === 'truncate' ? 'truncate' : 'fail',
    namespace,
    text,
  ]);
  return sha256Hex(new TextEncoder().encode(material));
}

const log = getLogger('arki:embeddings');

/** A store that throws is a cache that missed: embedding still works without it. */
async function read(store: CacheStore, key: string): Promise<Uint8Array | undefined> {
  try {
    return await store.get(key);
  } catch (error) {
    log.warn('embedding cache read failed; treated as a miss: {error}', { error: String(error) });
    return undefined;
  }
}

async function write(store: CacheStore, key: string, value: Uint8Array, ttlMs: number | undefined): Promise<void> {
  try {
    await store.set(key, value, ttlMs);
  } catch (error) {
    log.warn('embedding cache write failed; the vector is returned uncached: {error}', { error: String(error) });
  }
}

function cache(store: CacheStore, options: CacheOptions): EmbedMiddleware {
  const { strict = true, namespace = '', ttlMs } = options;
  return (next, embedder) => async (inputs, callOptions) => {
    const base = embedder.space;
    const space: EmbeddingSpace = {
      ...base,
      dimensions: callOptions.dimensions ?? base.dimensions,
      quantization: callOptions.quantization ?? base.quantization,
    };
    const texts = inputs.map(input => cacheableText(input));
    const stored = await Promise.all(
      texts.map(async text =>
        text === undefined ? undefined : await read(store, cacheKey(space, callOptions, namespace, text)),
      ),
    );

    const found: (Embedding['vector'] | undefined)[] = [];
    for (const [index, bytes] of stored.entries()) {
      const parsed = bytes === undefined ? undefined : cachedVectorSchema.safeParse(bytes);
      const vector = parsed?.success === true && fits(parsed.data, space) ? parsed.data : undefined;
      if (bytes !== undefined && vector === undefined && strict) {
        return InvalidOutput({ reason: `cache: the entry for input ${index} does not fit ${spaceId(space)}` });
      }
      found.push(vector);
    }
    const missing = inputs.filter((_, index) => found[index] === undefined);
    const hits = inputs.length - missing.length;
    if (missing.length === 0) {
      const vectors = found.filter(vector => vector !== undefined);
      // Nothing was sent, so exactly zero tokens were spent.
      return { vectors, space, usage: { tokens: { basis: 'counted', count: 0 }, requests: 0, cacheHits: hits } };
    }

    const result = await next(missing, callOptions);
    if (isFailure(result)) return result;

    // Keys from the answer's space: a revision the provider reported on this call is part of it.
    let position = 0;
    const writes: Promise<void>[] = [];
    const vectors = found.map((vector, index) => {
      if (vector !== undefined) return vector;
      const fresh = result.vectors[position++];
      invariant(fresh !== undefined, 'the embedder answered fewer vectors than it was sent');
      const text = texts[index];
      if (text !== undefined) {
        writes.push(write(store, cacheKey(result.space, callOptions, namespace, text), encode(fresh), ttlMs));
      }
      return fresh;
    });
    await Promise.all(writes);
    return { vectors, space: result.space, usage: { ...result.usage, cacheHits: result.usage.cacheHits + hits } };
  };
}

/**
 * The same embedder with a vector cache in front. Cached inputs are filled from `store`; the
 * rest go to the provider as one call, in order. A key covers the space, the purpose, the
 * truncation choice, the namespace and the exact text, so a model, size or prompt change misses
 * instead of answering a wrong vector in the right shape. Image inputs always go to the provider.
 * `usage.cacheHits` counts the inputs the store answered.
 *
 * A store that throws is treated as a miss (reads) or skipped (writes) and logged at `warn`.
 * In strict mode, an entry that is not a vector of the space (another writer's value under the
 * key) fails every call that reads it until it expires, so set `ttlMs` on a shared store.
 *
 * @example
 * const embedder = withCache(base, memoryCacheStore({ maxEntries: 50_000 }));
 */
export function withCache(
  embedder: Embedder,
  store: CacheStore = memoryCacheStore(),
  options: CacheOptions = {},
): Embedder {
  return withMiddleware(embedder, cache(store, options));
}

/** What `memoryCacheStore` keeps per key. */
type MemoryEntry = { readonly value: Uint8Array; readonly expiresAt: number };

/**
 * An in-process LRU `CacheStore`. It copies on `set` and on `get`, so a caller that changes a
 * returned vector never changes the cache. The oldest-read entry goes first once `maxEntries`
 * (default 10 000) is reached; an entry set with `ttlMs` is gone after that many milliseconds.
 *
 * @example
 * const store = memoryCacheStore({ maxEntries: 50_000 });
 */
export function memoryCacheStore(options: { readonly maxEntries?: number } = {}): CacheStore {
  const maxEntries = options.maxEntries ?? 10_000;
  invariant(
    Number.isInteger(maxEntries) && maxEntries > 0,
    () => `maxEntries must be a positive integer, got ${maxEntries}`,
  );
  const entries = new Map<string, MemoryEntry>();
  const lookup = (key: string): Uint8Array | undefined => {
    const entry = entries.get(key);
    if (entry === undefined) return;
    entries.delete(key);
    if (entry.expiresAt <= Date.now()) return;
    // Re-inserted: a Map iterates in insertion order, so the first key is the least recently read.
    entries.set(key, entry);
    return new Uint8Array(entry.value);
  };
  return {
    get: key => Promise.resolve(lookup(key)),
    set(key, value, ttlMs) {
      entries.delete(key);
      entries.set(key, {
        value: new Uint8Array(value),
        expiresAt: ttlMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + ttlMs,
      });
      if (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done !== true) entries.delete(oldest.value);
      }
      return Promise.resolve();
    },
  };
}
