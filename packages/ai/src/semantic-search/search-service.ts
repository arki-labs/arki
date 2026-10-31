/**
 * Generic Semantic Search Service
 * Provides advanced search capabilities with caching, analytics, and hybrid search
 */

import type { EmbedFailure, Embedder } from '@arki/embeddings';
import { embed, embedMany, isEmbedFailure, isSameSpace, SpaceMismatch } from '@arki/embeddings';

import type { VectorSearchProvider } from '../types.js';
import type { SearchOptions } from '../validation.js';
import type { SearchCache } from './cache.js';
import { debugSemantic } from '../debug.js';
import { KeywordSearchUnavailable } from '../failures.js';
import { SearchAnalyticsCollector } from './analytics.js';
import { InMemorySearchCache } from './cache.js';

export type SemanticSearchConfig<TMetadata = Record<string, unknown>> = {
  vectorProvider: VectorSearchProvider;
  /** Embeds queries and documents; its space must be the store's (`vectorProvider.space`). */
  embedder: Embedder;
  cache?: SearchCache<SearchResult<TMetadata>[]>;
  analytics?: SearchAnalyticsCollector;
  enableCache?: boolean;
  cacheTTL?: number;
};

export type { SearchOptions } from '../validation.js';

export type SearchResult<TMetadata = Record<string, unknown>> = {
  id: string;
  text?: string;
  preview?: string;
  score: number;
  highlights?: string[];
  metadata?: TMetadata;
};

/** Escapes every RegExp syntax character, so `text` matches only itself. */
function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

export type KeywordSearchProvider<TMetadata = Record<string, unknown>> = {
  search(query: string, options?: SearchOptions): Promise<SearchResult<TMetadata>[]>;
};

export class SemanticSearchService<TMetadata = Record<string, unknown>> {
  private cache: SearchCache<SearchResult<TMetadata>[]>;
  private analytics: SearchAnalyticsCollector;

  constructor(
    private config: SemanticSearchConfig<TMetadata>,
    private keywordProvider?: KeywordSearchProvider<TMetadata>,
  ) {
    this.cache = config.cache || new InMemorySearchCache(config.cacheTTL || 3600);
    this.analytics = config.analytics || new SearchAnalyticsCollector();

    debugSemantic.debug(
      '[SearchService] Service initialized (cacheEnabled: {cacheEnabled}, cacheTTL: {cacheTTL}s, hasKeywordProvider: {hasKeywordProvider})',
      {
        cacheEnabled: config.enableCache !== false,
        cacheTTL: config.cacheTTL || 3600,
        hasKeywordProvider: !!keywordProvider,
      },
    );
  }

  /**
   * Perform advanced search with multiple strategies
   */
  async search(
    options: SearchOptions & { mode?: 'semantic' },
  ): Promise<SearchResult<TMetadata>[] | EmbedFailure>;
  async search(
    options: SearchOptions,
  ): Promise<SearchResult<TMetadata>[] | EmbedFailure | KeywordSearchUnavailable>;
  async search(
    options: SearchOptions,
  ): Promise<SearchResult<TMetadata>[] | EmbedFailure | KeywordSearchUnavailable> {
    debugSemantic.debug('[SearchService] Performing search (query: "{query}", mode: {mode}, limit: {limit})', {
      query: options.query,
      mode: options.mode || 'semantic',
      limit: options.limit || 20,
    });

    const startTime = Date.now();
    const cacheKey = this.generateCacheKey(options);

    // Check cache first
    if (this.config.enableCache !== false) {
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        debugSemantic.debug('[SearchService] Cache hit (query: "{query}", results: {results})', {
          query: options.query,
          results: cached.length,
        });
        this.analytics.recordCacheHit(options.query);
        return cached;
      }
      debugSemantic.debug('[SearchService] Cache miss for query: "{query}"', { query: options.query });
    }

    let results: SearchResult<TMetadata>[] = [];
    const mode = options.mode || 'semantic';

    // Perform search based on mode
    if (mode === 'semantic' || mode === 'hybrid') {
      debugSemantic.debug('[SearchService] Performing vector search');
      const vectorResults = await this.performVectorSearch(options);
      if (isEmbedFailure(vectorResults)) return vectorResults;
      results = vectorResults;
      debugSemantic.debug('[SearchService] Vector search completed (results: {results})', { results: results.length });
    }

    if (mode === 'keyword' || mode === 'hybrid') {
      if (this.keywordProvider) {
        debugSemantic.debug('[SearchService] Performing keyword search');
        const keywordResults = await this.performKeywordSearch(options);
        debugSemantic.debug('[SearchService] Keyword search completed (results: {results})', {
          results: keywordResults.length,
        });

        if (mode === 'hybrid') {
          debugSemantic.debug('[SearchService] Merging semantic and keyword results');
          results = this.mergeResults(results, keywordResults);
        } else {
          results = keywordResults;
        }
      } else {
        if (mode === 'keyword') {
          debugSemantic.debug('[SearchService] Keyword search requested but no keyword provider configured');
          return KeywordSearchUnavailable();
        }
        debugSemantic.debug('[SearchService] No keyword provider, continuing with semantic results only');
      }
    }

