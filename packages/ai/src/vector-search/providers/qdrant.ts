/**
 * QDrant vector search provider
 * Production-ready implementation with advanced features
 */

import type { QdrantClient, Schemas as QdrantSchemas } from '@qdrant/js-client-rest';

import type { EmbeddingProvider, VectorSearchProvider, VectorSearchResult } from '../../types';
import { VectorSearchError, getErrorMessage } from '../../errors';
import { TransactionManager } from '../../utils/transaction-manager';

export interface QdrantConfig {
  url: string;
  apiKey?: string;
  collectionName: string;
  vectorSize?: number;
  createCollectionIfNotExists?: boolean;
}

export interface QdrantSearchFilter {
  must?: Array<{
    key: string;
    match?: string | number | boolean | Record<string, unknown>;
    range?: {
      gt?: number;
      gte?: number;
      lt?: number;
      lte?: number;
    };
  }>;
  should?: Array<{
    key: string;
    match?: string | number | boolean | Record<string, unknown>;
  }>;
  mustNot?: Array<{
    key: string;
    match?: string | number | boolean | Record<string, unknown>;
  }>;
}

export class QdrantVectorProvider<TMetadata = Record<string, unknown>> implements VectorSearchProvider<TMetadata> {
  private client: QdrantClient | null = null;
  private collectionName: string;
  private vectorSize: number;
  private embeddingProvider: EmbeddingProvider;
  private createIfNotExists: boolean;

  constructor(
    private config: QdrantConfig,
    embeddingProvider: EmbeddingProvider,
  ) {
    this.collectionName = config.collectionName;
    this.vectorSize = config.vectorSize || embeddingProvider.getDimensions?.() || 1536;
    this.embeddingProvider = embeddingProvider;
    this.createIfNotExists = config.createCollectionIfNotExists !== false;
  }

  private async getClient(): Promise<QdrantClient> {
    if (!this.client) {
      // Dynamic import to avoid loading if not needed
      const { QdrantClient } = await import('@qdrant/js-client-rest');

      this.client = new QdrantClient({
        url: this.config.url,
        apiKey: this.config.apiKey,
      });

      if (this.createIfNotExists) {
        await this.ensureCollection();
      }
    }
    return this.client;
  }

  private async ensureCollection(): Promise<void> {
    if (!this.client) return;

    try {
      // Check if collection exists
      const collections = await this.client.getCollections();
      const exists = collections.collections.some(
        (col) => col.name === this.collectionName
      );

      if (!exists) {
        // Create collection with optimized settings for semantic search
        await this.client.createCollection(this.collectionName, {
          vectors: {
            size: this.vectorSize,
            distance: 'Cosine', // Best for normalized embeddings
          },
          optimizers_config: {
            default_segment_number: 2,
            indexing_threshold: 20000,
          },
          replication_factor: 2,
          write_consistency_factor: 1,
        });
      }
    } catch (error) {
      // Log the error but don't throw - collection might exist or be created manually
      // In production, you might want to use a proper logger here
      throw new VectorSearchError(
        `Failed to ensure QDrant collection: ${getErrorMessage(error)}`,
        error
      );
    }
  }

  async indexDocument(
    id: string,
    text: string,
    metadata?: TMetadata,
  ): Promise<void> {
    const client = await this.getClient();

    // Generate embedding
    const vector = await this.embeddingProvider.getEmbedding(text);

    // Prepare point for indexing
    const point: QdrantSchemas['PointStruct'] = {
      id,
      vector,
      payload: {
        text: text.substring(0, 1000), // Store preview of text
        ...metadata,
        indexedAt: new Date().toISOString(),
      },
    };

    // Upsert the point (insert or update)
    await client.upsert(this.collectionName, {
      points: [point],
      wait: true, // Wait for the operation to complete
    });
  }

