/**
 * Factory for creating embedding providers
 */

import type { EmbeddingProvider } from '../types';
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
  switch (config.type) {
    case 'openai':
      return new OpenAIEmbeddingProvider(config.openai);

    case 'mock':
      return new MockEmbeddingProvider(config.mock);

    case 'cohere':
      throw new ConfigurationError('Cohere provider not yet implemented');

    case 'huggingface':
      throw new ConfigurationError('HuggingFace provider not yet implemented');

    default:
      throw new ConfigurationError(`Unknown embedding provider type: ${config.type}`);
  }
}

/**
 * Create embedding provider from environment variables
 */
export function createEmbeddingProviderFromEnv(): EmbeddingProvider {
  const providerType = env.EMBEDDING_PROVIDER;

  switch (providerType) {
    case 'openai':
      return new OpenAIEmbeddingProvider({
        apiKey: env.OPENAI_API_KEY,
        model: env.OPENAI_EMBEDDING_MODEL,
      });

    case 'mock':
      return new MockEmbeddingProvider();

    default:
      // For production code, throw error instead of silently falling back
      throw new ConfigurationError(
        `Unknown embedding provider: ${providerType}. Supported providers: openai, mock`
      );
  }
}