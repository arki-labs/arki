import { describe, expect, it, vi } from 'vitest';

import { isEmbedFailure } from '@arki/embeddings';
import { fakeEmbedder } from '@arki/embeddings/testing';

import { MockVectorProvider } from '../vector-search/providers/mock';
import { SemanticSearchService } from './search-service';

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
