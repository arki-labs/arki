import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EmbeddingSpace } from '@arki/embeddings';
import type { SparseSpace, SparseVector } from '@arki/embeddings/sparse';

import { QdrantVectorProvider } from '../qdrant';

// ── Qdrant client mock ────────────────────────────────────────
// Same shape as qdrant.vector-in.test.ts: one shared spy object the provider talks to.
const client = {
  getCollections: vi.fn(),
  getCollection: vi.fn(),
  createCollection: vi.fn(),
  createPayloadIndex: vi.fn(),
  upsert: vi.fn(),
  query: vi.fn().mockResolvedValue({ points: [] }),
};

vi.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: class {
    constructor() {
      return client;
    }
  },
}));

const space: EmbeddingSpace = {
  provider: 'fake',
  model: 'fake-4',
  dimensions: 4,
  normalized: true,
  quantization: 'float32',
  instructionVersion: 0,
};

const sparseSpace: SparseSpace = {
  provider: 'openai-compatible',
  model: 'naver/splade-v3',
  dimensions: 30_522,
  normalized: false,
  quantization: 'float32',
  instructionVersion: 0,
  vocabulary: 'naver/splade-v3',
};

const sparse = (indices: number[], values: number[]): SparseVector => ({
  indices: Uint32Array.from(indices),
  values: Float32Array.from(values),
});

const config = { url: 'http://qdrant.test', collectionName: 'c' };

beforeEach(() => {
  vi.clearAllMocks();
  client.getCollections.mockResolvedValue({ collections: [] });
});

describe('QdrantVectorProvider — sparse vectors', () => {
  // Hybrid retrieval needs both vectors on one point; a second upsert would replace the first.
  it('qdrant stores and searches a sparse vector', async () => {
    const p = new QdrantVectorProvider(config, { space, sparseSpace });
    await p.upsertVector('itm_a', [1, 0, 0, 0], { userId: 'u1' }, sparse([101, 2054], [0.5, 1.25]));

    expect(client.createCollection).toHaveBeenCalledWith(
      'c',
      expect.objectContaining({ vectors: { size: 4, distance: 'Cosine' }, sparse_vectors: { sparse: {} } }),
    );
    expect(client.upsert).toHaveBeenCalledWith(
      'c',
      expect.objectContaining({
        points: [
          expect.objectContaining({
            vector: { '': [1, 0, 0, 0], sparse: { indices: [101, 2054], values: [0.5, 1.25] } },
            payload: expect.objectContaining({ _sourceId: 'itm_a', userId: 'u1' }),
          }),
        ],
      }),
    );

    client.query.mockResolvedValue({ points: [{ id: 7, score: 2.5, payload: { _sourceId: 'itm_a', userId: 'u1' } }] });
    const hits = await p.searchBySparseVector(sparse([2054], [2]), 5, { userId: 'u1' });

    expect(hits).toEqual([{ id: 'itm_a', score: 2.5, metadata: { _sourceId: 'itm_a', userId: 'u1' } }]);
    expect(client.query).toHaveBeenCalledWith('c', {
      query: { indices: [2054], values: [2] },
      using: 'sparse',
      limit: 5,
      filter: { must: [{ key: 'userId', match: { value: 'u1' } }] },
      with_payload: true,
    });
  });

  // Qdrant replaces a whole point on upsert, so a dense-only write would drop it from sparse search silently.
  it('a hybrid store refuses a dense-only upsert, which would erase the stored sparse vector', async () => {
    const p = new QdrantVectorProvider(config, { space, sparseSpace });
    await expect(p.upsertVector('a', [1, 0, 0, 0])).rejects.toThrow(/sparse vector per point/);
    expect(client.upsert).not.toHaveBeenCalled();
  });

  it('without a sparseSpace the dense collection and point are unchanged', async () => {
    const p = new QdrantVectorProvider(config, { space });
    await p.upsertVector('a', [1, 0, 0, 0]);

    expect(client.createCollection.mock.calls[0]?.[1]).not.toHaveProperty('sparse_vectors');
    expect(client.upsert).toHaveBeenCalledWith(
      'c',
      expect.objectContaining({ points: [expect.objectContaining({ vector: [1, 0, 0, 0] })] }),
    );
  });

  // Writing a sparse vector nobody can search, or one from another vocabulary, corrupts the index silently.
  it('refuses a sparse vector the store cannot hold, before touching the client', async () => {
    const dense = new QdrantVectorProvider(config, { space });
    await expect(dense.upsertVector('a', [1, 0, 0, 0], undefined, sparse([1], [1]))).rejects.toThrow(/no sparseSpace/);
    await expect(dense.searchBySparseVector(sparse([1], [1]))).rejects.toThrow(/no sparseSpace/);

    const hybrid = new QdrantVectorProvider(config, { space, sparseSpace });
    await expect(hybrid.searchBySparseVector(sparse([30_522], [1]))).rejects.toThrow(/outside the vocabulary/);
    await expect(hybrid.searchBySparseVector(sparse([1, 2], [1]))).rejects.toThrow(/2 indices but 1 values/);
    expect(client.getCollections).not.toHaveBeenCalled();
  });

  it('fails loud when an existing collection has no sparse vector', async () => {
    client.getCollections.mockResolvedValue({ collections: [{ name: 'c' }] });
    client.getCollection.mockResolvedValue({ config: { params: { vectors: { size: 4 } } } });

    const p = new QdrantVectorProvider(config, { space, sparseSpace });
    await expect(p.searchBySparseVector(sparse([1], [1]))).rejects.toThrow(/no sparse vector "sparse"/);
  });
});
