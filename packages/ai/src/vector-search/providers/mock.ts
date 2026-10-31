/**
 * Mock Vector Search Provider for testing and development
 */

import type { EmbeddingSpace } from '@arki/embeddings';

import type { VectorScrollPage, VectorSearchProvider, VectorSearchResult } from '../../types.js';
import { VectorSearchError } from '../../errors.js';

export type MockDocument<TMetadata = Record<string, unknown>> = {
  id: string;
  embedding: number[];
  metadata?: TMetadata;
}

export class MockVectorProvider<TMetadata = Record<string, unknown>> implements VectorSearchProvider<TMetadata> {
  readonly space: EmbeddingSpace;
  private documents = new Map<string, MockDocument<TMetadata>>();

  constructor({ space }: { space: EmbeddingSpace }) {
    this.space = space;
  }

  /** Refuse a vector of the wrong size, exactly as the Qdrant provider does, so tests see dimension bugs. */
  private checkDimensions(vector: number[], where: string): void {
    if (vector.length !== this.space.dimensions) {
      throw new VectorSearchError(`${where} dimension mismatch: got ${vector.length}, collection is ${this.space.dimensions}.`);
    }
  }

  async upsertVector(id: string, vector: ArrayLike<number>, metadata?: TMetadata): Promise<void> {
    // eslint-disable-next-line unicorn/prefer-spread -- an ArrayLike (a typed array or array-like) has no iterator in its type
    const embedding = Array.from(vector);
    this.checkDimensions(embedding, `upsertVector "${id}"`);
    this.documents.set(id, { id, embedding, metadata });
  }

  async searchByVector(
    vector: ArrayLike<number>,
    limit = 10,
    filter?: Record<string, unknown>,
  ): Promise<VectorSearchResult<TMetadata>[]> {
    // eslint-disable-next-line unicorn/prefer-spread -- an ArrayLike (a typed array or array-like) has no iterator in its type
    const query = Array.from(vector);
    this.checkDimensions(query, 'searchByVector');
    const results: VectorSearchResult<TMetadata>[] = [];

    for (const doc of this.documents.values()) {
      // Payload filter: every key in `filter` must equal the doc's metadata.
      // Mirrors Qdrant's `must` match-clauses — this is what enforces tenant
      // isolation (userId) and kind scoping in tests.
      if (filter && !this.matchesFilter(doc.metadata, filter)) continue;

      results.push({
        id: doc.id,
        score: this.cosineSimilarity(query, doc.embedding),
        metadata: doc.metadata,
      });
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async scroll(
    filter: Record<string, unknown>,
    { limit, offset }: { limit: number; offset?: string },
  ): Promise<VectorScrollPage<TMetadata>> {
    const matching = [...this.documents.values()].filter(doc => this.matchesFilter(doc.metadata, filter));
    const start = offset === undefined ? 0 : Number(offset);
    const items = matching.slice(start, start + limit).map(doc => ({ id: doc.id, metadata: doc.metadata }));
    const end = start + items.length;
    return end < matching.length ? { items, next: String(end) } : { items };
  }

  private matchesFilter(metadata: TMetadata | undefined, filter: Record<string, unknown>): boolean {
    const meta = (metadata ?? {}) as Record<string, unknown>;
    // Mirrors the Qdrant provider's flat-filter semantics:
    //   scalar → equality, array → IN, {gt|gte|lt|lte} → numeric range.
    return Object.entries(filter).every(([key, value]) => {
      const actual = meta[key];
      if (Array.isArray(value)) return value.includes(actual);
      if (typeof value === 'object' && value !== null) {
        if (typeof actual !== 'number') return false;
        const range = value as { gt?: number; gte?: number; lt?: number; lte?: number };
        if (range.gt !== undefined && !(actual > range.gt)) return false;
        if (range.gte !== undefined && !(actual >= range.gte)) return false;
        if (range.lt !== undefined && !(actual < range.lt)) return false;
        if (range.lte !== undefined && !(actual <= range.lte)) return false;
        return true;
      }
      return actual === value;
    });
  }

  async deleteDocument(id: string): Promise<void> {
    this.documents.delete(id);
  }

  async deleteDocumentsBatch(ids: string[]): Promise<void> {
    for (const id of ids) {
      this.documents.delete(id);
    }
  }

  /**
   * Clear all documents from the mock store
   */
  clearAll(): void {
    this.documents.clear();
  }

  /**
   * Get all documents (for testing)
   */
  getAllDocuments(): MockDocument<TMetadata>[] {
    return [...this.documents.values()];
  }

  /**
   * Get document by ID (for testing)
   */
  getDocument(id: string): MockDocument<TMetadata> | undefined {
    return this.documents.get(id);
  }

  /**
   * Get document count (for testing)
   */
  getDocumentCount(): number {
    return this.documents.size;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let magnitudeA = 0;
    let magnitudeB = 0;

    for (const [i, element] of a.entries()) {
      dotProduct += element * b[i]!;
      magnitudeA += element * element;
      magnitudeB += b[i]! * b[i]!;
    }

    const magnitude = Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }
}