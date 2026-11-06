import { describe, expect, it } from 'vitest';

import type { EmbeddingSpace } from '@arki/embeddings';

import { createVectorIndex } from './vector-index';

const space: EmbeddingSpace = {
  provider: 'fake',
  model: 'fake-4',
  dimensions: 4,
  normalized: true,
  quantization: 'float32',
  instructionVersion: 0,
};

describe('createVectorIndex with a bad QDRANT_URL', () => {
  it('returns InvalidEnvironment for a value that is not an http(s) URL', () => {
    // WHY: a typo in the env must fail the boot, not the first collection call.
    for (const url of ['not a url', 'ftp://q:6333']) {
      const result = createVectorIndex<{ userId: string }>(space, {
        collection: 'test',
        payloadIndexes: [],
        env: { QDRANT_URL: url },
      });
      expect(result).toHaveProperty('code', 'env.invalid_environment');
    }
  });
});