  async indexDocumentsBatch(
    documents: Array<{
      id: string;
      text: string;
      metadata?: TMetadata;
    }>,
  ): Promise<void> {
    const client = await this.getClient();
    const transactionManager = new TransactionManager();

    // Keep track of indexed document IDs for rollback
    const indexedIds: string[] = [];

    try {
      // Generate embeddings in batch for efficiency
      const texts = documents.map(d => d.text);
      const embeddings = await this.embeddingProvider.getEmbeddings?.(texts)
        || await Promise.all(texts.map(t => this.embeddingProvider.getEmbedding(t)));

      // Prepare points for batch indexing
      const points: QdrantSchemas['PointStruct'][] = documents.map((doc, i) => ({
        id: doc.id,
        vector: embeddings[i]!,
        payload: {
          text: doc.text.substring(0, 1000),
          ...doc.metadata,
          indexedAt: new Date().toISOString(),
        },
      }));

      // Create transaction operations for each batch
      const batchSize = 100;
      const operations = [];

      for (let i = 0; i < points.length; i += batchSize) {
        const batch = points.slice(i, i + batchSize);
        const batchIds = batch.map(p => p.id as string);

        operations.push({
          name: `Index batch ${Math.floor(i / batchSize) + 1}`,
          execute: async () => {
            await client.upsert(this.collectionName, {
              points: batch,
              wait: true,
            });
            indexedIds.push(...batchIds);
            return batchIds;
          },
          rollback: async () => {
            // Remove indexed documents on rollback
            if (batchIds.length > 0) {
              await client.delete(this.collectionName, {
                points: batchIds,
                wait: true,
              });
            }
          },
        });
      }

      // Execute all operations with transaction support
      const result = await transactionManager.executeTransaction(operations);

      if (!result.success) {
        throw result.error || new VectorSearchError('Batch indexing failed');
      }
    } catch (error) {
      throw new VectorSearchError(
        `Failed to index documents batch: ${getErrorMessage(error)}`,
        error
      );
    }
  }

  async searchSimilar(
    query: string,
    limit: number = 10,
    filter?: QdrantSearchFilter,
  ): Promise<VectorSearchResult<TMetadata>[]> {
    const client = await this.getClient();

    // Generate query embedding
    const queryVector = await this.embeddingProvider.getEmbedding(query);

    // Build QDrant filter from our search filter
    const qdrantFilter = filter ? this.buildQdrantFilter(filter) : undefined;

    // Perform semantic search
    const searchResult = await client.search(this.collectionName, {
      vector: queryVector,
      limit,
      filter: qdrantFilter,
      with_payload: true,
      score_threshold: 0, // Return all results, let caller filter by score
    });

    // Transform results
    return searchResult.map((result) => ({
      id: result.id as string,
      score: result.score,
      metadata: result.payload as TMetadata,
    }));
  }

