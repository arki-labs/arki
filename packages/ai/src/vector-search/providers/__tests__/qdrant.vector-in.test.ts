import type { EmbeddingSpace } from '@arki/embeddings';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { VectorSearchError } from '../../../errors';
import { QdrantVectorProvider } from '../qdrant';

// ── Qdrant client mock ────────────────────────────────────────
// One shared spy object so assertions can read the calls the provider made.
const client = {
  getCollections: vi.fn(),
  getCollection: vi.fn(),
  createCollection: vi.fn().mockResolvedValue(undefined),
  createPayloadIndex: vi.fn().mockResolvedValue(undefined),
  upsert: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue({ points: [] }),
  scroll: vi.fn().mockResolvedValue({ points: [] }),
  delete: vi.fn().mockResolvedValue(undefined),
  retrieve: vi.fn().mockResolvedValue([]),
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

const space: EmbeddingSpace = {
  provider: 'fake',
  model: 'fake-4',
  dimensions: 4,
  normalized: true,
  quantization: 'float32',
  instructionVersion: 0,
};

const config = {
  url: 'http://qdrant.test',
  collectionName: 'c',
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
    const p = new QdrantVectorProvider(config, { space });
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

    const p = new QdrantVectorProvider(config, { space });
    await expect(p.searchByVector([1, 0, 0, 0], 5)).rejects.toThrow(/vectorSize 768.*configured for 4|Failed to ensure/i);
  });
});

describe('QdrantVectorProvider — vector-in methods', () => {
  it('upsertVector passes the raw vector through', async () => {
    const p = new QdrantVectorProvider(config, { space });
    await p.upsertVector('itm_a', [0.1, 0.2, 0.3, 0.4], { userId: 'u1', kind: 'item' });

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

  it('searchByVector maps _sourceId back to the caller id and passes the filter', async () => {
    client.query.mockResolvedValue({
      points: [{ id: 12_345, score: 0.91, payload: { _sourceId: 'itm_a', userId: 'u1' } }],
    });
    const p = new QdrantVectorProvider(config, { space });
    const hits = await p.searchByVector([0.1, 0.2, 0.3, 0.4], 5, { userId: 'u1', kind: 'item' });

    expect(hits).toEqual([{ id: 'itm_a', score: 0.91, metadata: { _sourceId: 'itm_a', userId: 'u1' } }]);
    // Filter translated to must-clauses.
    const searchArgs = client.query.mock.calls[0]![1] as { filter?: unknown };
    expect(searchArgs.filter).toBeDefined();
  });

  it('rejects a dimension mismatch before touching the client', async () => {
    const p = new QdrantVectorProvider(config, { space });
    await expect(p.upsertVector('a', [1, 2, 3], { userId: 'u1', kind: 'item' })).rejects.toThrow(/dimension mismatch/i);
  });

  it('translates flat filters to Qdrant-native clauses (value / any / range)', async () => {
    const p = new QdrantVectorProvider(config, { space });
    await p.searchByVector([1, 0, 0, 0], 5, {
      userId: 'u1',
      sourceId: ['src_a', 'src_b'],
      itemDate: { gte: 200 },
    });

    const searchArgs = client.query.mock.calls[0]![1] as { filter: { must: unknown[] } };
    expect(searchArgs.filter.must).toEqual([
      { key: 'userId', match: { value: 'u1' } },
      { key: 'sourceId', match: { any: ['src_a', 'src_b'] } },
      { key: 'itemDate', range: { gte: 200 } },
    ]);
  });

  // text-bible read passages with a 384-zero dummy vector; scroll reads by filter with no vector at all.
  it('scroll returns by filter without a vector', async () => {
    client.scroll.mockResolvedValue({
      points: [{ id: 7, payload: { _sourceId: 'ps_a', book: 'John' } }],
      next_page_offset: 8,
    });
    const p = new QdrantVectorProvider(config, { space });
    const page = await p.scroll({ book: 'John' }, { limit: 1 });

    expect(page).toEqual({ items: [{ id: 'ps_a', metadata: { _sourceId: 'ps_a', book: 'John' } }], next: '8' });
    const scrollArgs = client.scroll.mock.calls[0]![1] as Record<string, unknown>;
    expect(scrollArgs).toMatchObject({
      filter: { must: [{ key: 'book', match: { value: 'John' } }] },
      limit: 1,
      with_vector: false,
    });
    expect(scrollArgs).not.toHaveProperty('vector');
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe('QdrantVectorProvider — outages are not "not found" (F11)', () => {
  it('getDocument returns null only when the point is missing', async () => {
    const p = new QdrantVectorProvider(config, { space });
    client.retrieve.mockResolvedValueOnce([]);
    expect(await p.getDocument('missing')).toBeNull();
    client.retrieve.mockResolvedValueOnce([{ id: 1, payload: { userId: 'u1' } }]);
    expect(await p.getDocument('present')).toEqual({ userId: 'u1' });
  });

  it('getDocument lets a Qdrant error through instead of answering null', async () => {
    // WHY: an outage read as "no such document" makes callers re-create or skip data that exists.
    const p = new QdrantVectorProvider(config, { space });
    client.retrieve.mockRejectedValueOnce(new Error('fetch failed'));
    await expect(p.getDocument('a')).rejects.toThrow('fetch failed');
  });

  it('a url that is not a URL fails when the provider is built, as a VectorSearchError', () => {
    expect(() => new QdrantVectorProvider({ ...config, url: 'not a url' }, { space })).toThrow(VectorSearchError);
  });
});

describe('QdrantVectorProvider — spans', () => {
  const exporter = new InMemorySpanExporter();
  beforeAll(() => {
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
  });
  beforeEach(() => {
    exporter.reset();
  });
  afterAll(() => {
    trace.disable();
  });

  it('records an ai.vector.upsert span with the collection', async () => {
    const p = new QdrantVectorProvider(config, { space });
    await p.upsertVector('a', [1, 0, 0, 0], { userId: 'u1', kind: 'item' });

    const span = exporter.getFinishedSpans().find(finished => finished.name === 'ai.vector.upsert');
    expect(span?.instrumentationScope.name).toBe('@arki/ai');
    expect(span?.attributes['ai.vector.collection']).toBe('c');
    expect(span?.status.code).not.toBe(2);
  });

  it('marks the span failed with ai.vector_store_unavailable when Qdrant errors, and still throws the error', async () => {
    // WHY: the Qdrant client throws raw errors; the span is where an outage becomes visible.
    const p = new QdrantVectorProvider(config, { space });
    client.retrieve.mockRejectedValueOnce(new Error('fetch failed'));
    await expect(p.getDocument('a')).rejects.toThrow('fetch failed');

    const span = exporter.getFinishedSpans().find(finished => finished.name === 'ai.vector.retrieve');
    expect(span?.status.code).toBe(2);
    expect(span?.attributes['failure.code']).toBe('ai.vector_store_unavailable');
  });
});
