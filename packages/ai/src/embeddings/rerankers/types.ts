/**
 * Reranker contract — distinct from `EmbeddingProvider` because the lifecycle
 * is different: rerankers are per-query, do not batch the same way, and
 * always return scores tied to a fixed candidate set.
 *
 * Implementations live alongside embedding providers but are not coupled to
 * them — you can stack any embedding provider with any reranker.
 */

export type RerankResult = {
  /** Index into the original `documents` array. */
  index: number;
  /** Relevance score; higher = more relevant. Range depends on the model. */
  score: number;
  /** Echoed document text — only present if `returnDocuments: true`. */
  document?: string;
};

export type RerankOptions = {
  /** Return only the top-K results. Default: all. */
  topK?: number;
  /** Whether to echo `document` strings on each result. Default: false. */
  returnDocuments?: boolean;
};

export type Reranker = {
  /**
   * Rerank `documents` by relevance to `query`. Returns results sorted by
   * score descending. The model is invoked once per call (no batching).
   */
  rerank(
    query: string,
    documents: string[],
    options?: RerankOptions,
  ): Promise<RerankResult[]>;

  /** Model id reported back for diagnostics / cache keys. */
  getModel(): string;
};
