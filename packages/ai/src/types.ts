/**
 * Core types and interfaces for AI operations
 */

/**
 * Generic embedding provider interface
 */
export interface EmbeddingProvider {
  /**
   * Generate embedding for a single text
   */
  getEmbedding(text: string): Promise<number[]>;

  /**
   * Generate embeddings for multiple texts (batch processing)
   */
  getEmbeddings?(texts: string[]): Promise<number[][]>;

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
export interface VectorSearchResult<TMetadata = Record<string, unknown>> {
  id: string;
  score: number;
  metadata?: TMetadata;
}

/**
 * Vector search provider interface
 */
export interface VectorSearchProvider<TMetadata = Record<string, unknown>> {
  /**
   * Index a document with its embedding
   */
  indexDocument(id: string, text: string, metadata?: TMetadata): Promise<void>;

  /**
   * Index multiple documents in batch
   */
  indexDocumentsBatch?(documents: Array<{
    id: string;
    text: string;
    metadata?: TMetadata;
  }>): Promise<void>;

  /**
   * Search for similar documents
   */
  searchSimilar(
    query: string,
    limit?: number,
    filter?: Record<string, unknown>
  ): Promise<VectorSearchResult<TMetadata>[]>;

  /**
   * Delete a document from the index
   */
  deleteDocument(id: string): Promise<void>;

  /**
   * Delete multiple documents
   */
  deleteDocumentsBatch?(ids: string[]): Promise<void>;

  /**
   * Get embedding for text (may delegate to embedding provider)
   */
  getEmbedding(text: string): Promise<number[]>;
}

/**
 * Search modes
 */
export type SearchMode = 'semantic' | 'keyword' | 'hybrid';

/**
 * Generic search result
 */
export interface SearchResult<TData = Record<string, unknown>> {
  id: string;
  score: number;
  data?: TData;
  highlights?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Search options
 */
export interface SearchOptions {
  mode?: SearchMode;
  limit?: number;
  offset?: number;
  scoreThreshold?: number;
  includeMetadata?: boolean;
  highlightTerms?: boolean;
}

/**
 * AI service configuration
 */
export interface AIServiceConfig {
  provider: 'openai' | 'anthropic' | 'cohere' | 'local';
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Streaming response handler
 */
export interface StreamingHandler {
  onToken?: (token: string) => void;
  onComplete?: (fullText: string) => void;
  onError?: (error: Error) => void;
}

/**
 * RAG (Retrieval-Augmented Generation) configuration
 */
export interface RAGConfig {
  embeddingProvider: EmbeddingProvider;
  vectorSearchProvider: VectorSearchProvider;
  aiService: AIServiceConfig;
  chunkSize?: number;
  chunkOverlap?: number;
  topK?: number;
  temperature?: number;
}

/**
 * Document chunk for RAG
 */
export interface DocumentChunk {
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
export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

/**
 * Analytics event
 */
export interface AnalyticsEvent {
  type: string;
  query?: string;
  results?: number;
  responseTime?: number;
  userId?: string;
  metadata?: Record<string, unknown>;
  timestamp: Date;
}