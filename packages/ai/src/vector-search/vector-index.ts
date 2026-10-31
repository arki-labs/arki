/**
 * `createVectorIndex` — the one place an app's vector store is constructed,
 * so the collection name, payload shape and vector size have one source of
 * truth. Qdrant when `QDRANT_URL` is set (and `VECTOR_BACKEND` is not `mock`),
 * the in-memory mock otherwise (dev / e2e). The vector size is the embedding
 * space's, so index-time and query-time vectors share one space.
 *
 * `durable` says whether a point written here outlives the process — the
 * reconciler acknowledges erasure tombstones only against a durable index.
 */
import type { EmbeddingSpace } from '@arki/embeddings';
import { z } from '@arki/contracts';
import { InvalidEnvironment } from '@arki/env/core';
import { InvalidInput, orThrow } from '@arki/failure';
import { formatIssues, parse } from '@arki/schema';

import type { VectorSearchProvider } from '../types.js';
import { debugVector } from '../debug.js';
import { MockVectorProvider } from './providers/mock.js';
import { QdrantVectorProvider } from './providers/qdrant.js';

export type VectorIndexOptions<P extends Record<string, unknown>> = {
  /** Collection (Qdrant) holding every point of this app. */
  collection: string;
  /** Payload fields filtered on; each gets a keyword index. Keys of `P`, by construction. */
  payloadIndexes: readonly (keyof P & string)[];
  /** Reads `QDRANT_URL`, `QDRANT_API_KEY`, `QDRANT_REPLICATION_FACTOR`, `VECTOR_BACKEND`. */
  env: NodeJS.ProcessEnv;
};

export type VectorIndex<P extends Record<string, unknown>> = {
  provider: VectorSearchProvider<P>;
  /** `true` for Qdrant; `false` for the in-memory mock. */
  durable: boolean;
};

/** The Qdrant settings read from the environment, checked once at boot. An empty value counts as unset. */
const qdrantEnvSchema = z.object({
  QDRANT_URL: z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' }),
  QDRANT_API_KEY: z.string().optional(),
  QDRANT_REPLICATION_FACTOR: z
    .string()
    .regex(/^[1-9]\d*$/, 'must be a whole number of 1 or more')
    .transform(Number)
    .optional(),
});

/**
 * Build the app's vector index for one embedding space. Returns `InvalidEnvironment` (from
 * `@arki/env/core`) when `QDRANT_URL` is not an http(s) URL or `QDRANT_REPLICATION_FACTOR` is not a
 * whole number of 1 or more, so a bad value fails the boot instead of the first collection call.
 */
export function createVectorIndex<P extends Record<string, unknown>>(
  space: EmbeddingSpace,
  { collection, payloadIndexes, env }: VectorIndexOptions<P>,
): VectorIndex<P> | ReturnType<typeof InvalidEnvironment> {
  const qdrantUrl = env['QDRANT_URL'];
  if (!qdrantUrl || env['VECTOR_BACKEND'] === 'mock') {
    debugVector.debug('[Index] in-memory mock index for collection {collection} (not durable)', { collection });
    return { provider: new MockVectorProvider<P>({ space }), durable: false };
  }

  const parsed = parse(qdrantEnvSchema, {
    QDRANT_URL: qdrantUrl,
    QDRANT_API_KEY: env['QDRANT_API_KEY'] || undefined,
    QDRANT_REPLICATION_FACTOR: env['QDRANT_REPLICATION_FACTOR'] || undefined,
  });
  if (InvalidInput.is(parsed)) return InvalidEnvironment({ report: formatIssues(parsed.data.issues) }, { cause: parsed });
  const qdrantEnv = orThrow(parsed);
  const apiKey = qdrantEnv.QDRANT_API_KEY;
  debugVector.debug('[Index] Qdrant index for collection {collection} at {url} (dims: {dimensions})', {
    collection,
    url: qdrantUrl,
    dimensions: space.dimensions,
  });
  return {
    provider: new QdrantVectorProvider<P>(
      {
        url: qdrantUrl,
        ...(apiKey ? { apiKey } : {}),
        collectionName: collection,
        // Single node by default; override for a cluster.
        replicationFactor: qdrantEnv.QDRANT_REPLICATION_FACTOR ?? 1,
        payloadIndexes: [...payloadIndexes],
        createCollectionIfNotExists: true,
      },
      { space },
    ),
    durable: true,
  };
}
