import { describe, expect, it, vi } from 'vitest';

import { isEmbedFailure } from '@arki/embeddings';
import { fakeEmbedder } from '@arki/embeddings/testing';

import { KeywordSearchUnavailable } from '../failures';
import { MockVectorProvider } from '../vector-search/providers/mock';
import { SemanticSearchService } from './search-service';

/** A service over one indexed document, with the real fake embedder and the in-memory vector store. */
async function serviceWith(text: string) {
  const embedder = fakeEmbedder({ dimensions: 3 });
  const service = new SemanticSearchService({ embedder, vectorProvider: new MockVectorProvider({ space: embedder.space }) });
  const indexed = await service.indexDocuments([{ id: 'doc', text, metadata: { lang: 'en' } }]);
  expect(isEmbedFailure(indexed)).toBe(false);
  return service;
}

describe('SemanticSearchService.indexDocuments', () => {
  // Vectors from another space would sit in the index where no query of the store's space finds them.
  it('an embedder in another space (same size, other instruction) is SpaceMismatch and writes nothing', async () => {
    const embedder = fakeEmbedder({ dimensions: 3 });
    const vectorProvider = new MockVectorProvider({ space: { ...embedder.space, instructionVersion: 1 } });
    const upsert = vi.spyOn(vectorProvider, 'upsertVector');
    const service = new SemanticSearchService({ embedder, vectorProvider });
    const result = await service.indexDocuments([
      { id: 'a', text: 'alpha' },
      { id: 'b', text: 'beta' },
    ]);
    expect(isEmbedFailure(result) && result.code).toBe('embeddings.space_mismatch');
    expect(upsert).not.toHaveBeenCalled();
    service.destroy();
  });
});

describe('SemanticSearchService.search (F10)', () => {
  it('highlights query words that contain RegExp syntax instead of throwing', async () => {
    // WHY: `c++` or `(` in a user's query built an invalid RegExp and the search threw SyntaxError.
    const service = await serviceWith('I write c++ (and c) every day');

    const results = await service.search({ query: 'c++ ( every', highlightTerms: true });

    expect(Array.isArray(results)).toBe(true);
    if (!Array.isArray(results)) return;
    expect(results[0]?.highlights?.some(highlight => highlight.includes('every'))).toBe(true);
    service.destroy();
  });

  it('keyword mode with no keyword provider returns KeywordSearchUnavailable instead of throwing', async () => {
    const service = await serviceWith('alpha');

    const result = await service.search({ query: 'alpha', mode: 'keyword' });

    expect(KeywordSearchUnavailable.is(result) && result.code).toBe('ai.keyword_search_unavailable');
    service.destroy();
  });

  it('a cached result never comes back in the shape of another request', async () => {
    // WHY: the cache key ignored includeMetadata and highlightTerms, so a request without metadata
    // got the cached result of a request with it (and the other way round).
    const service = await serviceWith('alpha beta');

    const withMetadata = await service.search({ query: 'alpha', includeMetadata: true, highlightTerms: true });
    const without = await service.search({ query: 'alpha', includeMetadata: false });

    expect(Array.isArray(withMetadata) && withMetadata[0]?.metadata).toBeTruthy();
    expect(Array.isArray(withMetadata) && withMetadata[0]?.highlights).toBeTruthy();
    expect(Array.isArray(without) && without[0] && 'metadata' in without[0]).toBe(false);
    expect(Array.isArray(without) && without[0]?.highlights).toBeUndefined();
    service.destroy();
  });
});
