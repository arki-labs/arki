/**
 * Core types and interfaces for AI operations
 */

import type { Embedder, EmbeddingSpace } from '@arki/embeddings';
import type { SparseSpace, SparseVector } from '@arki/embeddings/sparse';

import type { RAGServiceConfig } from './validation.js';

export type { RAGServiceConfig, SearchMode, SearchSettings } from './validation.js';

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
 * embedding space every vector in this store belongs to; `sparseSpace`, when set, is the space of
 * the one sparse vector (`@arki/embeddings/sparse`) a document may carry next to it. The store checks
 * only sizes against an existing collection; `requireSparseSpace` / `isSameSpace` before writing is the
 * caller's gate against mixing vocabularies or models.
 */
export type VectorSearchProvider<TMetadata = Record<string, unknown>> = {
  readonly space: EmbeddingSpace;
  readonly sparseSpace?: SparseSpace;

  /**
   * Upsert a document by its precomputed vector, plus its sparse vector when the store has a
   * `sparseSpace`.
   */
  upsertVector(id: string, vector: ArrayLike<number>, metadata?: TMetadata, sparse?: SparseVector): Promise<void>;

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
   * Search by a precomputed sparse query vector, ranked by dot product. Only stores with a
   * `sparseSpace` have it. Same flat filter as `searchByVector`.
   */
  searchBySparseVector?(
    vector: SparseVector,
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
  embedder: Embedder;
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