    // Apply post-processing
    debugSemantic.debug('[SearchService] Post-processing results (count: {count})', { count: results.length });
    results = this.postProcessResults(results, options);

    // Cache results
    if (this.config.enableCache !== false) {
      await this.cache.set(cacheKey, results);
      debugSemantic.debug('[SearchService] Results cached');
    }

    // Record analytics
    const responseTime = Date.now() - startTime;
    this.analytics.record({
      query: options.query,
      mode,
      filters: options.filters,
      resultCount: results.length,
      responseTime,
      timestamp: new Date(),
    });

    debugSemantic.debug(
      '[SearchService] Search completed (query: "{query}", results: {results}, responseTime: {responseTime}ms)',
      { query: options.query, results: results.length, responseTime },
    );

    return results;
  }

  /**
   * Perform vector-based semantic search
   */
  private async performVectorSearch(options: SearchOptions): Promise<SearchResult<TMetadata>[] | EmbedFailure> {
    const { embedder, vectorProvider } = this.config;
    const query = await embed(embedder, options.query, { purpose: 'query' });
    if (isEmbedFailure(query)) return query;
    if (!isSameSpace(vectorProvider.space, query.space)) {
      return SpaceMismatch({ expected: vectorProvider.space, actual: query.space });
    }
    const vectorResults = await vectorProvider.searchByVector(query.vector, options.limit || 20, options.filters);

    debugSemantic.debug('[SearchService] Vector provider returned {vectorResultsLength} results', {
      vectorResultsLength: vectorResults.length,
    });

    // Filter by score threshold if specified
    const filtered =
      options.scoreThreshold === undefined
        ? vectorResults
        : vectorResults.filter(r => r.score >= options.scoreThreshold!);

    if (options.scoreThreshold !== undefined && filtered.length !== vectorResults.length) {
      debugSemantic.debug(
        '[SearchService] Filtered by score threshold {scoreThreshold} (before: {before}, after: {after})',
        { scoreThreshold: options.scoreThreshold, before: vectorResults.length, after: filtered.length },
      );
    }

    // Map to search results
    return filtered.map(vResult => ({
      id: vResult.id,
      score: vResult.score,
      metadata: vResult.metadata as TMetadata,
      preview: this.createPreview(
        vResult.metadata && 'text' in vResult.metadata && typeof vResult.metadata['text'] === 'string'
          ? vResult.metadata['text']
          : '',
        options.query,
      ),
      highlights: options.highlightTerms
        ? this.highlightText(
            vResult.metadata && 'text' in vResult.metadata && typeof vResult.metadata['text'] === 'string'
              ? vResult.metadata['text']
              : '',
            options.query,
          )
        : undefined,
    }));
  }

  /**
   * Perform keyword search using provided provider
   */
  private async performKeywordSearch(options: SearchOptions): Promise<SearchResult<TMetadata>[]> {
    if (!this.keywordProvider) {
      return [];
    }

    return this.keywordProvider.search(options.query, options);
  }

  /**
   * Merge results from different search strategies
   */
  private mergeResults(
    semanticResults: SearchResult<TMetadata>[],
    keywordResults: SearchResult<TMetadata>[],
    semanticWeight = 0.7,
    keywordWeight = 0.3,
  ): SearchResult<TMetadata>[] {
    debugSemantic.debug(
      '[SearchService] Merging results (semantic: {semantic}, keyword: {keyword}, weights: {weights}/{keywordWeight})',
      { semantic: semanticResults.length, keyword: keywordResults.length, weights: semanticWeight, keywordWeight },
    );

    const merged = new Map<string, SearchResult<TMetadata>>();

    // Add semantic results with weight
    for (const result of semanticResults) {
      merged.set(result.id, {
        ...result,
        score: result.score * semanticWeight,
      });
    }

    // Merge or add keyword results
    let overlappingResults = 0;
    for (const result of keywordResults) {
      const existing = merged.get(result.id);
      if (existing) {
        overlappingResults++;
        // Combine scores
        existing.score += result.score * keywordWeight;
        // Merge highlights
        if (result.highlights && existing.highlights) {
          existing.highlights = [...new Set([...existing.highlights, ...result.highlights])];
        }
      } else {
        merged.set(result.id, {
          ...result,
          score: result.score * keywordWeight,
        });
      }
    }

    debugSemantic.debug('[SearchService] Merge completed (total: {total}, overlapping: {overlapping})', {
      total: merged.size,
      overlapping: overlappingResults,
    });

    // Sort by combined score
    return [...merged.values()].sort((a, b) => b.score - a.score);
  }

  /**
   * Post-process results
   */
  private postProcessResults(results: SearchResult<TMetadata>[], options: SearchOptions): SearchResult<TMetadata>[] {
    // Apply limit if not already applied
    if (options.limit && results.length > options.limit) {
      results = results.slice(0, options.limit);
    }

    // Apply offset for pagination
    if (options.offset) {
      results = results.slice(options.offset);
    }

    // Remove metadata if not requested
    if (!options.includeMetadata) {
      results = results.map(r => {
        const { metadata, ...rest } = r;
        return rest;
      });
    }

    return results;
  }

  /**
   * Create text preview with context
   */
  private createPreview(text: string, query: string, maxLength = 200): string {
    if (!text) return '';

    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const words = lowerQuery.split(/\s+/);

    // Find best match position
    let bestIndex = -1;
    let bestScore = 0;

    for (let i = 0; i < lowerText.length - 50; i++) {
      let score = 0;
      const substring = new Set(lowerText.slice(i, i + 200));

      for (const word of words) {
        if (substring.has(word)) {
          score++;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (bestIndex === -1) {
      return text.length > maxLength ? text.slice(0, Math.max(0, maxLength)) + '...' : text;
    }

    // Extract preview around best match
    const start = Math.max(0, bestIndex - 50);
    const end = Math.min(text.length, bestIndex + 150);
    let preview = text.slice(start, end);

    if (start > 0) preview = '...' + preview;
    if (end < text.length) preview = preview + '...';

    return preview;
  }

  /**
   * Highlight matching terms in text
   */
  private highlightText(text: string, query: string): string[] {
    if (!text) return [];

    // Query words are plain text: escape them, so `c++` or `(` neither throws nor backtracks.
    const words = query.split(/\s+/).filter(word => word.length > 0);
    const highlights: string[] = [];

    for (const word of words) {
      const regex = new RegExp(`\\b(${escapeRegExp(word)})\\b`, 'gi');
      const matches = [...text.matchAll(regex)];

      for (const match of matches) {
        const start = Math.max(0, match.index - 30);
        const end = Math.min(text.length, match.index + word.length + 30);
        const highlight = text.slice(start, end);
        highlights.push(highlight);
      }
    }

    return highlights;
  }

  /**
   * Generate cache key for search options
   */
  private generateCacheKey(options: SearchOptions): string {
    // Every option that changes which results come back, or their shape.
    return JSON.stringify({
      q: options.query,
      m: options.mode,
      f: options.filters,
      l: options.limit,
      o: options.offset,
      st: options.scoreThreshold,
      im: options.includeMetadata,
      ht: options.highlightTerms,
    });
  }

  /**
   * Get search suggestions based on history
   */
  async getSuggestions(prefix: string, limit = 10): Promise<string[]> {
    return this.analytics.getPopularSearches(prefix, limit);
  }

  /**
   * Index documents for vector search
   */
  async indexDocuments(
    documents: {
      id: string;
      text: string;
      metadata?: TMetadata;
    }[],
    batchSize = 100,
  ): Promise<{ success: boolean; count: number } | EmbedFailure> {
    debugSemantic.debug('[SearchService] Indexing documents (total: {total}, batchSize: {batchSize})', {
      total: documents.length,
      batchSize,
    });

    let indexed = 0;
    const numBatches = Math.ceil(documents.length / batchSize);

    // Process in batches
    for (let i = 0; i < documents.length; i += batchSize) {
      const batch = documents.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;

      debugSemantic.debug('[SearchService] Indexing batch {batchNum}/{numBatches} (documents: {documents})', {
        batchNum,
        numBatches,
        documents: batch.length,
      });

      // All or nothing per batch: a failed embed writes none of the batch's points.
      const embedded = await embedMany(
        this.config.embedder,
        batch.map(doc => doc.text),
        { purpose: 'document' },
      );
      if (isEmbedFailure(embedded)) return embedded;
      // A vector from another space would sit in the index unfindable: refuse before writing any.
      if (!isSameSpace(this.config.vectorProvider.space, embedded.space)) {
        return SpaceMismatch({ expected: this.config.vectorProvider.space, actual: embedded.space });
      }
      // `embedMany` answers exactly one vector per input, in input order.
      await Promise.all(
        embedded.vectors.flatMap((vector, index) => {
          const doc = batch[index];
          if (doc === undefined) return [];
          // A text preview for result snippets; the caller's metadata wins on a clash.
          return [this.config.vectorProvider.upsertVector(doc.id, vector, { text: doc.text.slice(0, 1000), ...doc.metadata })];
        }),
      );

      indexed += batch.length;
    }

    debugSemantic.debug('[SearchService] Indexing completed (total indexed: {indexed})', { indexed });
    return { success: true, count: indexed };
  }

  /**
   * Clear the search cache
   */
  async clearCache(): Promise<void> {
    debugSemantic.debug('[SearchService] Clearing search cache');
    await this.cache.clear();
  }

  /**
   * Get search analytics metrics
   */
  getMetrics() {
    return this.analytics.getMetrics();
  }

  /**
   * Destroy the service and clean up resources
   */
  destroy(): void {
    debugSemantic.debug('[SearchService] Destroying search service and cleaning up resources');
    this.cache.destroy();
  }
}
