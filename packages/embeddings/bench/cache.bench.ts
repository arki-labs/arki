// `withCache` against LangChain's `CacheBackedEmbeddings`, and `kvCacheStore` against a raw GET.
// Run: `bun run bench bench/cache.bench.ts` (explore) or with `--profile publish --write-readme`.
//
// Every row embeds through the same deterministic fake model (1024 dims), so what is measured is
// each library's cache work: hashing the key, the store round trip, and decoding the vector.

import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import { CacheBackedEmbeddings } from '@langchain/classic/embeddings/cache_backed';
import { InMemoryStore } from '@langchain/core/stores';
import { z } from 'zod';

import type { CaseBuilder, CaseSpec } from '@arki/bench';
import type { CacheStore, Embedder } from '@arki/embeddings';
import { compare, defineSuite, scenario } from '@arki/bench';
import { embedMany, isEmbedFailure, memoryCacheStore, withCache } from '@arki/embeddings';
import { kvCacheStore } from '@arki/embeddings/kv';
import { fakeEmbedder } from '@arki/embeddings/testing';

const DIMENSIONS = 1024;
const model = fakeEmbedder({ dimensions: DIMENSIONS });

/** About 1 KB of text per input. */
function text(index: number): string {
  return `document ${index}: ${'lorem ipsum dolor sit amet '.repeat(37)}`;
}

/** 10 000 inputs over 2 500 distinct texts: each text appears four times, spread through the list. */
const MIXED = Array.from({ length: 10_000 }, (_, index) => text(index % 2500));
const WARM = Array.from({ length: 3 }, (_, index) => text(index));

/** Vectors → one comparable string: float32 bits, FNV-1a, in order. */
function fingerprint(vectors: readonly ArrayLike<number>[]): string {
  let hash = 2_166_136_261;
  for (const vector of vectors) {
    const floats = Float32Array.from(vector);
    for (const word of new Uint32Array(floats.buffer)) hash = Math.imul(hash ^ word, 16_777_619) >>> 0;
  }
  return `${vectors.length}:${hash.toString(16)}`;
}

async function vectorsOf(embedder: Embedder, texts: readonly string[]) {
  const batch = await embedMany(embedder, texts);
  if (isEmbedFailure(batch)) throw new Error(batch.message);
  return batch.vectors;
}

/** The fake model behind LangChain's interface: the same vectors as plain arrays. */
const underlying: EmbeddingsInterface = {
  embedDocuments: async texts => {
    const vectors = await vectorsOf(model, texts);
    return vectors.map(vector => [...vector]);
  },
  embedQuery: async query => {
    const [vector] = await vectorsOf(model, [query]);
    return [...(vector ?? [])];
  },
};

function langchainCache() {
  return CacheBackedEmbeddings.fromBytesStore(underlying, new InMemoryStore<Uint8Array>(), { namespace: 'bench' });
}

/** A `@arki/kv`-shaped client over a Map that serialises through JSON, as `KV` does. No network. */
function jsonKv() {
  const entries = new Map<string, string>();
  return {
    get: (key: string, schema: ReturnType<typeof z.base64>): Promise<string | undefined> => {
      const stored = entries.get(key);
      if (stored === undefined) return Promise.resolve(stored);
      const parsed = schema.safeParse(JSON.parse(stored));
      return Promise.resolve(parsed.success ? parsed.data : undefined);
    },
    set: (key: string, value: string) => {
      entries.set(key, JSON.stringify(value));
      return Promise.resolve(true);
    },
  };
}

// ---- Warm caches for the hit rows: every input below is already cached.
const arkiMemory = withCache(model, memoryCacheStore({ maxEntries: 20_000 }));
const langchainMemory = langchainCache();
const kv = jsonKv();
const kvKeys: string[] = [];
const recordingKv: CacheStore = {
  get: key => kvStore.get(key),
  set: (key, value, ttlMs) => {
    kvKeys.push(key);
    return kvStore.set(key, value, ttlMs);
  },
};
const kvStore = kvCacheStore(kv, { prefix: '' });
const arkiKv = withCache(model, recordingKv);
await vectorsOf(arkiMemory, WARM);
await langchainMemory.embedDocuments(WARM);
await vectorsOf(arkiKv, WARM);
const firstKvKey = kvKeys[0] ?? '';

