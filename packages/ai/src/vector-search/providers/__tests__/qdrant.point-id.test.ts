import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EmbeddingSpace } from '@arki/embeddings';

import { QdrantVectorProvider } from '../qdrant';

// ── Qdrant client mock ────────────────────────────────────────
// One shared spy object so assertions can read the point ids the provider sent.
const client = {
  getCollections: vi.fn(),
  createCollection: vi.fn(() => Promise.resolve()),
  createPayloadIndex: vi.fn(() => Promise.resolve()),
  upsert: vi.fn(() => Promise.resolve()),
  delete: vi.fn(() => Promise.resolve()),
  retrieve: vi.fn().mockResolvedValue([]),
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

const config = { url: 'http://qdrant.test', collectionName: 'c' };

/**
 * Golden point ids, produced by the SHA-1 (`node:crypto`) derivation this provider used before it moved to
 * WebCrypto. Points already stored in Qdrant carry these ids: if the derivation drifts by one byte, a re-index
 * writes duplicates and a delete misses the stored point, so the user's data is never erased.
 */
const GOLDEN: readonly (readonly [string, string])[] = [
  ['itm_a', 'd4a5e522-226d-53f4-aac5-2ccb5df0ed33'],
  ['ps_ab12cd34', '16397f57-b1c5-5f6b-b204-d54d914bc7c6'],
  ['usr_k3x9TQ2mVd8', 'bcf8219f-4046-548b-822b-d5e0c409576f'],
  // Non-ASCII ids hash their UTF-8 bytes.
  ['café ☕ 日本', 'e4ae769b-966e-572e-9601-75a9a6ecc797'],
  ['', 'da39a3ee-5e6b-5b0d-b255-bfef95601890'],
  ['a'.repeat(300), '003ef1ba-9ea9-52f4-9ab3-a2004e505ca8'],
];

beforeEach(() => {
  vi.clearAllMocks();
  client.getCollections.mockResolvedValue({ collections: [] });
});

describe('QdrantVectorProvider — point ids stay stable for stored points', () => {
  it.each(GOLDEN)('upsert derives the stored id for %j', async (id, pointId) => {
    const provider = new QdrantVectorProvider(config, { space });
    await provider.upsertVector(id, [0.1, 0.2, 0.3, 0.4], {});

    expect(client.upsert).toHaveBeenCalledWith(
      'c',
      expect.objectContaining({ points: [expect.objectContaining({ id: pointId })] }),
    );
  });

  it('a batch delete and a read address the same stored points as the upsert', async () => {
    const provider = new QdrantVectorProvider(config, { space });
    await provider.deleteDocumentsBatch(GOLDEN.map(([id]) => id));
    await provider.getDocument('itm_a');

    expect(client.delete).toHaveBeenCalledWith('c', { points: GOLDEN.map(([, pointId]) => pointId), wait: true });
    expect(client.retrieve).toHaveBeenCalledWith('c', expect.objectContaining({ ids: [GOLDEN[0]?.[1]] }));
  });

  it('unsigned integers and UUIDs pass through unchanged, since Qdrant accepts them as they are', async () => {
    const provider = new QdrantVectorProvider(config, { space });
    await provider.deleteDocumentsBatch(['42', '0f8fad5b-d9cb-469f-a165-70867728950e']);

    expect(client.delete).toHaveBeenCalledWith('c', {
      points: [42, '0f8fad5b-d9cb-469f-a165-70867728950e'],
      wait: true,
    });
  });
});
