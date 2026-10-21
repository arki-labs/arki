import { describe, expectTypeOf, it } from 'vitest';

import type {
  Embedder,
  Embedding,
  EmbeddingBatch,
  EmbeddingModel,
  EmbedFailure,
  Instruction,
  TokenCount,
} from './index.js';
import {
  Cancelled,
  cosine,
  countTokens,
  createEmbedder,
  embed,
  embedMany,
  isEmbedFailure,
  isSameSpace,
  l2Normalize,
  NO_INSTRUCTION,
  norm,
  QWEN3_INSTRUCTION,
  resolveEmbeddingModel,
  spaceId,
} from './index.js';

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
  });
});
