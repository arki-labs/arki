/**
 * `createVectorIndex`: Qdrant only when `QDRANT_URL` is set and the backend is
 * not pinned to `mock`; the `durable` flag tells the reconciler whether a
 * tombstone may be acknowledged against this index.
 */
import type { EmbeddingSpace } from '@arki/embeddings';
import { describe, expect, it } from 'vitest';

import { MockVectorProvider } from './providers/mock';
import { QdrantVectorProvider } from './providers/qdrant';
import { createVectorIndex } from './vector-index';

type Payload = { userId: string; kind: 'item' | 'chunk'; model: string; dimensions: number };

const space: EmbeddingSpace = {
  provider: 'fake',
  model: 'fake-4',
  dimensions: 4,
  normalized: true,
  quantization: 'float32',
  instructionVersion: 0,
};

describe('createVectorIndex', () => {
  it('is the in-memory mock, not durable, without QDRANT_URL', async () => {
    const index = createVectorIndex<Payload>(space, {
      collection: 'test',
      payloadIndexes: ['userId', 'kind'],
      env: {},
    });
    expect(index.provider).toBeInstanceOf(MockVectorProvider);
    expect(index.durable).toBe(false);
  });

  it('stays on the mock when VECTOR_BACKEND=mock even with QDRANT_URL', async () => {
    const index = createVectorIndex<Payload>(space, {
      collection: 'test',
      payloadIndexes: ['userId'],
      env: { QDRANT_URL: 'http://q:6333', VECTOR_BACKEND: 'mock' },
    });
    expect(index.provider).toBeInstanceOf(MockVectorProvider);
    expect(index.durable).toBe(false);
  });

  it('is Qdrant and durable with QDRANT_URL, sized by the embedding space', async () => {
    const index = createVectorIndex<Payload>(space, {
      collection: 'test',
      payloadIndexes: ['userId', 'kind'],
      env: { QDRANT_URL: 'http://q:6333', QDRANT_API_KEY: 'k', QDRANT_REPLICATION_FACTOR: '2' },
    });
    expect(index.provider).toBeInstanceOf(QdrantVectorProvider);
    expect(index.durable).toBe(true);
    // The collection size is the space's dimension (4); there is no fallback size.
    await expect(
      index.provider.upsertVector('p1', [1, 2, 3], { userId: 'u', kind: 'item', model: 'm', dimensions: 3 }),
    ).rejects.toThrow(/got 3, collection is 4/);
  });
});
