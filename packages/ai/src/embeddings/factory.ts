/**
 * Factory for creating embedding providers
 */

import type { EmbeddingProvider } from '../types';
import { debugEmbeddings } from '../debug.ts';
import { env } from '../env';
import { ConfigurationError } from '../errors';
import { MockEmbeddingProvider, type MockEmbeddingConfig } from './providers/mock';
import { OpenAIEmbeddingProvider, type OpenAIEmbeddingConfig } from './providers/openai';

export type EmbeddingProviderType = 'openai' | 'mock' | 'cohere' | 'huggingface';

export interface EmbeddingProviderConfig {
  type: EmbeddingProviderType;
  openai?: OpenAIEmbeddingConfig;
  mock?: MockEmbeddingConfig;
  // Future providers
  cohere?: Record<string, unknown>;
  huggingface?: Record<string, unknown>;
}

/**
 * Create an embedding provider based on configuration
 */
export function createEmbeddingProvider(
  config: EmbeddingProviderConfig
): EmbeddingProvider {
  debugEmbeddings('[Factory] Creating embedding provider (type: %s)', config.type);

  switch (config.type) {
    case 'openai':
      debugEmbeddings('[Factory] Initializing OpenAI embedding provider');
      return new OpenAIEmbeddingProvider(config.openai);

    case 'mock':
      debugEmbeddings('[Factory] Initializing Mock embedding provider');
      return new MockEmbeddingProvider(config.mock);

    case 'cohere':
      debugEmbeddings('[Factory] Cohere provider requested but not implemented');
      throw new ConfigurationError('Cohere provider not yet implemented');

    case 'huggingface':
      debugEmbeddings('[Factory] HuggingFace provider requested but not implemented');
      throw new ConfigurationError('HuggingFace provider not yet implemented');

    default:
      debugEmbeddings('[Factory] Unknown provider type: %s', config.type);
      throw new ConfigurationError(`Unknown embedding provider type: ${config.type}`);
  }
}

/**
 * Create embedding provider from environment variables
 */
export function createEmbeddingProviderFromEnv(): EmbeddingProvider {
  const providerType = env.EMBEDDING_PROVIDER;

  debugEmbeddings('[Factory] Creating embedding provider from environment (type: %s)', providerType);

  switch (providerType) {
    case 'openai':
      debugEmbeddings('[Factory] Initializing OpenAI provider from environment (model: %s)', env.OPENAI_EMBEDDING_MODEL);
      return new OpenAIEmbeddingProvider({
        apiKey: env.OPENAI_API_KEY,
        model: env.OPENAI_EMBEDDING_MODEL,
      });

    case 'mock':
      debugEmbeddings('[Factory] Initializing Mock provider from environment');
      return new MockEmbeddingProvider();

    default:
      debugEmbeddings('[Factory] Unknown provider type from environment: %s', providerType);
      // For production code, throw error instead of silently falling back
      throw new ConfigurationError(
        `Unknown embedding provider: ${providerType}. Supported providers: openai, mock`
      );
  }
}