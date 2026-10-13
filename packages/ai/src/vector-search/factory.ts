/**
 * Factory for creating Vector Search Providers
 */

import type { EmbeddingProvider, VectorSearchProvider } from '../types';
import type { QdrantConfig } from '../validation';
import { debugVector } from '../debug.ts';
import { MockVectorProvider } from './providers/mock';
import { QdrantVectorProvider } from './providers/qdrant';

export type VectorProviderType = 'mock' | 'qdrant';

export type VectorProviderConfig = {
  type: VectorProviderType;
  embeddingProvider: EmbeddingProvider;
  config?: unknown; // Provider-specific config
};

export type QdrantProviderConfig = {
  type: 'qdrant';
  config: QdrantConfig;
} & VectorProviderConfig;

export type MockProviderConfig = {
  type: 'mock';
  config?: never;
} & VectorProviderConfig;

export type ProviderConfig = QdrantProviderConfig | MockProviderConfig;

/**
 * Factory function to create vector search providers
 */
export function createVectorProvider<TMetadata = Record<string, unknown>>(
  config: ProviderConfig,
): VectorSearchProvider<TMetadata> {
  debugVector.debug('[Factory] Creating vector search provider (type: {type})', { type: config.type });

  switch (config.type) {
    case 'qdrant': {
      if (!config.config) {
        debugVector.debug('[Factory] Qdrant provider requires configuration');
        throw new Error('Qdrant provider requires configuration');
      }
      debugVector.debug('[Factory] Initializing Qdrant provider');
      return new QdrantVectorProvider<TMetadata>(config.config, config.embeddingProvider);
    }

    case 'mock': {
      debugVector.debug('[Factory] Initializing Mock provider');
      return new MockVectorProvider<TMetadata>(config.embeddingProvider);
    }

    default: {
      // Type-safe exhaustive check
      const _exhaustive: never = config;
      void _exhaustive; // Mark as used
      debugVector.debug('[Factory] Unknown provider type');
      throw new Error(`Unknown provider type`);
    }
  }
}

/**
 * Helper function to create a Qdrant provider
 */
export function createQdrantProvider<TMetadata = Record<string, unknown>>(
  config: QdrantConfig,
  embeddingProvider: EmbeddingProvider,
): QdrantVectorProvider<TMetadata> {
  debugVector.debug('[Factory] Creating Qdrant provider via helper function');
  return new QdrantVectorProvider<TMetadata>(config, embeddingProvider);
}

/**
 * Helper function to create a Mock provider for testing
 */
export function createMockProvider<TMetadata = Record<string, unknown>>(
  embeddingProvider: EmbeddingProvider,
): MockVectorProvider<TMetadata> {
  debugVector.debug('[Factory] Creating Mock provider via helper function');
  return new MockVectorProvider<TMetadata>(embeddingProvider);
}
