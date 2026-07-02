import { beforeEach, describe, expect, it, vi } from 'vitest';

import { QdrantVectorProvider } from '../qdrant';
import type { EmbeddingProvider } from '../../../types';

// ── Qdrant client mock ────────────────────────────────────────
// One shared spy object so assertions can read the calls the provider made.
const client = {
  getCollections: vi.fn(),
  getCollection: vi.fn(),
  createCollection: vi.fn().mockResolvedValue(undefined),
  createPayloadIndex: vi.fn().mockResolvedValue(undefined),
  upsert: vi.fn().mockResolvedValue(undefined),
  search: vi.fn().mockResolvedValue([]),
  delete: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@qdrant/js-client-rest', () => ({
  // A class whose constructor returns the shared spy object — `new QdrantClient()`
  // then yields `client`. (An arrow function can't be used with `new`.)
  QdrantClient: class {
    constructor() {
      return client;
    }
  },
}));

// The embedding provider must NEVER be touched on the vector-in path.
const getEmbedding = vi.fn();
const embed = {
  getEmbedding,
  getDimensions: () => 4,
} as unknown as EmbeddingProvider;

const config = {
  url: 'http://qdrant.test',
  collectionName: 'c',
  vectorSize: 4,
  replicationFactor: 1,
  payloadIndexes: ['userId', 'kind'],
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: collection does not exist yet → exercises the create path.
  client.getCollections.mockResolvedValue({ collections: [] });
});

describe('QdrantVectorProvider — collection setup (R3/R4/C9)', () => {
  it('creates the collection with the configured replication factor and payload indexes', async () => {
    const p = new QdrantVectorProvider(config, embed);
    // Any operation triggers getClient() → ensureCollection().
    await p.upsertVector('a', [1, 0, 0, 0], { userId: 'u1', kind: 'item' });

    expect(client.createCollection).toHaveBeenCalledWith(
      'c',
      expect.objectContaining({
        vectors: { size: 4, distance: 'Cosine' },
        replication_factor: 1,
      }),
    );
    expect(client.createPayloadIndex).toHaveBeenCalledWith(
      'c',
      expect.objectContaining({ field_name: 'userId', field_schema: 'keyword' }),
    );
    expect(client.createPayloadIndex).toHaveBeenCalledWith(
      'c',
      expect.objectContaining({ field_name: 'kind', field_schema: 'keyword' }),
    );
  });

  it('fails loud when an existing collection has a mismatched vector size (C6)', async () => {
    client.getCollections.mockResolvedValue({ collections: [{ name: 'c' }] });
    client.getCollection.mockResolvedValue({ config: { params: { vectors: { size: 768 } } } });

    const p = new QdrantVectorProvider(config, embed);
    await expect(p.searchByVector([1, 0, 0, 0], 5)).rejects.toThrow(/vectorSize 768.*configured for 4|Failed to ensure/i);
  });
});

describe('QdrantVectorProvider — vector-in methods', () => {
  it('upsertVector passes the raw vector through without embedding', async () => {
    const p = new QdrantVectorProvider(config, embed);
    await p.upsertVector('itm_a', [0.1, 0.2, 0.3, 0.4], { userId: 'u1', kind: 'item' });

    expect(getEmbedding).not.toHaveBeenCalled();
    expect(client.upsert).toHaveBeenCalledWith(
      'c',
      expect.objectContaining({
        points: [
          expect.objectContaining({
            vector: [0.1, 0.2, 0.3, 0.4],
            payload: expect.objectContaining({ userId: 'u1', kind: 'item', _sourceId: 'itm_a' }),
          }),
        ],
      }),
    );
  });

  it('searchByVector never embeds, maps _sourceId back to the caller id, and passes the filter', async () => {
    client.search.mockResolvedValue([
      { id: 12_345, score: 0.91, payload: { _sourceId: 'itm_a', userId: 'u1' } },
    ]);
    const p = new QdrantVectorProvider(config, embed);
    const hits = await p.searchByVector([0.1, 0.2, 0.3, 0.4], 5, { userId: 'u1', kind: 'item' });

    expect(getEmbedding).not.toHaveBeenCalled();
    expect(hits).toEqual([{ id: 'itm_a', score: 0.91, metadata: { _sourceId: 'itm_a', userId: 'u1' } }]);
    // Filter translated to must-clauses.
    const searchArgs = client.search.mock.calls[0]![1] as { filter?: unknown };
    expect(searchArgs.filter).toBeDefined();
  });

  it('rejects a dimension mismatch before touching the client', async () => {
    const p = new QdrantVectorProvider(config, embed);
    await expect(p.upsertVector('a', [1, 2, 3], { userId: 'u1', kind: 'item' })).rejects.toThrow(/dimension mismatch/i);
  });
});
