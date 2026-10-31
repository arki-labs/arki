/**
 * The runtime schemas behind the `./validation` types. Internal: the package parses with them, and
 * `@arki/ai/zod` offers them to callers. Each one is locked to its TS type in `zod.test.ts`.
 */
import { z } from '@arki/contracts';

import { sanitizerConfigSchema } from './safety/schemas.js';

/**
 * QDrant configuration validation
 */
export const qdrantConfigSchema = z.object({
  url: z.url(),
  apiKey: z.string().optional(),
  collectionName: z.string().min(1),
  vectorSize: z.number().optional(),
  createCollectionIfNotExists: z.boolean().optional(),
});

/**
 * Vector search provider configuration validation
 */
export const vectorProviderConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('qdrant'),
    embeddingProvider: z.unknown(), // Will be validated at runtime
    config: z.object({
      url: z.url(),
      apiKey: z.string().optional(),
      collectionName: z.string().min(1),
      vectorSize: z.number().optional(),
      createCollectionIfNotExists: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal('mock'),
    embeddingProvider: z.unknown(), // Will be validated at runtime
    config: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal('pinecone'),
    embeddingProvider: z.unknown(),
    config: z.object({
      apiKey: z.string(),
      environment: z.string(),
      indexName: z.string(),
    }),
  }),
  z.object({
    type: z.literal('weaviate'),
    embeddingProvider: z.unknown(),
    config: z.object({
      url: z.url(),
      apiKey: z.string().optional(),
      className: z.string(),
    }),
  }),
]);

/**
 * Settings shared by search requests and query-less search configuration.
 */
export const searchSettingsSchema = z.object({
  mode: z.enum(['semantic', 'keyword', 'hybrid']).optional(),
  limit: z.number().min(1).max(1000).optional(),
  offset: z.number().min(0).optional(),
  scoreThreshold: z.number().min(0).max(1).optional(),
  highlightTerms: z.boolean().optional(),
  includeMetadata: z.boolean().optional(),
});

/** A complete search request, including the query and optional payload filters. */
export const searchOptionsSchema = searchSettingsSchema.extend({
  query: z.string().min(1),
  filters: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Provider selection and generation settings for a RAG pipeline.
 */
export const ragServiceConfigSchema = z.object({
  provider: z.enum(['openai', 'anthropic', 'cohere', 'local']),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  model: z.string().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
});

/**
 * Provider-service settings. Sanitization accepts defaults or programmatic rules.
 */
export const aiServiceConfigSchema = z.object({
  model: z.string().optional(),
  apiKey: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxRetries: z.number().min(0).max(10).optional(),
  sanitize: z.union([z.boolean(), sanitizerConfigSchema]).optional(),
});

/**
 * Generation options validation
 */
export const generationOptionsSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().min(1).max(32_000).optional(),
  maxRetries: z.number().min(0).max(10).optional(),
  systemPrompt: z.string().optional(),
});

/**
 * Document indexing validation
 */
export const documentSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const documentsSchema = z.array(documentSchema);

/**
 * Chat message validation
 */
export const chatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  timestamp: z.date().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
