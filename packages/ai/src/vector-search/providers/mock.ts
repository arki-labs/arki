/**
 * Mock Vector Search Provider for testing and development
 */

import type { EmbeddingProvider, VectorSearchProvider, VectorSearchResult } from '../../types';

export type MockDocument<TMetadata = Record<string, unknown>> = {
  id: string;
  text: string;
  embedding?: number[];
  metadata?: TMetadata;
}

export class MockVectorProvider<TMetadata = Record<string, unknown>> implements VectorSearchProvider<TMetadata> {
  private documents = new Map<string, MockDocument<TMetadata>>();
  private embeddingProvider: EmbeddingProvider;

  constructor(embeddingProvider: EmbeddingProvider) {
    this.embeddingProvider = embeddingProvider;
  }

  async indexDocument(
    id: string,
    text: string,
    metadata?: TMetadata,
  ): Promise<void> {
    const embedding = await this.embeddingProvider.getEmbedding(text);

    this.documents.set(id, {
      id,
      text,
      embedding,
      metadata,
    });
  }

  async indexDocumentsBatch(
    documents: {
      id: string;
      text: string;
      metadata?: TMetadata;
    }[],
  ): Promise<void> {
    for (const doc of documents) {
      await this.indexDocument(doc.id, doc.text, doc.metadata);
    }
  }

  async searchSimilar(
    query: string,
    limit = 10,
  ): Promise<VectorSearchResult<TMetadata>[]> {
    const queryEmbedding = await this.embeddingProvider.getEmbedding(query);
    const results: VectorSearchResult<TMetadata>[] = [];

    // Calculate cosine similarity with all documents
    for (const doc of this.documents.values()) {
      if (!doc.embedding) continue;

      const score = this.cosineSimilarity(queryEmbedding, doc.embedding);
      results.push({
        id: doc.id,
        score,
        metadata: doc.metadata,
      });
    }

    // Sort by score and return top results
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async upsertVector(id: string, vector: number[], metadata?: TMetadata): Promise<void> {
    // No source text on the vector-in path (e.g. a centroid) — store empty text.
    this.documents.set(id, { id, text: '', embedding: vector, metadata });
  }

  async searchByVector(
    vector: number[],
    limit = 10,
    filter?: Record<string, unknown>,
  ): Promise<VectorSearchResult<TMetadata>[]> {
    const results: VectorSearchResult<TMetadata>[] = [];

    for (const doc of this.documents.values()) {
      if (!doc.embedding) continue;
      // Payload filter: every key in `filter` must equal the doc's metadata.
      // Mirrors Qdrant's `must` match-clauses — this is what enforces tenant
      // isolation (userId) and kind scoping in tests.
      if (filter && !this.matchesFilter(doc.metadata, filter)) continue;

      results.push({
        id: doc.id,
        score: this.cosineSimilarity(vector, doc.embedding),
        metadata: doc.metadata,
      });
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private matchesFilter(metadata: TMetadata | undefined, filter: Record<string, unknown>): boolean {
    const meta = (metadata ?? {}) as Record<string, unknown>;
    return Object.entries(filter).every(([key, value]) => meta[key] === value);
  }

  async deleteDocument(id: string): Promise<void> {
    this.documents.delete(id);
  }

  async deleteDocumentsBatch(ids: string[]): Promise<void> {
    for (const id of ids) {
      this.documents.delete(id);
    }
  }

  async getEmbedding(text: string): Promise<number[]> {
    return this.embeddingProvider.getEmbedding(text);
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