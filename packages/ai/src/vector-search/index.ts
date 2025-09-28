/**
 * Vector search providers and utilities
 */

export { QdrantVectorProvider, type QdrantSearchFilter } from './providers/qdrant';
export { MockVectorProvider } from './providers/mock';
export {
  createVectorProvider as createVectorSearchProvider,
  createQdrantProvider,
  createMockProvider,
  type VectorProviderType,
  type VectorProviderConfig,
  type ProviderConfig as VectorSearchConfig
} from './factory';
export type { VectorSearchProvider, VectorSearchResult } from '../types';

// Alias for backward compatibility
export function createVectorSearchProviderFromEnv() {
  throw new Error('createVectorSearchProviderFromEnv is not yet implemented. Use createVectorSearchProvider instead.');
}