/**
 * Generic Semantic Search Service
 * Provides advanced search capabilities with caching, analytics, and hybrid search
 */

import { debugSemantic } from '../debug.ts';
import type {
  SearchOptions as BaseSearchOptions,
  SearchMode,
  VectorSearchProvider
} from '../types';
import { SearchAnalyticsCollector } from './analytics';
import type { SearchCache } from './cache';
import { InMemorySearchCache } from './cache';

export type SemanticSearchConfig = {
  vectorProvider: VectorSearchProvider;
  cache?: SearchCache;
  analytics?: SearchAnalyticsCollector;
  enableCache?: boolean;
  cacheTTL?: number;
}

export type SearchOptions = {
  query: string;
  mode?: SearchMode;
  limit?: number;
  offset?: number;
  scoreThreshold?: number;
  filters?: Record<string, unknown>;
  highlightTerms?: boolean;
  includeMetadata?: boolean;
} & BaseSearchOptions

export type SearchResult<TMetadata = Record<string, unknown>> = {
  id: string;
  text?: string;
  preview?: string;
  score: number;
  highlights?: string[];
  metadata?: TMetadata;
}

export type KeywordSearchProvider<TMetadata = Record<string, unknown>> = {
  search(query: string, options?: SearchOptions): Promise<SearchResult<TMetadata>[]>;
}

export class SemanticSearchService<TMetadata = Record<string, unknown>> {
  private cache: SearchCache;
  private analytics: SearchAnalyticsCollector;

  constructor(
    private config: SemanticSearchConfig,
    private keywordProvider?: KeywordSearchProvider<TMetadata>
  ) {
    this.cache = config.cache || new InMemorySearchCache(config.cacheTTL || 3600);
    this.analytics = config.analytics || new SearchAnalyticsCollector();

    debugSemantic(
      '[SearchService] Service initialized (cacheEnabled: %s, cacheTTL: %ds, hasKeywordProvider: %s)',
      config.enableCache !== false,
      config.cacheTTL || 3600,
      !!keywordProvider,
    );
  }

