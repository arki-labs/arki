import { describe, expect, expectTypeOf, it } from 'vitest';

import { UnexpectedDefect, isFailure } from '@arki/failure';

import type { EmbedFailure } from './index.js';
import {
  Cancelled,
  ConfigurationFailure,
  InputTooLong,
  InvalidOutput,
  ModelUnavailable,
  RateLimited,
  SpaceMismatch,
  UnsupportedInput,
  isEmbedFailure,
} from './failures.js';

describe('failures', () => {
  // Callers branch on values; a thrown error here would skip their handling entirely.
  it('every failure is a value and isFailure recognises it', () => {
    const space = {
      provider: 'fake',
      model: 'x',
      dimensions: 2,
      normalized: true,
      quantization: 'float32',
      instructionVersion: 0,
    } as const;
    const failures = [
      RateLimited({ retryAfterMs: 100 }),
      InputTooLong({ index: 3, tokens: { basis: 'estimated', count: 9000 }, max: 8191 }),
      ModelUnavailable({ model: 'qwen3-embedding:0.6b', reason: 'not-pulled' }),
      UnsupportedInput({ index: 0, part: 'image' }),
      InvalidOutput({ reason: 'zero-norm at index 0' }),
      SpaceMismatch({ expected: space, actual: { ...space, dimensions: 4 } }),
      Cancelled(),
      ConfigurationFailure({ message: 'nothing set' }),
    ];
    // The public union must cover exactly the supported refusal values, without widening.
    expectTypeOf<(typeof failures)[number]>().toEqualTypeOf<EmbedFailure>();
    for (const failure of failures) {
      expect(isFailure(failure)).toBe(true);
      expect(isEmbedFailure(failure)).toBe(true);
    }
    expect(new Set(failures.map(failure => failure.code)).size).toBe(failures.length);
    expect(isEmbedFailure({ code: 'embeddings.cancelled' })).toBe(false);
    expect(isEmbedFailure(new Float32Array(2))).toBe(false);
    expect(isEmbedFailure(UnexpectedDefect())).toBe(false);
  });

  it('narrows an untyped boundary to the public failure union', () => {
    const value: unknown = Cancelled();
    if (!isEmbedFailure(value)) throw new Error('Expected the canonical cancellation failure');
    expectTypeOf(value).toEqualTypeOf<EmbedFailure>();
    if (value.code === 'embeddings.rate_limited') {
      expectTypeOf(value.data.retryAfterMs).toEqualTypeOf<number | undefined>();
    }
  });
});
