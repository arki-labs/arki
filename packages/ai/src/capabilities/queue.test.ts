import { describe, expect, it } from 'vitest';

import { validateQueueOrder } from './queue';
import { queueOrderSchema } from './schemas';

describe('Queue ordering preserves listener choices', () => {
  it('accepts a permutation and an unchanged order', () => {
    expect(validateQueueOrder(['a', 'b'], ['b', 'a'])).toBeUndefined();
    expect(validateQueueOrder(['a', 'b'], ['a', 'b'])).toBeUndefined();
  });
  // A model that drops or invents an episode must not silently change the listener's queue.
  it('rejects model omissions, duplicate items and additions as UngroundedOutput', () => {
    for (const order of [['a'], ['a', 'a'], ['a', 'c'], ['a', 'b', 'c']])
      expect(validateQueueOrder(['a', 'b'], order)?.code).toBe('ai.ungrounded_output');
  });
  it('does not accept ambiguous duplicate episode IDs', () => {
    const episode = { id: 'a', mediaKey: 'a'.repeat(64), title: 'Sleep', summary: '' };
    expect(queueOrderSchema.safeParse({ episodes: [episode, episode] }).success).toBe(false);
  });
});