  /**
   * Perform advanced search with multiple strategies
   */
  async search(options: SearchOptions): Promise<SearchResult<TMetadata>[]> {
    debugSemantic(
      '[SearchService] Performing search (query: "%s", mode: %s, limit: %d)',
      options.query,
      options.mode || 'semantic',
      options.limit || 20,
    );

    const startTime = Date.now();
    const cacheKey = this.generateCacheKey(options);

    // Check cache first
    if (this.config.enableCache !== false) {
      const cached = await this.cache.get<SearchResult<TMetadata>[]>(cacheKey);
      if (cached) {
        debugSemantic('[SearchService] Cache hit (query: "%s", results: %d)', options.query, cached.length);
        this.analytics.recordCacheHit(options.query);
        return cached;
      }
      debugSemantic('[SearchService] Cache miss for query: "%s"', options.query);
    }

    let results: SearchResult<TMetadata>[] = [];
    const mode = options.mode || 'semantic';

    // Perform search based on mode
    if (mode === 'semantic' || mode === 'hybrid') {
      debugSemantic('[SearchService] Performing vector search');
      results = await this.performVectorSearch(options);
      debugSemantic('[SearchService] Vector search completed (results: %d)', results.length);
    }

    if (mode === 'keyword' || mode === 'hybrid') {
      if (this.keywordProvider) {
        debugSemantic('[SearchService] Performing keyword search');
        const keywordResults = await this.performKeywordSearch(options);
        debugSemantic('[SearchService] Keyword search completed (results: %d)', keywordResults.length);

        if (mode === 'hybrid') {
          debugSemantic('[SearchService] Merging semantic and keyword results');
          results = this.mergeResults(results, keywordResults);
        } else {
          results = keywordResults;
        }
      } else {
        if (mode === 'keyword') {
          debugSemantic('[SearchService] Keyword search requested but no keyword provider configured');
          throw new Error('Keyword search provider not configured');
        }
        debugSemantic('[SearchService] No keyword provider, continuing with semantic results only');
      }
    }

    // Apply post-processing
    debugSemantic('[SearchService] Post-processing results (count: %d)', results.length);
    results = this.postProcessResults(results, options);

    // Cache results
    if (this.config.enableCache !== false) {
      await this.cache.set(cacheKey, results);
      debugSemantic('[SearchService] Results cached');
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

    debugSemantic(
      '[SearchService] Search completed (query: "%s", results: %d, responseTime: %dms)',
      options.query,
      results.length,
      responseTime,
    );

    return results;
  }

  /**
   * Perform vector-based semantic search
   */
  private async performVectorSearch(
    options: SearchOptions
  ): Promise<SearchResult<TMetadata>[]> {
    const vectorResults = await this.config.vectorProvider.searchSimilar(
      options.query,
      options.limit || 20,
      options.filters
    );

    debugSemantic('[SearchService] Vector provider returned %d results', vectorResults.length);

    // Filter by score threshold if specified
    const filtered = options.scoreThreshold === undefined
      ? vectorResults
      : vectorResults.filter(r => r.score >= options.scoreThreshold!);

    if (options.scoreThreshold !== undefined && filtered.length !== vectorResults.length) {
      debugSemantic(
        '[SearchService] Filtered by score threshold %f (before: %d, after: %d)',
        options.scoreThreshold,
        vectorResults.length,
        filtered.length,
      );
    }

    // Map to search results
    return filtered.map(vResult => ({
      id: vResult.id,
      score: vResult.score,
      metadata: vResult.metadata as TMetadata,
      preview: this.createPreview(
        (vResult.metadata && 'text' in vResult.metadata && typeof vResult.metadata['text'] === 'string' ? vResult.metadata['text'] : ''),
        options.query
      ),
      highlights: options.highlightTerms
        ? this.highlightText(
            (vResult.metadata && 'text' in vResult.metadata && typeof vResult.metadata['text'] === 'string' ? vResult.metadata['text'] : ''),
            options.query
          )
        : undefined,
    }));
  }

  /**
   * Perform keyword search using provided provider
   */
  private async performKeywordSearch(
    options: SearchOptions
  ): Promise<SearchResult<TMetadata>[]> {
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
    keywordWeight = 0.3
  ): SearchResult<TMetadata>[] {
    debugSemantic(
      '[SearchService] Merging results (semantic: %d, keyword: %d, weights: %f/%f)',
      semanticResults.length,
      keywordResults.length,
      semanticWeight,
      keywordWeight,
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

    debugSemantic(
      '[SearchService] Merge completed (total: %d, overlapping: %d)',
      merged.size,
      overlappingResults,
    );

    // Sort by combined score
    return [...merged.values()].sort((a, b) => b.score - a.score);
  }

  /**
   * Post-process results
   */
  private postProcessResults(
    results: SearchResult<TMetadata>[],
    options: SearchOptions
  ): SearchResult<TMetadata>[] {
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
        return rest as SearchResult<TMetadata>;
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
      const substring = lowerText.substring(i, i + 200);

      for (const word of words) {
        if (substring.includes(word)) {
          score++;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (bestIndex === -1) {
      return text.length > maxLength
        ? text.slice(0, Math.max(0, maxLength)) + '...'
        : text;
    }

    // Extract preview around best match
    const start = Math.max(0, bestIndex - 50);
    const end = Math.min(text.length, bestIndex + 150);
    let preview = text.substring(start, end);

    if (start > 0) preview = '...' + preview;
    if (end < text.length) preview = preview + '...';

    return preview;
  }

  /**
   * Highlight matching terms in text
   */
  private highlightText(text: string, query: string): string[] {
    if (!text) return [];

    const words = query.split(/\s+/);
    const highlights: string[] = [];

    for (const word of words) {
      const regex = new RegExp(`\\b(${word})\\b`, 'gi');
      const matches = [...text.matchAll(regex)];

      for (const match of matches) {
        const start = Math.max(0, match.index - 30);
        const end = Math.min(text.length, match.index + word.length + 30);
        const highlight = text.substring(start, end);
        highlights.push(highlight);
      }
    }

    return highlights;
  }

  /**
   * Generate cache key for search options
   */
  private generateCacheKey(options: SearchOptions): string {
    return JSON.stringify({
      q: options.query,
      m: options.mode,
      f: options.filters,
      l: options.limit,
      o: options.offset,
      st: options.scoreThreshold,
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
    batchSize = 100
  ): Promise<{ success: boolean; count: number }> {
    debugSemantic('[SearchService] Indexing documents (total: %d, batchSize: %d)', documents.length, batchSize);

    let indexed = 0;
    const numBatches = Math.ceil(documents.length / batchSize);

    // Process in batches
    for (let i = 0; i < documents.length; i += batchSize) {
      const batch = documents.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;

      debugSemantic('[SearchService] Indexing batch %d/%d (documents: %d)', batchNum, numBatches, batch.length);

      await this.config.vectorProvider.indexDocumentsBatch?.(
        batch.map(doc => ({
          id: doc.id,
          text: doc.text,
          metadata: doc.metadata as Record<string, unknown>,
        }))
      ) || Promise.resolve();

      indexed += batch.length;
    }

    debugSemantic('[SearchService] Indexing completed (total indexed: %d)', indexed);
    return { success: true, count: indexed };
  }

  /**
   * Clear the search cache
   */
  clearCache(): void {
    debugSemantic('[SearchService] Clearing search cache');
    this.cache.clear();
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
    debugSemantic('[SearchService] Destroying search service and cleaning up resources');
    this.cache.destroy();
  }
}
