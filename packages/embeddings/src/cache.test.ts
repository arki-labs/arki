import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EmbedFailure } from './failures.js';
import type { CacheStore, Embedder, EmbeddingBatch } from './types.js';
import { memoryCacheStore, withCache } from './cache.js';
import { InvalidOutput, isEmbedFailure } from './failures.js';
import { createEmbedder } from './embedder.js';
import { withMiddleware } from './middleware.js';
import { calibrateInt8 } from './quantize.js';
import { echoTexts, stubModel } from './tests/stub-model.js';
import { sha256Hex } from './sha256.js';
import { spaceId } from './space.js';
import { fakeEmbedder } from './testing/index.js';

/** The batch, or the test fails with the failure's code. */
async function ok(pending: Promise<EmbeddingBatch | EmbedFailure>): Promise<EmbeddingBatch> {
  const result = await pending;
  if (isEmbedFailure(result)) throw new Error(`unexpected failure: ${result.code}`);
  return result;
}

/** `base` with a spy below the cache: `calls` records what reached the provider. */
function spied(base: Embedder) {
  const calls: string[][] = [];
  const embedder = withMiddleware(base, next => (inputs, options) => {
    calls.push(inputs.map(input => (typeof input === 'string' ? input : (input.text ?? ''))));
    return next(inputs, options);
  });
  return { embedder, calls };
}

