import { describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';

import { ConfigurationFailure, SpaceMismatch } from '../src/index.js';
import { fakeEmbedder } from '../src/testing/index.js';
import { embedDocuments, embedForIndex } from './index-documents.js';

describe('embedDocuments', () => {
  it('returns ConfigurationFailure, not a throw, when no provider is configured', async () => {
    const result = await embedDocuments(['a'], {});
    expect(ConfigurationFailure.is(result)).toBe(true);
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
