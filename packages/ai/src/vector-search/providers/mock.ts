/**
 * Mock Vector Search Provider for testing and development
 */

import type { EmbeddingProvider, VectorSearchProvider, VectorSearchResult } from '../../types';

export interface MockDocument<TMetadata = any> {
  id: string;
  text: string;
  embedding?: number[];
  metadata?: TMetadata;
}

export class MockVectorProvider<TMetadata = any> implements VectorSearchProvider<TMetadata> {
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
    documents: Array<{
      id: string;
      text: string;
      metadata?: TMetadata;
    }>,
  ): Promise<void> {
    for (const doc of documents) {
      await this.indexDocument(doc.id, doc.text, doc.metadata);
    }
  }

  async searchSimilar(
    query: string,
    limit: number = 10,
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
    return Array.from(this.documents.values());
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

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i]! * b[i]!;
      magnitudeA += a[i]! * a[i]!;
      magnitudeB += b[i]! * b[i]!;
    }

    const magnitude = Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }
}