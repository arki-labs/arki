/**
 * QDrant vector search provider
 * Production-ready implementation with advanced features
 */

import type { QdrantClient, Schemas as QdrantSchemas } from '@qdrant/js-client-rest';

import type { EmbeddingSpace } from '@arki/embeddings';
import type { SparseSpace, SparseVector } from '@arki/embeddings/sparse';

import type { VectorScrollPage, VectorSearchProvider, VectorSearchResult } from '../../types.js';
import { debugVector } from '../../debug.js';
import { getErrorMessage, VectorSearchError } from '../../errors.js';
import { VectorStoreUnavailable } from '../../failures.js';
import { observeAi } from '../../observe.js';

/**
 * Qdrant only accepts point IDs that are an unsigned integer or a UUID. Callers, however, use
 * arbitrary application IDs (e.g. prefixed IDs like `ps_ab12…`). Passing those straight through
 * yields a silent `400 Bad Request` on upsert. We therefore normalize any non-int/non-UUID ID to a
 * deterministic UUIDv5-style value (stable across runs, so re-indexing overwrites rather than
 * duplicates) and stash the original under `SOURCE_ID_KEY` so reads return the caller's ID verbatim.
 */
const SOURCE_ID_KEY = '_sourceId';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The named sparse vector a point carries next to its dense one. The dense vector stays the
 * collection's unnamed default (`''`), so collections without sparse vectors are unchanged.
 */
const SPARSE_VECTOR_NAME = 'sparse';