/** The fake model's own answer per input list, computed once: the contract every row must meet. */
const answers = new Map<string, string>();
for (const texts of [...WARM.map(warm => [warm]), MIXED])
  answers.set(texts.join('\u0000'), fingerprint(await vectorsOf(model, texts)));
const expected = (texts: readonly string[]): string => answers.get(texts.join('\u0000')) ?? 'missing';

function hitRows(c: CaseBuilder<string[]>): Record<string, CaseSpec<string[], unknown, unknown>> {
  return {
    arki: c({
      label: '@arki/embeddings withCache (memoryCacheStore)',
      package: '@arki/embeddings',
      run: texts => vectorsOf(arkiMemory, texts),
      normalize: fingerprint,
    }),
    langchain: c({
      label: 'LangChain CacheBackedEmbeddings (InMemoryStore)',
      package: '@langchain/classic',
      run: texts => langchainMemory.embedDocuments(texts),
      normalize: fingerprint,
    }),
  };
}

function mixedRows(c: CaseBuilder<string[]>): Record<string, CaseSpec<string[], unknown, unknown>> {
  return {
    arki: c({
      label: '@arki/embeddings withCache (fresh memoryCacheStore)',
      package: '@arki/embeddings',
      run: texts => vectorsOf(withCache(model, memoryCacheStore({ maxEntries: 20_000 })), texts),
      normalize: fingerprint,
    }),
    langchain: c({
      label: 'LangChain CacheBackedEmbeddings (fresh InMemoryStore)',
      package: '@langchain/classic',
      run: texts => langchainCache().embedDocuments(texts),
      normalize: fingerprint,
    }),
    uncached: c({
      label: 'no cache (the fake model alone)',
      run: texts => vectorsOf(model, texts),
      normalize: fingerprint,
    }),
  };
}

export default defineSuite({
  id: '@arki/embeddings/cache',
  intro:
    'Every row embeds through the same deterministic fake model (1024 dims, ~1 KB texts), so the numbers are each library’s cache work: key hashing, the store round trip and decoding. Each table ranks only rows that returned bit-identical float32 vectors.',
  notes: [
    '`withCache` keys hash the space id, the purpose, the size, the dtype, the truncation choice, the namespace and the text (SHA-256 in plain TypeScript, so every runtime agrees). LangChain keys hash the text and the namespace only.',
    '`withCache` stores float32 bytes (4 KB per vector) and decodes them into a `Float32Array`; LangChain stores JSON text and parses it into a number array.',
    'The 10 000-input row starts from an empty store each run. Neither library removes duplicates inside one call; later chunks hit what earlier chunks wrote.',
    'The KV rows use a Map that serialises through JSON in place of Redis, so no network time is in them.',
  ],
  groups: [
    compare<string[]>({
      id: 'memory-hit-1',
      title: 'One cached text per call, in-process store',
      contract: { id: 'embeddings-cache-hit-1/v1', description: 'the fake model’s vector, bit-identical as float32' },
      inputs: WARM.map(warm => [warm]),
      expected,
      baseline: 'arki',
      mode: 'async',
      cases: c => hitRows(c),
    }),
    compare<string[]>({
      id: 'mixed-10k',
      title: '10 000 inputs over 2 500 distinct ~1 KB texts, empty store at start',
      contract: { id: 'embeddings-cache-mixed-10k/v1', description: 'the fake model’s vectors, in input order' },
      inputs: [MIXED],
      expected,
      baseline: 'arki',
      mode: 'async',
      cases: c => mixedRows(c),
    }),
    scenario({
      id: 'kv-hit-1',
      title: 'One cached text through kvCacheStore, next to a raw GET of the same key',
      note: 'The gap between the rows is the wrapper: key hashing, base64 decode, the dtype check and the Float32Array. Different work, so no ratio.',
      mode: 'async',
      cases: {
        wrapper: {
          label: '@arki/embeddings withCache(kvCacheStore) hit',
          run: () => vectorsOf(arkiKv, [WARM[0] ?? '']),
        },
        raw: {
          label: 'raw kv.get of the stored value',
          run: () => kv.get(firstKvKey, z.base64()),
        },
      },
    }),
  ],
});
