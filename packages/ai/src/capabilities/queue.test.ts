import { describe, expect, it } from 'vitest';

import { queueOrderSchema, validateQueueOrder } from './queue';

describe('Queue ordering preserves listener choices', () => {
  it('accepts a permutation and an unchanged order', () => {
    expect(() => validateQueueOrder(['a', 'b'], ['b', 'a'])).not.toThrow();
    expect(() => validateQueueOrder(['a', 'b'], ['a', 'b'])).not.toThrow();
  });
  it('rejects model omissions, duplicate items and additions', () => {
    for (const order of [['a'], ['a', 'a'], ['a', 'c'], ['a', 'b', 'c']])
      expect(() => validateQueueOrder(['a', 'b'], order)).toThrow();
  });
  it('does not accept ambiguous duplicate episode IDs', () => {
    const episode = { id: 'a', mediaKey: 'a'.repeat(64), title: 'Sleep', summary: '' };
    expect(queueOrderSchema.safeParse({ episodes: [episode, episode] }).success).toBe(false);
  });
});
