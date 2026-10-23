import { describe, expectTypeOf, it } from 'vitest';

import type { Provided } from '@arki/dot/unit';
import type { KV } from '@arki/kv';

import type { embeddings } from './dot/index.js';
import type {
  CacheStore,
  Embedder,
  Embedding,
  EmbeddingBatch,
  EmbeddingModel,
  EmbedFailure,
  EmbedMiddleware,
  Instruction,
  NormalizeTextOptions,
  TokenCount,
} from './index.js';
import type { rerank, RERANK_PROVIDERS, Reranker, RerankProviderName } from './rerank/index.js';
import type { createTransformersModel, createTransformersReranker } from './transformers/index.js';
import {
  Cancelled,
  cosine,
  countTokens,
  createEmbedder,
  E5_INSTRUCTION,
  embed,
  EMBEDDINGGEMMA_INSTRUCTION,
  embedMany,
  embedStream,
  isEmbedFailure,
  isSameSpace,
  l2Normalize,
  memoryCacheStore,
  NO_INSTRUCTION,
  NOMIC_INSTRUCTION,
  norm,
  normalizeText,
  QWEN3_INSTRUCTION,
  resolveEmbeddingModel,
  spaceId,
  withCache,
  withMiddleware,
  withResilience,
  withTelemetry,
} from './index.js';
import { kvCacheStore } from './kv/index.js';

describe('public types of the root entry', () => {
  it('embedMany and embed answer a value or an EmbedFailure, so a caller must narrow before reading vectors', () => {
    expectTypeOf(embedMany).returns.resolves.toEqualTypeOf<EmbeddingBatch | EmbedFailure>();
    expectTypeOf(embed).returns.resolves.toEqualTypeOf<Embedding | EmbedFailure>();
    expectTypeOf(embedMany).parameter(0).toEqualTypeOf<Embedder>();
  });

  it('isEmbedFailure narrows an unknown value to EmbedFailure', () => {
    const narrow = (value: unknown) => {
      if (isEmbedFailure(value)) expectTypeOf(value).toEqualTypeOf<EmbedFailure>();
    };
    expectTypeOf(narrow).returns.toEqualTypeOf<void>();
    expectTypeOf(Cancelled).returns.toMatchTypeOf<EmbedFailure>();
  });

  it('a space compares and prints without touching the model', () => {
    expectTypeOf(spaceId).returns.toEqualTypeOf<string>();
    expectTypeOf(isSameSpace).returns.toEqualTypeOf<boolean>();
  });

  it('createEmbedder and resolveEmbeddingModel return a value or a failure, never throw for expected cases', () => {
    expectTypeOf(createEmbedder).parameter(0).toEqualTypeOf<EmbeddingModel>();
    expectTypeOf(createEmbedder).returns.toMatchTypeOf<Embedder | EmbedFailure>();
    expectTypeOf(resolveEmbeddingModel).returns.toMatchTypeOf<EmbeddingModel | EmbedFailure>();
  });

  it('vector helpers take typed arrays and answer numbers', () => {
    expectTypeOf(cosine).toEqualTypeOf<(a: Float32Array, b: Float32Array) => number>();
    expectTypeOf(l2Normalize).toEqualTypeOf<(vector: Float32Array) => Float32Array>();
    expectTypeOf(norm).returns.toEqualTypeOf<number>();
    expectTypeOf(countTokens).returns.toEqualTypeOf<TokenCount>();
  });

  it('the instruction constants are Instructions, whose version feeds the space id', () => {
    expectTypeOf(QWEN3_INSTRUCTION).toEqualTypeOf<Instruction>();
    expectTypeOf(NO_INSTRUCTION).toEqualTypeOf<Instruction>();
    expectTypeOf(EMBEDDINGGEMMA_INSTRUCTION).toEqualTypeOf<Instruction>();
    expectTypeOf(NOMIC_INSTRUCTION).toEqualTypeOf<Instruction>();
    expectTypeOf(E5_INSTRUCTION).toEqualTypeOf<Instruction>();
  });

  it('wrappers take an Embedder and give back an Embedder, so they stack and embedMany takes the result', () => {
    expectTypeOf(withMiddleware).parameter(0).toEqualTypeOf<Embedder>();
    expectTypeOf(withMiddleware).parameters.toEqualTypeOf<[Embedder, ...EmbedMiddleware[]]>();
    expectTypeOf(withMiddleware).returns.toEqualTypeOf<Embedder>();
    expectTypeOf(withResilience).parameter(0).toEqualTypeOf<Embedder>();
    expectTypeOf(withResilience).returns.toEqualTypeOf<Embedder>();
  });

  it('withCache and withTelemetry are wrappers like withResilience: Embedder in, Embedder out', () => {
    expectTypeOf(withCache).parameter(0).toEqualTypeOf<Embedder>();
    expectTypeOf(withCache).parameter(1).toEqualTypeOf<CacheStore | undefined>();
    expectTypeOf(withCache).returns.toEqualTypeOf<Embedder>();
    expectTypeOf(withTelemetry).parameter(0).toEqualTypeOf<Embedder>();
    expectTypeOf(withTelemetry).returns.toEqualTypeOf<Embedder>();
  });

  it('every store is a CacheStore, and an @arki/kv client fits kvCacheStore as it is', () => {
    expectTypeOf(memoryCacheStore).returns.toEqualTypeOf<CacheStore>();
    expectTypeOf(kvCacheStore).returns.toEqualTypeOf<CacheStore>();
    expectTypeOf<KV>().toMatchTypeOf<Parameters<typeof kvCacheStore>[0]>();
  });

  it('the Dot unit publishes Embedder | null, so a feature must handle an app with no model', () => {
    expectTypeOf<Provided<ReturnType<typeof embeddings>['provides']['embedder']>>().toEqualTypeOf<Embedder | null>();
  });

  it('embedStream yields one { item, result } per source item, the result a value or an EmbedFailure', () => {
    type Doc = { readonly id: number };
    expectTypeOf(embedStream<Doc>).returns.toEqualTypeOf<
      ReadableStream<{ readonly item: Doc; readonly result: Embedding | EmbedFailure }>
    >();
  });

  it('createTransformersModel is async and answers a model record or a failure value', () => {
    expectTypeOf<Awaited<ReturnType<typeof createTransformersModel>>>().toMatchTypeOf<EmbeddingModel | EmbedFailure>();
  });

  it('normalizeText is a pure string → string helper the embedder never calls', () => {
    expectTypeOf(normalizeText).toEqualTypeOf<(text: string, options?: NormalizeTextOptions) => string>();
  });
});

