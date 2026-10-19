/**
 * Core types and interfaces for AI operations
 */

import type { EmbeddingSpace } from '@arki/embeddings';

import type { RAGServiceConfig } from './validation';

export type { RAGServiceConfig, SearchMode, SearchSettings } from './validation';

/**
 * Generic embedding provider interface
 */
export type EmbeddingProvider = {
  /**
   * Generate embedding for a single text
   */
  getEmbedding(text: string): Promise<number[]>;

  /**
   * Generate embeddings for multiple texts (batch processing)
   */
  getEmbeddings(texts: string[]): Promise<number[][]>;

  /**
   * Get the dimension size of embeddings
   */
  getDimensions?(): number;

  /**
   * Clear any internal cache
   */
  clearCache?(): void;
}

/**
 * Vector search result
 */
export type VectorSearchResult<TMetadata = Record<string, unknown>> = {
  id: string;
  score: number;
  metadata?: TMetadata;
}

/**
 * A page of points read by payload filter alone (no query vector).
 */
export type VectorScrollPage<TMetadata = Record<string, unknown>> = {
  items: { id: string; metadata?: TMetadata }[];
  /** Pass back as `offset` for the next page; absent on the last page. */
  next?: string;
};

/**
 * Vector search provider interface. Vectors in, vectors out: the caller embeds
 * (`@arki/embeddings`) and the store only stores and ranks. `space` is the one
 * embedding space every vector in this store belongs to.
 */
export type VectorSearchProvider<TMetadata = Record<string, unknown>> = {
  readonly space: EmbeddingSpace;

  /**
   * Upsert a document by its precomputed vector.
   */
  upsertVector(id: string, vector: ArrayLike<number>, metadata?: TMetadata): Promise<void>;

  /**
   * Search by a precomputed query vector.
   * `filter` is a provider-agnostic payload filter (e.g. `{ userId, kind }`).
   */
  searchByVector(
    vector: ArrayLike<number>,
    limit?: number,
    filter?: Record<string, unknown>
  ): Promise<VectorSearchResult<TMetadata>[]>;

  /**
   * Read points by payload filter only, in pages. Same flat filter as `searchByVector`.
   */
  scroll(
    filter: Record<string, unknown>,
    page: { limit: number; offset?: string }
  ): Promise<VectorScrollPage<TMetadata>>;

  /**
   * Delete a document from the index
   */
  deleteDocument(id: string): Promise<void>;

  /**
   * Delete multiple documents
   */
  deleteDocumentsBatch?(ids: string[]): Promise<void>;
}

/**
 * Generic search result
 */
export type SearchResult<TData = Record<string, unknown>> = {
  id: string;
  score: number;
  data?: TData;
  highlights?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Streaming response handler
 */
export type StreamingHandler = {
  onToken?: (token: string) => void;
  onComplete?: (fullText: string) => void;
  onError?: (error: Error) => void;
}

/**
 * RAG (Retrieval-Augmented Generation) configuration
 */
export type RAGConfig = {
  embeddingProvider: EmbeddingProvider;
  vectorSearchProvider: VectorSearchProvider;
  aiService: RAGServiceConfig;
  chunkSize?: number;
  chunkOverlap?: number;
  topK?: number;
  temperature?: number;
}

/**
 * Document chunk for RAG
 */
export type DocumentChunk = {
  id: string;
  content: string;
  metadata?: {
    source?: string;
    page?: number;
    section?: string;
    [key: string]: unknown;
  };
}

/**
 * Cache entry
 */
export type CacheEntry<T> = {
  data: T;
  timestamp: number;
  ttl: number;
}

/**
 * Analytics event
 */
export type AnalyticsEvent = {
  type: string;
  query?: string;
  results?: number;
  responseTime?: number;
  userId?: string;
  metadata?: Record<string, unknown>;
  timestamp: Date;
}