async function toPointId(id: string | number): Promise<string | number> {
  if (typeof id === 'number') return id;
  if (/^\d+$/.test(id)) return Number(id);
  if (UUID_RE.test(id)) return id;
  // Deterministic UUIDv5-style derivation: SHA-1 the ID, then force the version (5) and RFC-4122
  // variant nibbles into a well-formed UUID string. Qdrant validates the format, not v5 semantics.
  // WebCrypto (global on Node, Bun, Deno and browsers) keeps the root entry free of `node:crypto`;
  // it hashes the same UTF-8 bytes, so stored point ids do not change.
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(id));
  const h = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''); // 40 hex chars
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
  readonly sparseSpace?: SparseSpace;
  private client: QdrantClient | null = null;
  private collectionName: string;
  private vectorSize: number;
  private createIfNotExists: boolean;
  private replicationFactor: number;
  private payloadIndexes: string[];

  constructor(
    private config: QdrantConfig,
    { space, sparseSpace }: { space: EmbeddingSpace; sparseSpace?: SparseSpace },
  ) {
    // A bad URL is a configuration fault: fail when the provider is built, not on the first query.
    if (!URL.canParse(config.url)) throw new VectorSearchError(`Qdrant url is not a valid URL: "${config.url}"`);
    this.space = space;
    if (sparseSpace !== undefined) this.sparseSpace = sparseSpace;
    this.collectionName = config.collectionName;
    // The collection size IS the space's size: one source for index-time and query-time vectors.
    this.vectorSize = space.dimensions;
    this.createIfNotExists = config.createCollectionIfNotExists !== false;
    this.replicationFactor = config.replicationFactor ?? 1;
    this.payloadIndexes = config.payloadIndexes ?? [];

    debugVector.debug(
      '[Qdrant] Provider initialized (collection: {collection}, vectorSize: {vectorSize}, sparse: {sparse}, autoCreate: {autoCreate}, url: {url})',
      {
        collection: this.collectionName,
        vectorSize: this.vectorSize,
        sparse: sparseSpace?.vocabulary ?? 'none',
        autoCreate: this.createIfNotExists,
        url: config.url,
      },
    );
  }

  /**
   * One Qdrant call inside an `ai.vector.<operation>` span. A client error is a store problem, so a
   * throw marks the span with `ai.vector_store_unavailable`; the error itself is thrown on unchanged.
   */
  private observe<T>(operation: string, call: () => Promise<T>): Promise<T> {
    return observeAi(`ai.vector.${operation}`, call, {
      attributes: { 'ai.vector.collection': this.collectionName },
      thrownCode: VectorStoreUnavailable.code,
    });
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
            ...(this.sparseSpace === undefined ? {} : { sparse_vectors: { [SPARSE_VECTOR_NAME]: {} } }),
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
    if (this.sparseSpace !== undefined && info.config.params.sparse_vectors?.[SPARSE_VECTOR_NAME] === undefined) {
      throw new VectorSearchError(
        `Qdrant collection "${this.collectionName}" has no sparse vector "${SPARSE_VECTOR_NAME}", but this provider is configured for one. ` +
          `Adding sparse vectors requires a fresh collection + re-embed — refusing to read/write a mismatched collection.`,
      );
    }
  }

  /** A sparse vector as Qdrant takes it, refused when it cannot belong to this store's sparse space. */
  private sparseOf(sparse: SparseVector, where: string): QdrantSchemas['SparseVector'] {
    if (this.sparseSpace === undefined) {
      throw new VectorSearchError(`${where}: this provider has no sparseSpace; pass one to store sparse vectors.`);
    }
    if (sparse.indices.length !== sparse.values.length) {
      throw new VectorSearchError(
        `${where}: sparse vector has ${sparse.indices.length} indices but ${sparse.values.length} values.`,
      );
    }
    const vocabularySize = this.sparseSpace.dimensions;
    if (sparse.indices.some(index => index >= vocabularySize)) {
      throw new VectorSearchError(`${where}: sparse index outside the vocabulary of ${vocabularySize}.`);
    }
    return { indices: [...sparse.indices], values: [...sparse.values] };
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

  async upsertVector(
    id: string,
    values: ArrayLike<number>,
    metadata?: TMetadata,
    sparse?: SparseVector,
  ): Promise<void> {
    // eslint-disable-next-line unicorn/prefer-spread -- an ArrayLike (a typed array or array-like) has no iterator in its type
    const vector = Array.from(values);
    if (vector.length !== this.vectorSize) {
      throw new VectorSearchError(
        `upsertVector dimension mismatch for "${id}": got ${vector.length}, collection is ${this.vectorSize}.`,
      );
    }
    // Qdrant replaces the whole point: a dense-only upsert here would erase its stored sparse vector.
    if (this.sparseSpace !== undefined && sparse === undefined) {
      throw new VectorSearchError(`upsertVector "${id}": this store holds a sparse vector per point; pass one.`);
    }
    const sparseVector = sparse === undefined ? undefined : this.sparseOf(sparse, `upsertVector "${id}"`);
    debugVector.debug('[Qdrant] Upserting precomputed vector (id: {id}, dims: {dims}, sparseTerms: {sparseTerms})', {
      id,
      dims: vector.length,
      sparseTerms: sparseVector?.indices.length ?? 0,
    });
    const client = await this.getClient();

    const point: QdrantSchemas['PointStruct'] = {
      id: await toPointId(id),
      // With a sparse vector the dense one goes under the default name `''`.
      vector: sparseVector === undefined ? vector : { '': vector, [SPARSE_VECTOR_NAME]: sparseVector },
      payload: {
        ...metadata,
        [SOURCE_ID_KEY]: id,
        indexedAt: new Date().toISOString(),
      },
    };
    await this.observe('upsert', () => client.upsert(this.collectionName, { points: [point], wait: true }));
    debugVector.debug('[Qdrant] Vector upserted successfully: {successfully}', { successfully: id });
  }

  async searchByVector(
    values: ArrayLike<number>,
    limit = 10,
    filter?: Record<string, unknown>,
  ): Promise<VectorSearchResult<TMetadata>[]> {
    // eslint-disable-next-line unicorn/prefer-spread -- an ArrayLike (a typed array or array-like) has no iterator in its type
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

    const { points: searchResult } = await this.observe('search', () =>
      client.query(this.collectionName, {
        query: vector,
        limit,
        filter: qdrantFilter,
        with_payload: true,
        score_threshold: 0, // caller filters by score
      }),
    );

    debugVector.debug('[Qdrant] searchByVector completed (results: {results})', { results: searchResult.length });
    return this.toResults(searchResult);
  }

  async searchBySparseVector(
    sparse: SparseVector,
    limit = 10,
    filter?: Record<string, unknown>,
  ): Promise<VectorSearchResult<TMetadata>[]> {
    const query = this.sparseOf(sparse, 'searchBySparseVector');
    debugVector.debug('[Qdrant] Searching by sparse vector (terms: {terms}, limit: {limit}, hasFilter: {hasFilter})', {
      terms: query.indices.length,
      limit,
      hasFilter: !!filter,
    });
    const client = await this.getClient();
    const { points } = await this.observe('search_sparse', () =>
      client.query(this.collectionName, {
        query,
        using: SPARSE_VECTOR_NAME,
        limit,
        filter: this.flatFilter(filter),
        with_payload: true,
      }),
    );
    debugVector.debug('[Qdrant] searchBySparseVector completed (results: {results})', { results: points.length });
    return this.toResults(points);
  }

  /** Scored points as results, each with the caller's original ID. */
  private toResults(points: QdrantSchemas['ScoredPoint'][]): VectorSearchResult<TMetadata>[] {
    return points.map(result => ({
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
    const pointOffset = offset === undefined ? {} : { offset: await toPointId(offset) };
    const page = await this.observe('scroll', () =>
      client.scroll(this.collectionName, {
        filter: this.flatFilter(filter),
        limit,
        ...pointOffset,
        with_payload: true,
        with_vector: false,
      }),
    );
    const items = page.points.map(point => ({ id: sourceId(point), metadata: point.payload as TMetadata }));
    const next = page.next_page_offset;
    return typeof next === 'string' || typeof next === 'number' ? { items, next: String(next) } : { items };
  }

  async deleteDocument(id: string): Promise<void> {
    debugVector.debug('[Qdrant] Deleting document (id: {id})', { id });
    const client = await this.getClient();

    const point = await toPointId(id);
    await this.observe('delete', () => client.delete(this.collectionName, { points: [point], wait: true }));
    debugVector.debug('[Qdrant] Document deleted successfully: {successfully}', { successfully: id });
  }

  async deleteDocumentsBatch(ids: string[]): Promise<void> {
    debugVector.debug('[Qdrant] Deleting documents batch (count: {count})', { count: ids.length });
    const client = await this.getClient();

    const points = await Promise.all(ids.map(id => toPointId(id)));
    await this.observe('delete_batch', () => client.delete(this.collectionName, { points, wait: true }));
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
        return { key, match: { value } };
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
   * The payload of the point with this ID, or null when no such point exists. A Qdrant error
   * (unreachable, auth, server error) is thrown as the client threw it, never read as "not found".
   */
  async getDocument(id: string): Promise<TMetadata | null> {
    debugVector.debug('[Qdrant] Getting document by ID: {ID}', { ID: id });
    const client = await this.getClient();
    const pointId = await toPointId(id);
    const points = await this.observe('retrieve', () =>
      client.retrieve(this.collectionName, { ids: [pointId], with_payload: true, with_vector: false }),
    );
    const result = (points[0]?.payload as TMetadata | undefined) ?? null;
    debugVector.debug('[Qdrant] Document retrieved: {retrieved} (found: {found})', {
      retrieved: id,
      found: result !== null,
    });
    return result;
  }
}