  async hybridSearch(
    query: string,
    limit: number = 10,
    filter?: QdrantSearchFilter,
    keywordWeight: number = 0.3,
  ): Promise<VectorSearchResult<TMetadata>[]> {
    const client = await this.getClient();

    // Generate query embedding for semantic search
    const queryVector = await this.embeddingProvider.getEmbedding(query);

    // Build filter including text search
    const baseFilter = filter ? this.buildQdrantFilter(filter) : undefined;
    const hybridFilter = filter ? {
      ...baseFilter,
      must: [
        ...((baseFilter?.['must'] as Array<unknown>) || []),
        {
          key: 'text',
          match: {
            text: query.toLowerCase(),
          },
        },
      ],
    } : undefined;

    // Perform semantic search
    const searchResult = await client.search(this.collectionName, {
      vector: queryVector,
      limit: limit * 2, // Get more results for re-ranking
      filter: hybridFilter,
      with_payload: true,
    });

    // Re-rank based on combined score (semantic + keyword match)
    const rerankedResults = searchResult.map((result) => {
      const semanticScore = result.score;
      const text = ((result.payload as Record<string, unknown>)?.['text'] as string) || '';
      const keywordScore = this.calculateKeywordScore(text, query);

      // Weighted combination of scores
      const combinedScore = semanticScore * (1 - keywordWeight) + keywordScore * keywordWeight;

      return {
        id: result.id as string,
        score: combinedScore,
        metadata: result.payload as TMetadata,
      };
    });

    // Sort by combined score and return top results
    return rerankedResults
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async deleteDocument(id: string): Promise<void> {
    const client = await this.getClient();

    await client.delete(this.collectionName, {
      points: [id],
      wait: true,
    });
  }

  async deleteDocumentsBatch(ids: string[]): Promise<void> {
    const client = await this.getClient();

    await client.delete(this.collectionName, {
      points: ids,
      wait: true,
    });
  }

  async getEmbedding(text: string): Promise<number[]> {
    return this.embeddingProvider.getEmbedding(text);
  }

  async getCollectionStats(): Promise<{
    vectorCount: number;
    indexedSize: number;
    segmentsCount: number;
  }> {
    const client = await this.getClient();
    const info = await client.getCollection(this.collectionName);

    return {
      vectorCount: info.vectors_count || 0,
      indexedSize: info.indexed_vectors_count || 0,
      segmentsCount: info.segments_count || 0,
    };
  }

  async optimizeCollection(): Promise<void> {
    const client = await this.getClient();

    // Trigger optimization to improve search performance
    await client.updateCollection(this.collectionName, {
      optimizers_config: {
        indexing_threshold: 10000,
        default_segment_number: 2,
      },
    });
  }

  // Note: Field indexing is handled automatically by Qdrant based on usage patterns
  // If needed in the future, this would require using the collection update API
  // to modify the collection's indexing configuration

  private buildQdrantFilter(filter: QdrantSearchFilter): Record<string, unknown> | undefined {
    const conditions: Record<string, unknown> = {};

    // Must conditions (AND)
    if (filter.must && filter.must.length > 0) {
      conditions['must'] = filter.must;
    }

    // Should conditions (OR)
    if (filter.should && filter.should.length > 0) {
      conditions['should'] = filter.should;
    }

    // Must not conditions (NOT)
    if (filter.mustNot && filter.mustNot.length > 0) {
      conditions['must_not'] = filter.mustNot;
    }

    return Object.keys(conditions).length > 0 ? conditions : undefined;
  }

  private calculateKeywordScore(text: string, query: string): number {
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const words = lowerQuery.split(/\s+/);

    let score = 0;
    let matchedWords = 0;

    for (const word of words) {
      if (lowerText.includes(word)) {
        matchedWords++;
        // Bonus for exact word match
        const regex = new RegExp(`\\b${word}\\b`, 'gi');
        const exactMatches = (lowerText.match(regex) || []).length;
        score += exactMatches * 0.1;
      }
    }

    // Base score from matched words ratio
    const baseScore = matchedWords / words.length;

    // Add position bonus (earlier matches score higher)
    const firstMatchIndex = lowerText.indexOf(lowerQuery);
    const positionBonus = firstMatchIndex !== -1
      ? Math.max(0, 1 - firstMatchIndex / 1000) * 0.2
      : 0;

    return Math.min(1, baseScore + score + positionBonus);
  }

  /**
   * Clear the entire collection (use with caution!)
   */
  async clearCollection(): Promise<void> {
    const client = await this.getClient();

    // Delete and recreate collection
    await client.deleteCollection(this.collectionName);
    await this.ensureCollection();
  }

  /**
   * Get document by ID
   */
  async getDocument(id: string): Promise<TMetadata | null> {
    const client = await this.getClient();

    try {
      const points = await client.retrieve(this.collectionName, {
        ids: [id],
        with_payload: true,
        with_vector: false,
      });

      return points[0]?.payload as TMetadata || null;
    } catch (error) {
      return null;
    }
  }
}