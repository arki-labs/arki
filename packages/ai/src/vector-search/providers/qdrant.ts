/**
 * QDrant vector search provider
 * Production-ready implementation with advanced features
 */

import type { QdrantClient, Schemas as QdrantSchemas } from '@qdrant/js-client-rest';

import { debugVector } from '../../debug.ts';
import type { EmbeddingProvider, VectorSearchProvider, VectorSearchResult } from '../../types';
import { VectorSearchError, getErrorMessage } from '../../errors';
import { TransactionManager } from '../../utils/transaction-manager';

export type QdrantConfig = {
  url: string;
  apiKey?: string;
  collectionName: string;
  vectorSize?: number;
  createCollectionIfNotExists?: boolean;
}

export type QdrantSearchFilter = {
  must?: {
    key: string;
    match?: string | number | boolean | Record<string, unknown>;
    range?: {
      gt?: number;
      gte?: number;
      lt?: number;
      lte?: number;
    };
  }[];
  should?: {
    key: string;
    match?: string | number | boolean | Record<string, unknown>;
  }[];
  mustNot?: {
    key: string;
    match?: string | number | boolean | Record<string, unknown>;
  }[];
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

    debugVector(
      '[Qdrant] Provider initialized (collection: %s, vectorSize: %d, autoCreate: %s, url: %s)',
      this.collectionName,
      this.vectorSize,
      this.createIfNotExists,
      config.url,
    );
  }

  private async getClient(): Promise<QdrantClient> {
    if (!this.client) {
      debugVector('[Qdrant] Initializing Qdrant client (url: %s)', this.config.url);
      // Dynamic import to avoid loading if not needed
      const { QdrantClient } = await import('@qdrant/js-client-rest');

      this.client = new QdrantClient({
        url: this.config.url,
        apiKey: this.config.apiKey,
      });

      debugVector('[Qdrant] Client initialized successfully');

      if (this.createIfNotExists) {
        debugVector('[Qdrant] Auto-create enabled, ensuring collection exists');
        await this.ensureCollection();
      }
    }
    return this.client;
  }

  private async ensureCollection(): Promise<void> {
    if (!this.client) return;

    debugVector('[Qdrant] Checking if collection exists: %s', this.collectionName);

    try {
      // Check if collection exists
      const collections = await this.client.getCollections();
      const exists = collections.collections.some(
        (col) => col.name === this.collectionName
      );

      if (exists) {
        debugVector('[Qdrant] Collection already exists: %s', this.collectionName);
      } else {
        debugVector('[Qdrant] Collection does not exist, creating: %s (vectorSize: %d)', this.collectionName, this.vectorSize);
        // Create collection with optimized settings for semantic search
        await this.client.createCollection(this.collectionName, {
          vectors: {
            size: this.vectorSize,
            distance: 'Cosine', // Best for normalized embeddings
          },
          optimizers_config: {
            default_segment_number: 2,
            indexing_threshold: 20_000,
          },
          replication_factor: 2,
          write_consistency_factor: 1,
        });
        debugVector('[Qdrant] Collection created successfully: %s', this.collectionName);
      }
    } catch (error) {
      debugVector('[Qdrant] Failed to ensure collection: %s', getErrorMessage(error));
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
    debugVector('[Qdrant] Indexing document (id: %s, text length: %d)', id, text.length);
    const client = await this.getClient();

    // Generate embedding
    const vector = await this.embeddingProvider.getEmbedding(text);
    debugVector('[Qdrant] Generated embedding for document: %s (dimensions: %d)', id, vector.length);

    // Prepare point for indexing
    const point: QdrantSchemas['PointStruct'] = {
      id,
      vector,
      payload: {
        text: text.slice(0, 1000), // Store preview of text
        ...metadata,
        indexedAt: new Date().toISOString(),
      },
    };

    // Upsert the point (insert or update)
    await client.upsert(this.collectionName, {
      points: [point],
      wait: true, // Wait for the operation to complete
    });
    debugVector('[Qdrant] Document indexed successfully: %s', id);
  }

  async indexDocumentsBatch(
    documents: {
      id: string;
      text: string;
      metadata?: TMetadata;
    }[],
  ): Promise<void> {
    debugVector('[Qdrant] Indexing documents batch (count: %d)', documents.length);
    const client = await this.getClient();
    const transactionManager = new TransactionManager();

    // Keep track of indexed document IDs for rollback
    const indexedIds: string[] = [];

    try {
      // Generate embeddings in batch for efficiency
      const texts = documents.map(d => d.text);
      debugVector('[Qdrant] Generating embeddings for batch (count: %d)', texts.length);
      const embeddings = await this.embeddingProvider.getEmbeddings?.(texts)
        || await Promise.all(texts.map(t => this.embeddingProvider.getEmbedding(t)));
      debugVector('[Qdrant] Embeddings generated successfully (count: %d)', embeddings.length);

      // Prepare points for batch indexing
      const points: QdrantSchemas['PointStruct'][] = documents.map((doc, i) => ({
        id: doc.id,
        vector: embeddings[i]!,
        payload: {
          text: doc.text.slice(0, 1000),
          ...doc.metadata,
          indexedAt: new Date().toISOString(),
        },
      }));

      // Create transaction operations for each batch
      const batchSize = 100;
      const operations = [];
      const numBatches = Math.ceil(points.length / batchSize);

      debugVector('[Qdrant] Splitting into %d batches of max %d documents', numBatches, batchSize);

      for (let i = 0; i < points.length; i += batchSize) {
        const batch = points.slice(i, i + batchSize);
        const batchIds = batch.map(p => p.id as string);
        const batchNum = Math.floor(i / batchSize) + 1;

        operations.push({
          name: `Index batch ${batchNum}`,
          execute: async () => {
            debugVector('[Qdrant] Executing batch %d/%d (documents: %d)', batchNum, numBatches, batch.length);
            await client.upsert(this.collectionName, {
              points: batch,
              wait: true,
            });
            indexedIds.push(...batchIds);
            debugVector('[Qdrant] Batch %d/%d indexed successfully', batchNum, numBatches);
            return batchIds;
          },
          rollback: async () => {
            // Remove indexed documents on rollback
            if (batchIds.length > 0) {
              debugVector('[Qdrant] Rolling back batch %d (removing %d documents)', batchNum, batchIds.length);
              await client.delete(this.collectionName, {
                points: batchIds,
                wait: true,
              });
            }
          },
        });
      }

      // Execute all operations with transaction support
      debugVector('[Qdrant] Executing transaction with %d operations', operations.length);
      const result = await transactionManager.executeTransaction(operations);

      if (!result.success) {
        debugVector('[Qdrant] Transaction failed, rolling back');
        throw result.error || new VectorSearchError('Batch indexing failed');
      }

      debugVector('[Qdrant] Batch indexing completed successfully (total documents: %d)', documents.length);
    } catch (error) {
      debugVector('[Qdrant] Batch indexing failed: %s', getErrorMessage(error));
      throw new VectorSearchError(
        `Failed to index documents batch: ${getErrorMessage(error)}`,
        error
      );
    }
  }

  async searchSimilar(
    query: string,
    limit = 10,
    filter?: QdrantSearchFilter,
  ): Promise<VectorSearchResult<TMetadata>[]> {
    debugVector('[Qdrant] Searching similar documents (query length: %d, limit: %d, hasFilter: %s)', query.length, limit, !!filter);
    const client = await this.getClient();

    // Generate query embedding
    const queryVector = await this.embeddingProvider.getEmbedding(query);
    debugVector('[Qdrant] Generated query embedding (dimensions: %d)', queryVector.length);

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

    debugVector('[Qdrant] Search completed (results: %d)', searchResult.length);

    // Transform results
    return searchResult.map((result) => ({
      id: result.id as string,
      score: result.score,
      metadata: result.payload as TMetadata,
    }));
  }

  async hybridSearch(
    query: string,
    limit = 10,
    filter?: QdrantSearchFilter,
    keywordWeight = 0.3,
  ): Promise<VectorSearchResult<TMetadata>[]> {
    debugVector('[Qdrant] Hybrid search (query length: %d, limit: %d, keywordWeight: %f)', query.length, limit, keywordWeight);
    const client = await this.getClient();

    // Generate query embedding for semantic search
    const queryVector = await this.embeddingProvider.getEmbedding(query);
    debugVector('[Qdrant] Generated query embedding (dimensions: %d)', queryVector.length);

    // Build filter including text search
    const baseFilter = filter ? this.buildQdrantFilter(filter) : undefined;
    const hybridFilter = filter ? {
      ...baseFilter,
      must: [
        ...((baseFilter?.['must'] as unknown[]) || []),
        {
          key: 'text',
          match: {
            text: query.toLowerCase(),
          },
        },
      ],
    } : undefined;

    // Perform semantic search
    debugVector('[Qdrant] Performing semantic search (initial limit: %d)', limit * 2);
    const searchResult = await client.search(this.collectionName, {
      vector: queryVector,
      limit: limit * 2, // Get more results for re-ranking
      filter: hybridFilter,
      with_payload: true,
    });
    debugVector('[Qdrant] Semantic search completed (results: %d)', searchResult.length);

    // Re-rank based on combined score (semantic + keyword match)
    debugVector('[Qdrant] Re-ranking results with keyword scores');
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
    const finalResults = rerankedResults
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    debugVector('[Qdrant] Hybrid search completed (final results: %d)', finalResults.length);
    return finalResults;
  }

  async deleteDocument(id: string): Promise<void> {
    debugVector('[Qdrant] Deleting document (id: %s)', id);
    const client = await this.getClient();

    await client.delete(this.collectionName, {
      points: [id],
      wait: true,
    });
    debugVector('[Qdrant] Document deleted successfully: %s', id);
  }

  async deleteDocumentsBatch(ids: string[]): Promise<void> {
    debugVector('[Qdrant] Deleting documents batch (count: %d)', ids.length);
    const client = await this.getClient();

    await client.delete(this.collectionName, {
      points: ids,
      wait: true,
    });
    debugVector('[Qdrant] Batch deletion completed (count: %d)', ids.length);
  }

  async getEmbedding(text: string): Promise<number[]> {
    return this.embeddingProvider.getEmbedding(text);
  }

  async getCollectionStats(): Promise<{
    vectorCount: number;
    indexedSize: number;
    segmentsCount: number;
  }> {
    debugVector('[Qdrant] Getting collection stats: %s', this.collectionName);
    const client = await this.getClient();
    const info = await client.getCollection(this.collectionName);

    const stats = {
      vectorCount: info.points_count ?? 0,
      indexedSize: info.indexed_vectors_count ?? 0,
      segmentsCount: info.segments_count ?? 0,
    };

    debugVector(
      '[Qdrant] Collection stats (vectors: %d, indexed: %d, segments: %d)',
      stats.vectorCount,
      stats.indexedSize,
      stats.segmentsCount,
    );

    return stats;
  }

  async optimizeCollection(): Promise<void> {
    debugVector('[Qdrant] Optimizing collection: %s', this.collectionName);
    const client = await this.getClient();

    // Trigger optimization to improve search performance
    await client.updateCollection(this.collectionName, {
      optimizers_config: {
        indexing_threshold: 10_000,
        default_segment_number: 2,
      },
    });
    debugVector('[Qdrant] Collection optimization completed: %s', this.collectionName);
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
    const positionBonus = firstMatchIndex === -1
      ? 0
      : Math.max(0, 1 - firstMatchIndex / 1000) * 0.2;

    return Math.min(1, baseScore + score + positionBonus);
  }

  /**
   * Clear the entire collection (use with caution!)
   */
  async clearCollection(): Promise<void> {
    debugVector('[Qdrant] Clearing entire collection: %s (use with caution!)', this.collectionName);
    const client = await this.getClient();

    // Delete and recreate collection
    await client.deleteCollection(this.collectionName);
    debugVector('[Qdrant] Collection deleted: %s', this.collectionName);
    await this.ensureCollection();
    debugVector('[Qdrant] Collection cleared and recreated: %s', this.collectionName);
  }

  /**
   * Get document by ID
   */
  async getDocument(id: string): Promise<TMetadata | null> {
    debugVector('[Qdrant] Getting document by ID: %s', id);
    const client = await this.getClient();

    try {
      const points = await client.retrieve(this.collectionName, {
        ids: [id],
        with_payload: true,
        with_vector: false,
      });

      const result = points[0]?.payload as TMetadata || null;
      debugVector('[Qdrant] Document retrieved: %s (found: %s)', id, !!result);
      return result;
    } catch (error) {
      debugVector('[Qdrant] Failed to get document: %s - %s', id, getErrorMessage(error));
      return null;
    }
  }
}