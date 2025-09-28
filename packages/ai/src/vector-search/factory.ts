/**
 * Factory for creating Vector Search Providers
 */

import type { EmbeddingProvider, VectorSearchProvider } from '../types';
import { MockVectorProvider } from './providers/mock';
import { QdrantConfig, QdrantVectorProvider } from './providers/qdrant';

export type VectorProviderType = 'mock' | 'qdrant' | 'pinecone' | 'weaviate';

export interface VectorProviderConfig {
  type: VectorProviderType;
  embeddingProvider: EmbeddingProvider;
  config?: any; // Provider-specific config
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
export function createVectorProvider<TMetadata = any>(
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

    case 'pinecone':
      throw new Error('Pinecone provider not yet implemented');

    case 'weaviate':
      throw new Error('Weaviate provider not yet implemented');

    default:
      // Type-safe exhaustive check
      const _exhaustive: never = config.type;
      throw new Error(`Unknown provider type: ${_exhaustive}`);
  }
}

/**
 * Helper function to create a Qdrant provider
 */
export function createQdrantProvider<TMetadata = any>(
  config: QdrantConfig,
  embeddingProvider: EmbeddingProvider
): QdrantVectorProvider<TMetadata> {
  return new QdrantVectorProvider<TMetadata>(config, embeddingProvider);
}

/**
 * Helper function to create a Mock provider for testing
 */
export function createMockProvider<TMetadata = any>(
  embeddingProvider: EmbeddingProvider
): MockVectorProvider<TMetadata> {
  return new MockVectorProvider<TMetadata>(embeddingProvider);
}