describe('./rerank public types', () => {
  it('rerank() hands back the caller’s own item type on every hit, or a failure value', () => {
    type Hit = { readonly id: string; readonly text: string };
    type Ranked = Exclude<Awaited<ReturnType<typeof rerank<Hit>>>, EmbedFailure>;
    expectTypeOf<Ranked['hits'][number]['item']>().toEqualTypeOf<Hit>();
    expectTypeOf<Ranked['hits'][number]['score']>().toEqualTypeOf<number>();
    expectTypeOf<Extract<Awaited<ReturnType<typeof rerank<Hit>>>, EmbedFailure>>().toMatchTypeOf<EmbedFailure>();
  });

  it('every reranker factory answers a Reranker, so rerank() and withRerankCache take any of them', async () => {
    const { withRerankCache } = await import('./rerank/index.js');
    const { createCohereCompatibleReranker, createCohereReranker } = await import('./cohere/index.js');
    const { createVoyageReranker } = await import('./voyage/index.js');
    const { createJinaReranker } = await import('./jina/index.js');
    const { createTeiReranker } = await import('./tei/index.js');
    const { fakeReranker } = await import('./testing/index.js');
    expectTypeOf(withRerankCache).returns.toEqualTypeOf<Reranker>();
    for (const created of [
      createCohereReranker({ apiKey: 'k' }),
      createCohereCompatibleReranker({ baseURL: 'http://x', id: 'm' }),
      createVoyageReranker({ apiKey: 'k' }),
      createJinaReranker({ apiKey: 'k' }),
      createTeiReranker({ baseURL: 'http://x', id: 'm' }),
    ]) {
      expectTypeOf(created).toMatchTypeOf<Reranker | EmbedFailure>();
    }
    expectTypeOf<Awaited<ReturnType<typeof createTransformersReranker>>>().toMatchTypeOf<Reranker | EmbedFailure>();
    expectTypeOf(fakeReranker).returns.toEqualTypeOf<Reranker>();
  });

  it('a reranker names its provider from the one RERANK_PROVIDERS list', () => {
    expectTypeOf<Reranker['provider']>().toEqualTypeOf<RerankProviderName>();
    expectTypeOf<RerankProviderName>().toEqualTypeOf<(typeof RERANK_PROVIDERS)[number]>();
  });
});
