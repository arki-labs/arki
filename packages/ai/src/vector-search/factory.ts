/**
 * Factory for creating Vector Search Providers
 */

import type { EmbeddingProvider, VectorSearchProvider } from '../types';
import { MockVectorProvider } from './providers/mock';
import type { QdrantConfig } from '../validation';
import { QdrantVectorProvider } from './providers/qdrant';

export type VectorProviderType = 'mock' | 'qdrant';

export interface VectorProviderConfig {
  type: VectorProviderType;
  embeddingProvider: EmbeddingProvider;
  config?: unknown; // Provider-specific config
}

export interface QdrantProviderConfig extends VectorProviderConfig {
  type: 'qdrant';
  config: QdrantConfig;
}

export interface MockProviderConfig extends VectorProviderConfig {
  type: 'mock';
  config?: never;
}

export type ProviderConfig = QdrantProviderConfig | MockProviderConfig;

/**
 * Factory function to create vector search providers
 */
export function createVectorProvider<TMetadata = Record<string, unknown>>(
  config: ProviderConfig
): VectorSearchProvider<TMetadata> {
  switch (config.type) {
    case 'qdrant':
      if (!config.config) {
        throw new Error('Qdrant provider requires configuration');
      }
      return new QdrantVectorProvider<TMetadata>(
        config.config,
        config.embeddingProvider
      );

    case 'mock':
      return new MockVectorProvider<TMetadata>(config.embeddingProvider);

    default: {
      // Type-safe exhaustive check
      const _exhaustive: never = config;
      void _exhaustive; // Mark as used
      throw new Error(`Unknown provider type`);
    }
  }
}

/**
 * Helper function to create a Qdrant provider
 */
export function createQdrantProvider<TMetadata = Record<string, unknown>>(
  config: QdrantConfig,
  embeddingProvider: EmbeddingProvider
): QdrantVectorProvider<TMetadata> {
  return new QdrantVectorProvider<TMetadata>(config, embeddingProvider);
}

/**
 * Helper function to create a Mock provider for testing
 */
export function createMockProvider<TMetadata = Record<string, unknown>>(
  embeddingProvider: EmbeddingProvider
): MockVectorProvider<TMetadata> {
  return new MockVectorProvider<TMetadata>(embeddingProvider);
}