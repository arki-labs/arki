/**
 * `createVectorIndex` — the one place an app's vector store is constructed,
 * so the collection name, payload shape and vector size have one source of
 * truth. Qdrant when `QDRANT_URL` is set (and `VECTOR_BACKEND` is not `mock`),
 * the in-memory mock otherwise (dev / e2e). The vector size is the embedding
 * runtime's selection, so index-time and query-time vectors share one space.
 *
 * `durable` says whether a point written here outlives the process — the
 * reconciler acknowledges erasure tombstones only against a durable index.
 */
import type { EmbeddingRuntime, EnvSource } from '../embeddings/runtime';
import type { VectorSearchProvider } from '../types';
import { debugVector } from '../debug.ts';
import { MockVectorProvider } from './providers/mock';
import { QdrantVectorProvider } from './providers/qdrant';

export type VectorIndexOptions<P extends Record<string, unknown>> = {
  /** Collection (Qdrant) holding every point of this app. */
  collection: string;
  /** Payload fields filtered on; each gets a keyword index. Keys of `P`, by construction. */
  payloadIndexes: readonly (keyof P & string)[];
  /** Reads `QDRANT_URL`, `QDRANT_API_KEY`, `QDRANT_REPLICATION_FACTOR`, `VECTOR_BACKEND`. */
  env: EnvSource;
};

export type VectorIndex<P extends Record<string, unknown>> = {
  provider: VectorSearchProvider<P>;
  /** `true` for Qdrant; `false` for the in-memory mock. */
  durable: boolean;
};

/** Build the app's vector index over an embedding runtime. */
export function createVectorIndex<P extends Record<string, unknown>>(
  runtime: EmbeddingRuntime,
  { collection, payloadIndexes, env }: VectorIndexOptions<P>,
): VectorIndex<P> {
  const qdrantUrl = env['QDRANT_URL'];
  if (!qdrantUrl || env['VECTOR_BACKEND'] === 'mock') {
    debugVector.debug('[Index] in-memory mock index for collection {collection} (not durable)', { collection });
    return { provider: new MockVectorProvider<P>(runtime.provider), durable: false };
  }

  const apiKey = env['QDRANT_API_KEY'];
  const replication = env['QDRANT_REPLICATION_FACTOR'];
  debugVector.debug('[Index] Qdrant index for collection {collection} at {url} (dims: {dimensions})', {
    collection,
    url: qdrantUrl,
    dimensions: runtime.selection.dimensions,
  });
  return {
    provider: new QdrantVectorProvider<P>(
      {
        url: qdrantUrl,
        ...(apiKey ? { apiKey } : {}),
        collectionName: collection,
        // MUST equal the embedding model's dimension — the runtime selection is the single source of that number.
        vectorSize: runtime.selection.dimensions,
        // Single node by default; override for a cluster.
        replicationFactor: replication ? Number(replication) : 1,
        payloadIndexes: [...payloadIndexes],
        createCollectionIfNotExists: true,
      },
      runtime.provider,
    ),
    durable: true,
  };
}
