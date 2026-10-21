import { describe, expect, it } from 'vitest';

import type { EmbedFailure } from '../failures.js';
import type { EmbeddingBatch } from '../types.js';
import { withCache } from '../cache.js';
import { isEmbedFailure } from '../failures.js';
import { fakeEmbedder } from '../testing/index.js';
import { kvCacheStore } from './index.js';

/** A Map behind JSON, as `@arki/kv` serialises values: what a Uint8Array would not survive. */
function jsonKv() {
  const entries = new Map<string, string>();
  const calls: unknown[][] = [];
  return {
    calls,
    get: (key: string): Promise<unknown> => {
      const text = entries.get(key);
      return Promise.resolve(text === undefined ? undefined : JSON.parse(text));
    },
    set: (key: string, value: unknown, expirationSeconds?: number) => {
      calls.push([key, value, expirationSeconds]);
      entries.set(key, JSON.stringify(value));
      return Promise.resolve(true);
    },
  };
}

async function ok(pending: Promise<EmbeddingBatch | EmbedFailure>): Promise<EmbeddingBatch> {
  const result = await pending;
  if (isEmbedFailure(result)) throw new Error(`unexpected failure: ${result.code}`);
  return result;
}

describe('kvCacheStore', () => {
  it('round-trips bytes through a KV client that serialises through JSON', async () => {
    const store = kvCacheStore(jsonKv());
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);

    await store.set('k', bytes);

    expect(await store.get('k')).toEqual(bytes);
    expect(await store.get('missing')).toBeUndefined();
  });

  it('a value another writer left under the key reads as a miss, never as junk bytes', async () => {
    const kv = jsonKv();
    await kv.set('arki:embeddings:k', { not: 'base64' });

    expect(await kvCacheStore(kv).get('k')).toBeUndefined();
  });

  it('prefixes keys and turns ttlMs into whole seconds, rounded up', async () => {
    const kv = jsonKv();

    await kvCacheStore(kv, { prefix: 'p:' }).set('k', new Uint8Array([1]), 1500);

    expect(kv.calls).toEqual([['p:k', 'AQ==', 2]]);
  });

  it('serves withCache: the second embed of a text is a hit with the same vector', async () => {
    const embedder = withCache(fakeEmbedder({ dimensions: 8 }), kvCacheStore(jsonKv()));
    const first = await ok(embedder.embed(['a'], {}));
    const second = await ok(embedder.embed(['a'], {}));

    expect(second.usage.cacheHits).toBe(1);
    expect(second.vectors).toEqual(first.vectors);
  });
});
