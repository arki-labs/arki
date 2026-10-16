/**
 * `createVectorIndex`: Qdrant only when `QDRANT_URL` is set and the backend is
 * not pinned to `mock`; the `durable` flag tells the reconciler whether a
 * tombstone may be acknowledged against this index.
 */
import { describe, expect, it } from 'vitest';

import { createEmbeddingRuntime } from '../embeddings/runtime';
import { MockVectorProvider } from './providers/mock';
import { QdrantVectorProvider } from './providers/qdrant';
import { createVectorIndex } from './vector-index';

type Payload = { userId: string; kind: 'item' | 'chunk'; model: string; dimensions: number };

async function mockRuntime() {
  const runtime = await createEmbeddingRuntime({ EMBEDDING_PROVIDER: 'mock', EMBEDDING_DIMENSIONS: '4' });
  if (!runtime) throw new Error('mock runtime expected');
  return runtime;
}

describe('createVectorIndex', () => {
  it('is the in-memory mock, not durable, without QDRANT_URL', async () => {
    const index = createVectorIndex<Payload>(await mockRuntime(), {
      collection: 'test',
      payloadIndexes: ['userId', 'kind'],
      env: {},
    });
    expect(index.provider).toBeInstanceOf(MockVectorProvider);
    expect(index.durable).toBe(false);
  });

  it('stays on the mock when VECTOR_BACKEND=mock even with QDRANT_URL', async () => {
    const index = createVectorIndex<Payload>(await mockRuntime(), {
      collection: 'test',
      payloadIndexes: ['userId'],
      env: { QDRANT_URL: 'http://q:6333', VECTOR_BACKEND: 'mock' },
    });
    expect(index.provider).toBeInstanceOf(MockVectorProvider);
    expect(index.durable).toBe(false);
  });

  it('is Qdrant and durable with QDRANT_URL, sized by the runtime selection', async () => {
    const index = createVectorIndex<Payload>(await mockRuntime(), {
      collection: 'test',
      payloadIndexes: ['userId', 'kind'],
      env: { QDRANT_URL: 'http://q:6333', QDRANT_API_KEY: 'k', QDRANT_REPLICATION_FACTOR: '2' },
    });
    expect(index.provider).toBeInstanceOf(QdrantVectorProvider);
    expect(index.durable).toBe(true);
    // The collection size is the selection's dimension (4), not Qdrant's 1536 fallback.
    await expect(
      index.provider.upsertVector('p1', [1, 2, 3], { userId: 'u', kind: 'item', model: 'm', dimensions: 3 }),
    ).rejects.toThrow(/got 3, collection is 4/);
  });
});
