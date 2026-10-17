import { describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';

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
    for (const failure of failures) {
      expect(isFailure(failure)).toBe(true);
      expect(isEmbedFailure(failure)).toBe(true);
    }
    expect(new Set(failures.map(failure => failure.code)).size).toBe(failures.length);
    expect(isEmbedFailure({ code: 'embeddings.cancelled' })).toBe(false);
    expect(isEmbedFailure(new Float32Array(2))).toBe(false);
  });
});
