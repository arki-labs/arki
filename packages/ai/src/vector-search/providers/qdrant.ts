/**
 * QDrant vector search provider
 * Production-ready implementation with advanced features
 */

import { createHash } from 'node:crypto';
import type { QdrantClient, Schemas as QdrantSchemas } from '@qdrant/js-client-rest';

import type { EmbeddingSpace } from '@arki/embeddings';

import type { VectorScrollPage, VectorSearchProvider, VectorSearchResult } from '../../types';
import { debugVector } from '../../debug.ts';
import { getErrorMessage, VectorSearchError } from '../../errors';

/**
 * Qdrant only accepts point IDs that are an unsigned integer or a UUID. Callers, however, use
 * arbitrary application IDs (e.g. prefixed IDs like `ps_ab12…`). Passing those straight through
 * yields a silent `400 Bad Request` on upsert. We therefore normalize any non-int/non-UUID ID to a
 * deterministic UUIDv5-style value (stable across runs, so re-indexing overwrites rather than
 * duplicates) and stash the original under `SOURCE_ID_KEY` so reads return the caller's ID verbatim.
 */
const SOURCE_ID_KEY = '_sourceId';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toPointId(id: string | number): string | number {
  if (typeof id === 'number') return id;
  if (/^\d+$/.test(id)) return Number(id);
  if (UUID_RE.test(id)) return id;
  // Deterministic UUIDv5-style derivation: SHA-1 the ID, then force the version (5) and RFC-4122
  // variant nibbles into a well-formed UUID string. Qdrant validates the format, not v5 semantics.
  const h = createHash('sha1').update(id).digest('hex'); // 40 hex chars
  const variant = ((Number.parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Read the caller's original ID back from a Qdrant point (falling back to the point ID itself). */
function sourceId(point: { id: string | number; payload?: Record<string, unknown> | null }): string {
  const original = point.payload?.[SOURCE_ID_KEY];
  return typeof original === 'string' ? original : String(point.id);
}

/** Numeric range condition accepted in flat `searchByVector` filters. */
export type RangeCondition = { gt?: number; gte?: number; lt?: number; lte?: number };

const RANGE_KEYS = new Set(['gt', 'gte', 'lt', 'lte']);

/** True when a filter value is a `{gt|gte|lt|lte}` range object (numbers only). */
function isRangeCondition(value: unknown): value is RangeCondition {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([k, v]) => RANGE_KEYS.has(k) && typeof v === 'number');
}

export type QdrantConfig = {
  url: string;
  apiKey?: string;
  collectionName: string;
  createCollectionIfNotExists?: boolean;
  /**
   * Collection replication factor. Requires a Qdrant cluster with at least this
   * many nodes; single-node deployments MUST leave this at 1 (the default) or
   * collection creation degrades. Overridable per-deployment.
   */
  replicationFactor?: number;
  /**
   * Payload fields to create a `keyword` index on when the collection is
   * ensured. Filtering on an unindexed payload field forces a full scan, so any
   * field used in a `searchByVector` / `scroll` filter belongs here
   * (e.g. `['userId', 'kind']`). Idempotent — re-asserted on every startup.
   */
  payloadIndexes?: string[];
};

export type QdrantSearchFilter = {
  must?: {
    key: string;
    match?: string | number | boolean | Record<string, unknown>;
    range?: {
      gt?: number;
      gte?: number;
      lt?: number;
      lte?: number;
    };
  }[];
  should?: {
    key: string;
    match?: string | number | boolean | Record<string, unknown>;
  }[];
  mustNot?: {
    key: string;
    match?: string | number | boolean | Record<string, unknown>;
  }[];
};

export class QdrantVectorProvider<TMetadata = Record<string, unknown>> implements VectorSearchProvider<TMetadata> {
  readonly space: EmbeddingSpace;
  private client: QdrantClient | null = null;
  private collectionName: string;
  private vectorSize: number;
  private createIfNotExists: boolean;
  private replicationFactor: number;
  private payloadIndexes: string[];

  constructor(
    private config: QdrantConfig,
    { space }: { space: EmbeddingSpace },
  ) {
    this.space = space;
    this.collectionName = config.collectionName;
    // The collection size IS the space's size: one source for index-time and query-time vectors.
    this.vectorSize = space.dimensions;
    this.createIfNotExists = config.createCollectionIfNotExists !== false;
    this.replicationFactor = config.replicationFactor ?? 1;
    this.payloadIndexes = config.payloadIndexes ?? [];

    debugVector.debug(
      '[Qdrant] Provider initialized (collection: {collection}, vectorSize: {vectorSize}, autoCreate: {autoCreate}, url: {url})',
      {
        collection: this.collectionName,
        vectorSize: this.vectorSize,
        autoCreate: this.createIfNotExists,
        url: config.url,
      },
    );
  }

  private async getClient(): Promise<QdrantClient> {
    if (!this.client) {
      debugVector.debug('[Qdrant] Initializing Qdrant client (url: {url})', { url: this.config.url });
      // Dynamic import to avoid loading if not needed
      const { QdrantClient } = await import('@qdrant/js-client-rest');

      // The client defaults to port 6333 whenever the URL omits an explicit port — so a proxied
      // `https://host` (Coolify/Traefik, Qdrant Cloud) silently becomes `https://host:6333`, which
      // is firewalled → `fetch failed`. Pass the port explicitly (it overrides the 6333 default),
      // derived from the URL's scheme so both the public-proxy (443) and internal-network (:6333)
      // cases work with a clean, unmangled URL.
      const parsedUrl = new URL(this.config.url);
      const port = parsedUrl.port ? Number(parsedUrl.port) : parsedUrl.protocol === 'https:' ? 443 : 6333;

      this.client = new QdrantClient({
        url: this.config.url,
        apiKey: this.config.apiKey,
        port,
      });

      debugVector.debug('[Qdrant] Client initialized successfully');

      if (this.createIfNotExists) {
        debugVector.debug('[Qdrant] Auto-create enabled, ensuring collection exists');
        await this.ensureCollection();
      }
    }
    return this.client;
  }

  private async ensureCollection(): Promise<void> {
    if (!this.client) return;

    debugVector.debug('[Qdrant] Checking if collection exists: {exists}', { exists: this.collectionName });

    try {
      // Check if collection exists
      const collections = await this.client.getCollections();
      const exists = collections.collections.some(col => col.name === this.collectionName);

      if (exists) {
        debugVector.debug('[Qdrant] Collection already exists: {exists}', { exists: this.collectionName });
        // Fail loud on a dimension mismatch: a collection created for a
        // different embedding model would silently reject every upsert/query.
        await this.assertVectorSize();
      } else {
        debugVector.debug(
          '[Qdrant] Collection does not exist, creating: {creating} (vectorSize: {vectorSize}, replication: {replication})',
          { creating: this.collectionName, vectorSize: this.vectorSize, replication: this.replicationFactor },
        );
        try {
          // Create collection with optimized settings for semantic search
          await this.client.createCollection(this.collectionName, {
            vectors: {
              size: this.vectorSize,
              distance: 'Cosine', // Best for normalized embeddings
            },
            optimizers_config: {
              default_segment_number: 2,
              indexing_threshold: 20_000,
            },
            replication_factor: this.replicationFactor,
            write_consistency_factor: 1,
          });
          debugVector.debug('[Qdrant] Collection created successfully: {successfully}', {
            successfully: this.collectionName,
          });
        } catch (error) {
          // Concurrent cold starts race on create — a lost race ("already
          // exists") is benign; anything else is a real failure.
          if (!/already exists/i.test(getErrorMessage(error))) throw error;
          debugVector.debug('[Qdrant] Create raced with a concurrent start (already exists): {collectionName}', {
            collectionName: this.collectionName,
          });
        }
      }

      // Idempotent on EVERY path — a collection that pre-existed this process
      // (or was created by a racing start) still needs its payload indexes.
      await this.ensurePayloadIndexes();
    } catch (error) {
      debugVector.debug('[Qdrant] Failed to ensure collection: {collection}', { collection: getErrorMessage(error) });
      throw new VectorSearchError(`Failed to ensure QDrant collection: ${getErrorMessage(error)}`, error);
    }
  }

  /** Fail loud when an existing collection's vector size differs from config. */
  private async assertVectorSize(): Promise<void> {
    if (!this.client) return;
    const info = await this.client.getCollection(this.collectionName);
    // Single unnamed vector config: params.vectors.size.
    const vectors = info.config?.params?.vectors as { size?: number } | undefined;
    const existing = typeof vectors?.size === 'number' ? vectors.size : undefined;
    if (existing !== undefined && existing !== this.vectorSize) {
      throw new VectorSearchError(
        `Qdrant collection "${this.collectionName}" has vectorSize ${existing}, but this provider is configured for ${this.vectorSize}. ` +
          `A model/dimension change requires a fresh collection + re-embed — refusing to read/write a mismatched collection.`,
      );
    }
  }

  /** Create keyword payload indexes for every configured field. Idempotent. */
  private async ensurePayloadIndexes(): Promise<void> {
    if (!this.client || this.payloadIndexes.length === 0) return;
    for (const field of this.payloadIndexes) {
      try {
        await this.client.createPayloadIndex(this.collectionName, {
          field_name: field,
          field_schema: 'keyword',
          wait: true,
        });
        debugVector.debug('[Qdrant] Payload index ensured: {ensured}.{field}', { ensured: this.collectionName, field });
      } catch (error) {
        // Re-asserting an existing index is a no-op we tolerate.
        if (!/already exists/i.test(getErrorMessage(error))) throw error;
        debugVector.debug('[Qdrant] Payload index already present: {present}.{field}', {
          present: this.collectionName,
          field,
        });
      }
    }
  }

  async upsertVector(id: string, values: ArrayLike<number>, metadata?: TMetadata): Promise<void> {
    const vector = Array.from(values);
    if (vector.length !== this.vectorSize) {
      throw new VectorSearchError(
        `upsertVector dimension mismatch for "${id}": got ${vector.length}, collection is ${this.vectorSize}.`,
      );
    }
    debugVector.debug('[Qdrant] Upserting precomputed vector (id: {id}, dims: {dims})', { id, dims: vector.length });
    const client = await this.getClient();

    const point: QdrantSchemas['PointStruct'] = {
      id: toPointId(id),
      vector,
      payload: {
        ...metadata,
        [SOURCE_ID_KEY]: id,
        indexedAt: new Date().toISOString(),
      },
    };
    await client.upsert(this.collectionName, { points: [point], wait: true });
    debugVector.debug('[Qdrant] Vector upserted successfully: {successfully}', { successfully: id });
  }

  async searchByVector(
    values: ArrayLike<number>,
    limit = 10,
    filter?: Record<string, unknown>,
  ): Promise<VectorSearchResult<TMetadata>[]> {
    const vector = Array.from(values);
    if (vector.length !== this.vectorSize) {
      throw new VectorSearchError(
        `searchByVector dimension mismatch: got ${vector.length}, collection is ${this.vectorSize}.`,
      );
    }
    debugVector.debug(
      '[Qdrant] Searching by precomputed vector (dims: {dims}, limit: {limit}, hasFilter: {hasFilter})',
      { dims: vector.length, limit, hasFilter: !!filter },
    );
    const client = await this.getClient();

    const qdrantFilter = this.flatFilter(filter);

    const searchResult = (
      await client.query(this.collectionName, {
        query: vector,
        limit,
        filter: qdrantFilter,
        with_payload: true,
        score_threshold: 0, // caller filters by score
      })
    ).points;

    debugVector.debug('[Qdrant] searchByVector completed (results: {results})', { results: searchResult.length });
    return searchResult.map(result => ({
      id: sourceId(result),
      score: result.score,
      metadata: result.payload as TMetadata,
    }));
  }

  async scroll(
    filter: Record<string, unknown>,
    { limit, offset }: { limit: number; offset?: string },
  ): Promise<VectorScrollPage<TMetadata>> {
    debugVector.debug('[Qdrant] Scrolling by filter (limit: {limit}, hasOffset: {hasOffset})', {
      limit,
      hasOffset: offset !== undefined,
    });
    const client = await this.getClient();
    const page = await client.scroll(this.collectionName, {
      filter: this.flatFilter(filter),
      limit,
      ...(offset === undefined ? {} : { offset: toPointId(offset) }),
      with_payload: true,
      with_vector: false,
    });
    const items = page.points.map(point => ({ id: sourceId(point), metadata: point.payload as TMetadata }));
    const next = page.next_page_offset;
    return typeof next === 'string' || typeof next === 'number' ? { items, next: String(next) } : { items };
  }

  async deleteDocument(id: string): Promise<void> {
    debugVector.debug('[Qdrant] Deleting document (id: {id})', { id });
    const client = await this.getClient();

    await client.delete(this.collectionName, {
      points: [toPointId(id)],
      wait: true,
    });
    debugVector.debug('[Qdrant] Document deleted successfully: {successfully}', { successfully: id });
  }

  async deleteDocumentsBatch(ids: string[]): Promise<void> {
    debugVector.debug('[Qdrant] Deleting documents batch (count: {count})', { count: ids.length });
    const client = await this.getClient();

    await client.delete(this.collectionName, {
      points: ids.map(id => toPointId(id)),
      wait: true,
    });
    debugVector.debug('[Qdrant] Batch deletion completed (count: {count})', { count: ids.length });
  }

  async getCollectionStats(): Promise<{
    vectorCount: number;
    indexedSize: number;
    segmentsCount: number;
  }> {
    debugVector.debug('[Qdrant] Getting collection stats: {stats}', { stats: this.collectionName });
    const client = await this.getClient();
    const info = await client.getCollection(this.collectionName);

    const stats = {
      vectorCount: info.points_count ?? 0,
      indexedSize: info.indexed_vectors_count ?? 0,
      segmentsCount: info.segments_count ?? 0,
    };

    debugVector.debug('[Qdrant] Collection stats (vectors: {vectors}, indexed: {indexed}, segments: {segments})', {
      vectors: stats.vectorCount,
      indexed: stats.indexedSize,
      segments: stats.segmentsCount,
    });

    return stats;
  }

  async optimizeCollection(): Promise<void> {
    debugVector.debug('[Qdrant] Optimizing collection: {collection}', { collection: this.collectionName });
    const client = await this.getClient();

    // Trigger optimization to improve search performance
    await client.updateCollection(this.collectionName, {
      optimizers_config: {
        indexing_threshold: 10_000,
        default_segment_number: 2,
      },
    });
    debugVector.debug('[Qdrant] Collection optimization completed: {completed}', { completed: this.collectionName });
  }

  // Note: Field indexing is handled automatically by Qdrant based on usage patterns
  // If needed in the future, this would require using the collection update API
  // to modify the collection's indexing configuration

  /**
   * Flat provider-agnostic filter → Qdrant-native `must` clauses:
   *   scalar          → match: { value }   (equality)
   *   array           → match: { any }     (IN-semantics)
   *   {gt|gte|lt|lte} → range              (numeric range)
   */
  private flatFilter(filter: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!filter || Object.keys(filter).length === 0) return undefined;
    return this.buildQdrantFilter({
      must: Object.entries(filter).map(([key, value]) => {
        if (Array.isArray(value)) {
          return { key, match: { any: value } };
        }
        if (isRangeCondition(value)) {
          return { key, range: value };
        }
        return { key, match: { value } as Record<string, unknown> };
      }),
    });
  }

  private buildQdrantFilter(filter: QdrantSearchFilter): Record<string, unknown> | undefined {
    const conditions: Record<string, unknown> = {};

    // Must conditions (AND)
    if (filter.must && filter.must.length > 0) {
      conditions['must'] = filter.must;
    }

    // Should conditions (OR)
    if (filter.should && filter.should.length > 0) {
      conditions['should'] = filter.should;
    }

    // Must not conditions (NOT)
    if (filter.mustNot && filter.mustNot.length > 0) {
      conditions['must_not'] = filter.mustNot;
    }

    return Object.keys(conditions).length > 0 ? conditions : undefined;
  }

  /**
   * Clear the entire collection (use with caution!)
   */
  async clearCollection(): Promise<void> {
    debugVector.debug('[Qdrant] Clearing entire collection: {collection} (use with caution!)', {
      collection: this.collectionName,
    });
    const client = await this.getClient();

    // Delete and recreate collection
    await client.deleteCollection(this.collectionName);
    debugVector.debug('[Qdrant] Collection deleted: {deleted}', { deleted: this.collectionName });
    await this.ensureCollection();
    debugVector.debug('[Qdrant] Collection cleared and recreated: {recreated}', { recreated: this.collectionName });
  }

  /**
   * Get document by ID
   */
  async getDocument(id: string): Promise<TMetadata | null> {
    debugVector.debug('[Qdrant] Getting document by ID: {ID}', { ID: id });
    const client = await this.getClient();

    try {
      const points = await client.retrieve(this.collectionName, {
        ids: [toPointId(id)],
        with_payload: true,
        with_vector: false,
      });

      const result = (points[0]?.payload as TMetadata) || null;
      debugVector.debug('[Qdrant] Document retrieved: {retrieved} (found: {found})', {
        retrieved: id,
        found: !!result,
      });
      return result;
    } catch (error) {
      debugVector.debug('[Qdrant] Failed to get document: {document} - {value2}', {
        document: id,
        value2: getErrorMessage(error),
      });
      return null;
    }
  }
}
