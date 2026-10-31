/**
 * Vector search providers and utilities
 */

export { QdrantVectorProvider, type QdrantSearchFilter } from './providers/qdrant.js';
export { MockVectorProvider } from './providers/mock.js';
export {
  createVectorProvider as createVectorSearchProvider,
  createQdrantProvider,
  createMockProvider,
  type VectorProviderType,
  type VectorProviderConfig,
  type ProviderConfig as VectorSearchConfig
} from './factory.js';
export type { VectorScrollPage, VectorSearchProvider, VectorSearchResult } from '../types.js';

// The app's one vector index (Qdrant or mock) for one embedding space
export { createVectorIndex, type VectorIndex, type VectorIndexOptions } from './vector-index.js';

// Postgres → index reconciler (tombstone drain + dimension migration + re-upsert)
export {
  ROW_CAP_PER_RUN,
  runVectorReconciliation,
  TOMBSTONE_CAP_PER_RUN,
  type MismatchedRow,
  type OrUnavailable,
  type ReconcileCaps,
  type ReconcileCounts,
  type ReconcileDeps,
  type ReconcileRow,
  type ReconcileStore,
  type TombstoneStore,
  type VectorPointPayload,
} from './reconcile.js';
