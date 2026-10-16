/**
 * Input validation schemas for @arki/ai
 */

import { z } from '@arki/contracts';
import { SchemaError, pathOf, parse, parseAsync } from '@arki/schema';
import type { SchemaOutput, StandardSchemaV1 } from '@arki/schema';
import { ValidationError } from './errors';

/**
 * OpenAI Embedding configuration validation
 */
export const openaiEmbeddingConfigSchema = z.object({
  apiKey: z.string().optional(),
  model: z.string().optional(),
  baseUrl: z.string().optional(),
  dimensions: z.number().optional(),
  batchSize: z.number().positive().optional(),
  cacheEnabled: z.boolean().optional(),
});

export type OpenAIEmbeddingConfig = z.infer<typeof openaiEmbeddingConfigSchema>;

/**
 * Mock Embedding configuration validation
 */
export const mockEmbeddingConfigSchema = z.object({
  dimensions: z.number().positive().optional(),
  simulateErrors: z.boolean().optional(),
  errorRate: z.number().min(0).max(1).optional(),
});

export type MockEmbeddingConfig = z.infer<typeof mockEmbeddingConfigSchema>;

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

export type QdrantConfig = z.infer<typeof qdrantConfigSchema>;

/**
 * Embedding provider configuration validation
 */
export const embeddingConfigSchema = z.object({
  type: z.enum(['openai', 'mock', 'cohere', 'anthropic']),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  batchSize: z.number().min(1).max(1000).optional(),
  maxRetries: z.number().min(0).max(10).optional(),
  cache: z.boolean().optional(),
});

export type EmbeddingConfig = z.infer<typeof embeddingConfigSchema>;

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

export type VectorProviderConfig = z.infer<typeof vectorProviderConfigSchema>;

/**
 * Search options validation
 */
export const searchOptionsSchema = z.object({
  query: z.string().min(1),
  mode: z.enum(['semantic', 'keyword', 'hybrid']).optional(),
  limit: z.number().min(1).max(1000).optional(),
  offset: z.number().min(0).optional(),
  scoreThreshold: z.number().min(0).max(1).optional(),
  filters: z.record(z.string(), z.unknown()).optional(),
  highlightTerms: z.boolean().optional(),
  includeMetadata: z.boolean().optional(),
});

export type SearchOptions = z.infer<typeof searchOptionsSchema>;

/**
 * AI service configuration validation
 */
/**
 * Sanitization configuration for the AI service.
 * When `true`, uses default sanitizer settings.
 * When an object, configures specific sanitization options.
 */
export const sanitizerConfigSchema = z.object({
  maxInputLength: z.number().min(1).optional(),
  detectPromptInjection: z.boolean().optional(),
  redactPII: z.boolean().optional(),
  stripDangerousCharacters: z.boolean().optional(),
  normalizeWhitespace: z.boolean().optional(),
});

export const aiServiceConfigSchema = z.object({
  model: z.string().optional(),
  apiKey: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxRetries: z.number().min(0).max(10).optional(),
  sanitize: z.union([z.boolean(), sanitizerConfigSchema]).optional(),
});

export type AIServiceConfig = z.infer<typeof aiServiceConfigSchema>;

/**
 * Generation options validation
 */
export const generationOptionsSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().min(1).max(32_000).optional(),
  maxRetries: z.number().min(0).max(10).optional(),
  systemPrompt: z.string().optional(),
});

export type GenerationOptions = z.infer<typeof generationOptionsSchema>;

/**
 * Document indexing validation
 */
export const documentSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type Document = z.infer<typeof documentSchema>;

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

export type ChatMessage = z.infer<typeof chatMessageSchema>;

/**
 * Validate input with detailed error messages.
 * Takes any Standard Schema (zod, valibot, arktype, ...). A schema that
 * cannot run synchronously throws `SchemaRunError`; that is a bug, not bad input.
 */
export function validateInput<S extends StandardSchemaV1>(
  schema: S,
  input: unknown,
  errorMessage?: string
): SchemaOutput<S> {
  try {
    return parse(schema, input);
  } catch (error) {
    throw toValidationError(error, errorMessage);
  }
}

/**
 * Async validation wrapper
 */
export async function validateInputAsync<S extends StandardSchemaV1>(
  schema: S,
  input: unknown,
  errorMessage?: string
): Promise<SchemaOutput<S>> {
  try {
    return await parseAsync(schema, input);
  } catch (error) {
    throw toValidationError(error, errorMessage);
  }
}

/** Turns invalid-input errors into `ValidationError`; anything else is rethrown as is. */
function toValidationError(error: unknown, errorMessage?: string): unknown {
  if (!(error instanceof SchemaError)) return error;
  return new ValidationError(
    errorMessage || `Input validation failed: ${error.message}`,
    error.issues.map(issue => ({ field: pathOf(issue).map(String).join('.'), message: issue.message }))
  );
}
