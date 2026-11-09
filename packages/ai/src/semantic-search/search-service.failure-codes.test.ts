import { describe, expect, it, vi } from 'vitest';

import { isEmbedFailure, RateLimited } from '@arki/embeddings';
import { fakeEmbedder } from '@arki/embeddings/testing';

import { VectorStoreUnavailable } from '../failures';
import { MockVectorProvider } from '../vector-search/providers/mock';
import { QdrantVectorProvider } from '../vector-search/providers/qdrant';
import { SemanticSearchService } from './search-service';

describe('SemanticSearchService returns the embedder failure and SpaceMismatch', () => {
  it('search returns the embedder failure for the query unchanged', async () => {
    // WHY: a caller tells "slow down" from "no results" by the code; it must not become a throw or an empty list.
    const embedder = fakeEmbedder({ dimensions: 3, failures: { 'too fast': RateLimited({}) } });
    const service = new SemanticSearchService({
      embedder,
      vectorProvider: new MockVectorProvider({ space: embedder.space }),
    });

    const result = await service.search({ query: 'too fast' });

    expect(isEmbedFailure(result) && result.code).toBe('embeddings.rate_limited');
    service.destroy();
  });

  it('search returns SpaceMismatch when the store is in another space than the query vector', async () => {
    // WHY: a query vector from another space would score meaningless numbers against the stored vectors.
    const embedder = fakeEmbedder({ dimensions: 3 });
    const vectorProvider = new MockVectorProvider({ space: { ...embedder.space, instructionVersion: 1 } });
    const searchByVector = vi.spyOn(vectorProvider, 'searchByVector');
    const service = new SemanticSearchService({ embedder, vectorProvider });

    const result = await service.search({ query: 'alpha' });

    expect(isEmbedFailure(result) && result.code).toBe('embeddings.space_mismatch');
    expect(searchByVector).not.toHaveBeenCalled();
    service.destroy();
  });

  it('indexDocuments returns the embedder failure and writes none of the failed batch', async () => {
    // WHY: a batch is all or nothing; half-written documents would make the index disagree with the caller's list.
    const embedder = fakeEmbedder({ dimensions: 3, failures: { 'too fast': RateLimited({}) } });
    const vectorProvider = new MockVectorProvider({ space: embedder.space });
    const service = new SemanticSearchService({ embedder, vectorProvider });

    const result = await service.indexDocuments([
      { id: 'a', text: 'alpha' },
      { id: 'b', text: 'too fast' },
    ]);

    expect(isEmbedFailure(result) && result.code).toBe('embeddings.rate_limited');
    expect(vectorProvider.getDocumentCount()).toBe(0);
    service.destroy();
  });

  it('indexDocuments returns VectorStoreUnavailable when the store cannot be reached, instead of throwing', async () => {
    // WHY: a store outage is an expected outcome the caller retries; a raw client error escaped as a throw.
    const embedder = fakeEmbedder({ dimensions: 3 });
    // A real Qdrant client aimed at a port nothing listens on: the connection is refused.
    const vectorProvider = new QdrantVectorProvider({ url: 'http://127.0.0.1:1', collectionName: 'docs' }, { space: embedder.space });
    const service = new SemanticSearchService({ embedder, vectorProvider });

    const result = await service.indexDocuments([
      { id: 'a', text: 'alpha' },
      { id: 'b', text: 'beta' },
    ]);

    expect(result).toMatchObject({ code: 'ai.vector_store_unavailable', status: 503, data: { operation: 'index' } });
    expect(VectorStoreUnavailable.is(result) && result.data.reason).toMatch(/\(0 of 2 documents written\)$/);
    service.destroy();
  });

  it('indexDocuments refuses a store that needs sparse vectors before embedding or writing anything', async () => {
    // WHY: the service writes dense vectors only, so every write to a hybrid store was refused one by one.
    const embedder = fakeEmbedder({ dimensions: 3, failures: { alpha: RateLimited({}) } });
    const vectorProvider = new QdrantVectorProvider(
      { url: 'http://127.0.0.1:1', collectionName: 'docs' },
      { space: embedder.space, sparseSpace: { ...embedder.space, dimensions: 30_522, vocabulary: 'naver/splade-v3' } },
    );
    const service = new SemanticSearchService({ embedder, vectorProvider });

    // The embedder would fail on 'alpha': a throw instead of that failure proves nothing was embedded first.
    await expect(service.indexDocuments([{ id: 'a', text: 'alpha' }])).rejects.toThrow(/sparse vector per point/);
    service.destroy();
  });

  it.each([0, -3, 1.5, Number.NaN])('indexDocuments throws on batchSize %s instead of looping forever', async batchSize => {
    // WHY: batchSize 0 never advanced the loop and a negative one walked backwards: the process hung. The caller picked the number, so it is a bug, thrown at once.
    const embedder = fakeEmbedder({ dimensions: 3 });
    const service = new SemanticSearchService({ embedder, vectorProvider: new MockVectorProvider({ space: embedder.space }) });

    await expect(service.indexDocuments([{ id: 'a', text: 'alpha' }], batchSize)).rejects.toThrow(/batchSize must be a positive integer/);
    service.destroy();
  });
});
