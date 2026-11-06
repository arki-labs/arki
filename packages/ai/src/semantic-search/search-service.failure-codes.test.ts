import { describe, expect, it, vi } from 'vitest';

import { isEmbedFailure, RateLimited } from '@arki/embeddings';
import { fakeEmbedder } from '@arki/embeddings/testing';

import { MockVectorProvider } from '../vector-search/providers/mock';
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
});
