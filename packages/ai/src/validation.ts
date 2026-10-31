/**
 * The config and input types of @arki/ai. Validate values against their schemas with `parse` from
 * `@arki/schema`, which returns `InvalidInput` instead of throwing.
 *
 * Each type below is the source. Its runtime schema lives in `validation-schemas.ts` (offered to callers
 * by `@arki/ai/zod`), and `zod.test.ts` locks the two together, so this entry's types carry no Zod.
 */
import type { SanitizerConfig } from './safety/types.js';

/** Qdrant connection settings. */
export type QdrantConfig = {
  url: string;
  apiKey?: string;
  collectionName: string;
  vectorSize?: number;
  createCollectionIfNotExists?: boolean;
};

/** Vector search provider configuration, one member per provider. `embeddingProvider` is checked at runtime. */
export type VectorProviderConfig =
  | { type: 'qdrant'; embeddingProvider: unknown; config: QdrantConfig }
  | { type: 'mock'; embeddingProvider: unknown; config?: Record<string, unknown> }
  | { type: 'pinecone'; embeddingProvider: unknown; config: { apiKey: string; environment: string; indexName: string } }
  | { type: 'weaviate'; embeddingProvider: unknown; config: { url: string; apiKey?: string; className: string } };

/** Settings shared by search requests and query-less search configuration. */
export type SearchSettings = {
  mode?: 'semantic' | 'keyword' | 'hybrid';
  limit?: number;
  offset?: number;
  scoreThreshold?: number;
  highlightTerms?: boolean;
  includeMetadata?: boolean;
};
export type SearchMode = NonNullable<SearchSettings['mode']>;

/** A complete search request, including the query and optional payload filters. */
export type SearchOptions = SearchSettings & { query: string; filters?: Record<string, unknown> };

/** Provider selection and generation settings for a RAG pipeline. */
export type RAGServiceConfig = {
  provider: 'openai' | 'anthropic' | 'cohere' | 'local';
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
};

/** Provider-service settings. Sanitization accepts defaults (`true`) or programmatic rules. */
export type AIServiceConfig = {
  model?: string;
  apiKey?: string;
  temperature?: number;
  maxRetries?: number;
  sanitize?: boolean | SanitizerConfig;
};

/** Per-call generation options. */
export type GenerationOptions = {
  temperature?: number;
  maxTokens?: number;
  maxRetries?: number;
  systemPrompt?: string;
};

/** A document to index. */
export type Document = { id: string; text: string; metadata?: Record<string, unknown> };

/** One chat message. */
export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: Date;
  metadata?: Record<string, unknown>;
};