/** A store that remembers every key it was asked to write, to corrupt one on purpose. */
function recordingStore() {
  const inner = memoryCacheStore();
  const keys: string[] = [];
  const store: CacheStore = {
    get: key => inner.get(key),
    set: (key, value, ttlMs) => {
      keys.push(key);
      return inner.set(key, value, ttlMs);
    },
  };
  return { store, keys, inner };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('sha256Hex', () => {
  it('matches Web Crypto, so a key written on one runtime is found on every other', async () => {
    const samples = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'ș și ț — 漢字 🙂'.repeat(40)];
    for (const sample of samples) {
      const bytes = new TextEncoder().encode(sample);
      const expected = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
      expect(sha256Hex(bytes)).toBe(expected);
    }
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('withCache', () => {
  it('model swap misses: a hit across models would be a wrong vector in the right shape', async () => {
    const store = memoryCacheStore();
    const first = spied(fakeEmbedder({ dimensions: 8, seed: 1 }));
    const second = spied(fakeEmbedder({ dimensions: 8, seed: 2 }));
    await ok(withCache(first.embedder, store).embed(['a'], {}));

    const swapped = await ok(withCache(second.embedder, store).embed(['a'], {}));
    const direct = await ok(fakeEmbedder({ dimensions: 8, seed: 2 }).embed(['a'], {}));

    expect(second.calls).toEqual([['a']]);
    expect(swapped.usage.cacheHits).toBe(0);
    expect(swapped.vectors[0]).toEqual(direct.vectors[0]);
  });

  it('dimensions change misses: the same text at another size is another vector', async () => {
    const store = memoryCacheStore();
    await ok(withCache(fakeEmbedder({ dimensions: 8 }), store).embed(['a'], {}));
    const bigger = spied(fakeEmbedder({ dimensions: 16 }));

    const batch = await ok(withCache(bigger.embedder, store).embed(['a'], {}));

    expect(bigger.calls).toEqual([['a']]);
    expect(batch.vectors[0]).toHaveLength(16);
  });

  it('purpose is part of the key: a query prefix and a document prefix are different texts', async () => {
    const { embedder, calls } = spied(fakeEmbedder({ dimensions: 8 }));
    const cached = withCache(embedder);
    await ok(cached.embed(['a'], { purpose: 'document' }));
    await ok(cached.embed(['a'], { purpose: 'query' }));
    await ok(cached.embed(['a'], { purpose: 'query' }));

    expect(calls).toEqual([['a'], ['a']]);
  });

  it('copies on get: a caller changing a returned vector never changes the cache', async () => {
    const cached = withCache(fakeEmbedder({ dimensions: 8 }));
    const first = await ok(cached.embed(['a'], {}));
    const original = [...(first.vectors[0] ?? [])];
    first.vectors[0]?.fill(0);

    const hit = await ok(cached.embed(['a'], {}));
    hit.vectors[0]?.fill(7);
    const again = await ok(cached.embed(['a'], {}));

    expect([...(again.vectors[0] ?? [])]).toEqual(original);
    expect(again.usage.cacheHits).toBe(1);
  });

  it('memoryCacheStore copies on get and on set', async () => {
    const store = memoryCacheStore();
    const value = new Uint8Array([1, 2, 3]);
    await store.set('k', value);
    value[0] = 9;
    const read = await store.get('k');
    read?.fill(0);

    expect(await store.get('k')).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('partial hit sends only the misses in order and keeps input order in the answer', async () => {
    const { embedder, calls } = spied(fakeEmbedder({ dimensions: 8 }));
    const cached = withCache(embedder);
    await ok(cached.embed(['a', 'b'], {}));

    const batch = await ok(cached.embed(['b', 'c', 'a', 'd'], {}));
    const direct = await ok(fakeEmbedder({ dimensions: 8 }).embed(['b', 'c', 'a', 'd'], {}));

    expect(calls).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(batch.vectors).toEqual(direct.vectors);
    expect(batch.usage.cacheHits).toBe(2);
    expect(batch.usage.requests).toBe(1);
  });

  it('an all-hit call sends nothing and spends no tokens', async () => {
    const { embedder, calls } = spied(fakeEmbedder({ dimensions: 8 }));
    const cached = withCache(embedder);
    await ok(cached.embed(['a'], {}));

    const batch = await ok(cached.embed(['a', 'a'], {}));

    expect(calls).toHaveLength(1);
    expect(batch.usage).toEqual({ tokens: { basis: 'counted', count: 0 }, requests: 0, cacheHits: 2 });
    expect(batch.space).toEqual(embedder.space);
  });

  it('a separator inside the namespace cannot collide with the text', async () => {
    const store = memoryCacheStore();
    const base = fakeEmbedder({ dimensions: 8 });
    await ok(withCache(base, store, { namespace: 'a|b' }).embed(['c'], {}));

    const other = await ok(withCache(base, store, { namespace: 'a' }).embed(['b|c'], {}));
    const direct = await ok(base.embed(['b|c'], {}));

    // A hit here would answer the vector of 'c' for the text 'b|c'.
    expect(other.usage.cacheHits).toBe(0);
    expect(other.vectors[0]).toEqual(direct.vectors[0]);
  });

  it('a key from another format version is a miss', async () => {
    const { store, keys, inner } = recordingStore();
    const base = fakeEmbedder({ dimensions: 8 });
    const keyFor = (version: string) =>
      sha256Hex(
        new TextEncoder().encode(JSON.stringify([version, spaceId(base.space), '', 8, 'float32', 'fail', '', 'a'])),
      );
    // A value in some other format, written under the key that format version would use.
    await inner.set(keyFor('v2'), new Uint8Array([9, 9, 9]));

    const batch = await ok(withCache(base, store).embed(['a'], {}));

    // The version leads the key, so the foreign value is never read: no strict InvalidOutput.
    expect(batch.usage.cacheHits).toBe(0);
    expect(keys).toEqual([keyFor('v1')]);
  });

  it('ttl expires: an entry past its ttl is embedded again', async () => {
    vi.useFakeTimers();
    const { embedder, calls } = spied(fakeEmbedder({ dimensions: 8 }));
    const cached = withCache(embedder, memoryCacheStore(), { ttlMs: 1000 });
    await ok(cached.embed(['a'], {}));
    vi.advanceTimersByTime(999);
    await ok(cached.embed(['a'], {}));
    vi.advanceTimersByTime(2);
    await ok(cached.embed(['a'], {}));

    expect(calls).toEqual([['a'], ['a']]);
  });

  it('memoryCacheStore drops the least recently read entry past maxEntries', async () => {
    const store = memoryCacheStore({ maxEntries: 2 });
    await store.set('a', new Uint8Array([1]));
    await store.set('b', new Uint8Array([2]));
    await store.get('a');
    await store.set('c', new Uint8Array([3]));

    expect(await store.get('b')).toBeUndefined();
    expect(await store.get('a')).toEqual(new Uint8Array([1]));
  });

  it('strict (default): an entry that does not fit the space is InvalidOutput, never a wrong-sized vector', async () => {
    const { store, keys, inner } = recordingStore();
    const cached = withCache(fakeEmbedder({ dimensions: 8 }), store);
    await ok(cached.embed(['a'], {}));
    await inner.set(keys[0] ?? '', new Uint8Array([0, 1, 2, 3, 4]));

    const result = await cached.embed(['a'], {});

    expect(InvalidOutput.is(result)).toBe(true);
  });

  it('strict: false re-embeds an entry that does not fit, and rewrites it', async () => {
    const { store, keys, inner } = recordingStore();
    const { embedder, calls } = spied(fakeEmbedder({ dimensions: 8 }));
    const cached = withCache(embedder, store, { strict: false });
    await ok(cached.embed(['a'], {}));
    await inner.set(keys[0] ?? '', new Uint8Array([9]));

    const batch = await ok(cached.embed(['a'], {}));
    const healed = await ok(cached.embed(['a'], {}));

    expect(calls).toEqual([['a'], ['a']]);
    expect(batch.vectors[0]).toHaveLength(8);
    expect(healed.usage.cacheHits).toBe(1);
  });

  it('a failure from the provider is returned and nothing is cached', async () => {
    const failing = fakeEmbedder({ dimensions: 8, failures: { bad: InvalidOutput({ reason: 'test' }) } });
    const { embedder, calls } = spied(failing);
    const cached = withCache(embedder);

    expect(isEmbedFailure(await cached.embed(['bad'], {}))).toBe(true);
    expect(isEmbedFailure(await cached.embed(['bad'], {}))).toBe(true);
    expect(calls).toEqual([['bad'], ['bad']]);
  });

  it('a store that throws is a miss, not a failed embed', async () => {
    const broken: CacheStore = {
      get: () => Promise.reject(new Error('redis down')),
      set: () => Promise.reject(new Error('redis down')),
    };
    const batch = await ok(withCache(fakeEmbedder({ dimensions: 8 }), broken).embed(['a'], {}));

    expect(batch.vectors[0]).toHaveLength(8);
    expect(batch.usage.cacheHits).toBe(0);
  });
});

describe('withCache with a calibrated embedder', () => {
  // Native size 8 (binary needs a multiple of 8); the stub answers 4 values unless told the size.
  const model = stubModel(request => echoTexts({ ...request, dimensions: 8 }), { dimensions: 8, matryoshka: [] });
  const calibrated = (low: number) => {
    const embedder = createEmbedder(model, {
      calibration: calibrateInt8([new Float32Array(8).fill(low), new Float32Array(8).fill(9)]),
    });
    if (isEmbedFailure(embedder)) throw new Error(embedder.message);
    return embedder;
  };

  // The key is looked up before the call and written after it; if the two disagree, every call misses.
  it('a per-call binary on an int8 embedder hits on the second call', async () => {
    const int8 = createEmbedder(model, { quantization: 'int8', calibration: calibrateInt8([new Float32Array(8).fill(-1)]) });
    if (isEmbedFailure(int8)) throw new Error(int8.message);
    const { embedder, calls } = spied(int8);
    const cached = withCache(embedder, memoryCacheStore());
    await ok(cached.embed(['t1'], { quantization: 'binary' }));
    const second = await ok(cached.embed(['t1'], { quantization: 'binary' }));
    expect(calls).toHaveLength(1);
    expect(second.usage.cacheHits).toBe(1);
  });

  // Int8 values only mean something under their own calibration: the same range must hit, another
  // range must never read them.
  it('a per-call int8 hits under its own calibration and not under another', async () => {
    const store = memoryCacheStore();
    const own = withCache(calibrated(-1), store);
    await ok(own.embed(['t1'], { quantization: 'int8' }));
    const again = await ok(own.embed(['t1'], { quantization: 'int8' }));
    expect(again.usage.cacheHits).toBe(1);
    const { embedder, calls } = spied(calibrated(-2));
    const other = await ok(withCache(embedder, store).embed(['t1'], { quantization: 'int8' }));
    expect(calls).toHaveLength(1);
    expect(other.usage.cacheHits).toBe(0);
  });
});
