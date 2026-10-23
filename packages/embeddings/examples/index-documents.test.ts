import { describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';

import { ModelUnavailable, SpaceMismatch } from '../src/index.js';
import { fakeEmbedder } from '../src/testing/index.js';
import { embedDocuments, embedForIndex } from './index-documents.js';

describe('embedDocuments', () => {
  it('returns ModelUnavailable, not a throw, when the embedding server is out for lunch', async () => {
    const result = await embedDocuments(['Margherita: tomato, mozzarella, basil.'], 'http://127.0.0.1:1');
    expect(ModelUnavailable.is(result) && result.data.reason).toBe('unreachable');
  });
});

describe('embedForIndex', () => {
  it('embeds when the index space is the embedder space', async () => {
    const embedder = fakeEmbedder({ dimensions: 8 });
    const result = await embedForIndex(embedder, ['a', 'b'], embedder.space);
    expect(isFailure(result)).toBe(false);
    if (!isFailure(result)) expect(result.vectors).toHaveLength(2);
  });

  it('refuses an index built with another seed, because those vectors are not comparable', async () => {
    const result = await embedForIndex(
      fakeEmbedder({ dimensions: 8, seed: 1 }),
      ['a'],
      fakeEmbedder({ dimensions: 8, seed: 2 }).space,
    );
    expect(SpaceMismatch.is(result)).toBe(true);
  });
});
