import { describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';

import { embed, embedMany } from '../embed.js';
import { RateLimited } from '../failures.js';
import { cosine, norm } from '../vector.js';
import { fakeEmbedder } from './index.js';

describe('./testing fakeEmbedder', () => {
  // Tests compare vectors by equality; the fake must be reproducible on every run and runtime.
  it('same text and seed give the same unit vector', async () => {
    const first = await embed(fakeEmbedder({ dimensions: 64, seed: 7 }), 'a');
    const second = await embed(fakeEmbedder({ dimensions: 64, seed: 7 }), 'a');
    if (isFailure(first) || isFailure(second)) throw new Error('fake failed');
    expect([...first.vector]).toEqual([...second.vector]);
    expect(norm(first.vector)).toBeCloseTo(1, 6);
    expect(first.vector).toBeInstanceOf(Float32Array);
    if (first.vector instanceof Float32Array && second.vector instanceof Float32Array) {
      expect(cosine(first.vector, second.vector)).toBe(1);
    }
  });

  it('different seeds differ', async () => {
    const one = await embed(fakeEmbedder({ dimensions: 64, seed: 1 }), 'a');
    const two = await embed(fakeEmbedder({ dimensions: 64, seed: 2 }), 'a');
    if (isFailure(one) || isFailure(two)) throw new Error('fake failed');
    expect([...one.vector]).not.toEqual([...two.vector]);
    expect(one.space.revision).not.toBe(two.space.revision);
  });

  // All-or-nothing must be visible in tests: one bad input fails the whole call.
  it('a configured failure fails the whole batch', async () => {
    const fake = fakeEmbedder({ dimensions: 8, failures: { boom: RateLimited({ retryAfterMs: 100 }) } });
    const result = await embedMany(fake, ['fine', 'boom', 'also fine']);
    expect(isFailure(result) && result.code).toBe('embeddings.rate_limited');
    expect(isFailure(result) && result.data).toEqual({ retryAfterMs: 100 });
  });
});
