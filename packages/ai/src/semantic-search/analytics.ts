/**
 * Search Analytics Collection
 */

import type { SchemaFailure } from '@arki/failure';
import { z } from '@arki/contracts';
import { isFailure } from '@arki/failure';
import { parse } from '@arki/schema';

import { debugSemantic } from '../debug.ts';

/** A count: a whole number, never negative. */
const countSchema = z.number().int().nonnegative();

/** One recorded search. A stored `timestamp` is a `Date`, or its ISO string once the export went through JSON. */
const searchAnalyticsSchema = z.object({
  query: z.string(),
  mode: z.string(),
  filters: z.record(z.string(), z.unknown()).optional(),
  resultCount: countSchema,
  responseTime: z.number().nonnegative(),
  userId: z.string().optional(),
  timestamp: z.union([z.date(), z.iso.datetime({ offset: true })]).transform(value => new Date(value)),
});

export type SearchAnalytics = z.output<typeof searchAnalyticsSchema>;

/** What `SearchAnalyticsCollector.export` returns and `import` accepts (also after a JSON round trip). */
export const searchAnalyticsExportSchema = z.object({
  history: z.array(searchAnalyticsSchema),
  popularSearches: z.array(z.tuple([z.string(), countSchema])),
  cacheHits: countSchema,
  totalRequests: countSchema,
});

export type SearchAnalyticsExport = z.output<typeof searchAnalyticsExportSchema>;

export type SearchMetrics = {
  totalSearches: number;
  averageResponseTime: number;
  popularQueries: string[];
  cacheHitRate?: number;
};

/**
 * Analytics collector for search queries
 */
export class SearchAnalyticsCollector {
  private history: SearchAnalytics[] = [];
  private popularSearches = new Map<string, number>();
  private cacheHits = 0;
  private totalRequests = 0;

  /**
   * Record a search query
   */
  record(analytics: SearchAnalytics): void {
    this.history.push(analytics);
    this.totalRequests++;

    // Update popular searches
    const queryCount = (this.popularSearches.get(analytics.query) || 0) + 1;
    this.popularSearches.set(analytics.query, queryCount);

    debugSemantic.debug(
      '[Analytics] Recorded search (query: "{query}", mode: {mode}, results: {results}, responseTime: {responseTime}ms, totalRequests: {totalRequests})',
      {
        query: analytics.query,
        mode: analytics.mode,
        results: analytics.resultCount,
        responseTime: analytics.responseTime,
        totalRequests: this.totalRequests,
      },
    );

    // Keep only last N entries to prevent memory issues
    const maxHistory = 10_000;
    if (this.history.length > maxHistory) {
      const trimmed = this.history.length - maxHistory;
      this.history = this.history.slice(-maxHistory);
      debugSemantic.debug('[Analytics] Trimmed history to prevent memory issues (removed {trimmed} old entries)', {
        trimmed,
      });
    }
  }

  /**
   * Record a cache hit
   */
  recordCacheHit(query: string): void {
    this.cacheHits++;
    this.totalRequests++;
    debugSemantic.debug(
      '[Analytics] Cache hit recorded (query: "{query}", cacheHits: {cacheHits}, totalRequests: {totalRequests})',
      { query, cacheHits: this.cacheHits, totalRequests: this.totalRequests },
    );
  }

  /**
   * Get popular searches matching a prefix
   */
  async getPopularSearches(prefix: string, limit: number): Promise<string[]> {
    debugSemantic.debug('[Analytics] Getting popular searches (prefix: "{prefix}", limit: {limit})', { prefix, limit });
    const matches: [string, number][] = [];

    for (const [query, count] of this.popularSearches.entries()) {
      if (query.toLowerCase().startsWith(prefix.toLowerCase())) {
        matches.push([query, count]);
      }
    }

    // Sort by popularity
    matches.sort((a, b) => b[1] - a[1]);

    const results = matches.slice(0, limit).map(([query]) => query);
    debugSemantic.debug('[Analytics] Found {resultsLength} popular searches matching prefix "{prefix}"', {
      resultsLength: results.length,
      prefix,
    });
    return results;
  }

  /**
   * Get analytics metrics
   */
  getMetrics(): SearchMetrics {
    const totalSearches = this.history.length;
    const averageResponseTime =
      totalSearches > 0 ? this.history.reduce((sum, h) => sum + h.responseTime, 0) / totalSearches : 0;

    const popularQueries = [...this.popularSearches.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([query]) => query);

    const cacheHitRate = this.totalRequests > 0 ? (this.cacheHits / this.totalRequests) * 100 : 0;

    debugSemantic.debug(
      '[Analytics] Metrics retrieved (totalSearches: {totalSearches}, avgResponseTime: {avgResponseTime}ms, cacheHitRate: {cacheHitRate}%)',
      { totalSearches, avgResponseTime: averageResponseTime, cacheHitRate },
    );

    return {
      totalSearches,
      averageResponseTime,
      popularQueries,
      cacheHitRate,
    };
  }

  /**
   * Get search history for a specific user
   */
  getUserHistory(userId: string, limit = 10): SearchAnalytics[] {
    return this.history
      .filter(h => h.userId === userId)
      .slice(-limit)
      .reverse();
  }

  /**
   * Get searches within a time range
   */
  getSearchesByTimeRange(startTime: Date, endTime: Date): SearchAnalytics[] {
    return this.history.filter(h => h.timestamp >= startTime && h.timestamp <= endTime);
  }

  /**
   * Get query frequency over time
   */
  getQueryFrequency(query: string): {
    count: number;
    firstSeen?: Date;
    lastSeen?: Date;
  } {
    const matches = this.history.filter(h => h.query.toLowerCase() === query.toLowerCase());

    if (matches.length === 0) {
      return { count: 0 };
    }

    return {
      count: matches.length,
      firstSeen: matches[0]!.timestamp,
      lastSeen: matches.at(-1)!.timestamp,
    };
  }

  /**
   * Clear all analytics data
   */
  clear(): void {
    const historySize = this.history.length;
    const popularSize = this.popularSearches.size;
    this.history = [];
    this.popularSearches.clear();
    this.cacheHits = 0;
    this.totalRequests = 0;
    debugSemantic.debug(
      '[Analytics] Cleared all data (history: {history} entries, popularSearches: {popularSearches} queries)',
      { history: historySize, popularSearches: popularSize },
    );
  }

  /**
   * Export analytics data for persistence
   */
  export(): SearchAnalyticsExport {
    const exported: SearchAnalyticsExport = {
      history: this.history,
      popularSearches: [...this.popularSearches.entries()],
      cacheHits: this.cacheHits,
      totalRequests: this.totalRequests,
    };
    debugSemantic.debug(
      '[Analytics] Exported data (history: {history} entries, popularSearches: {popularSearches} queries, cacheHits: {cacheHits}, totalRequests: {totalRequests})',
      {
        history: exported.history.length,
        popularSearches: exported.popularSearches.length,
        cacheHits: exported.cacheHits,
        totalRequests: exported.totalRequests,
      },
    );
    return exported;
  }

  /**
   * Import analytics data from persistence. Stored data is outside input: it is checked against
   * `searchAnalyticsExportSchema`, and malformed data returns `InvalidInput` and changes nothing.
   */
  import(stored: unknown): SchemaFailure | undefined {
    const data = parse(searchAnalyticsExportSchema, stored);
    if (isFailure(data)) {
      debugSemantic.debug('[Analytics] Import refused: stored data does not match the export shape ({code})', {
        code: data.code,
      });
      return data;
    }
    debugSemantic.debug(
      '[Analytics] Importing data (history: {history} entries, popularSearches: {popularSearches} queries, cacheHits: {cacheHits}, totalRequests: {totalRequests})',
      {
        history: data.history.length,
        popularSearches: data.popularSearches.length,
        cacheHits: data.cacheHits,
        totalRequests: data.totalRequests,
      },
    );
    this.history = data.history;
    this.popularSearches = new Map(data.popularSearches);
    this.cacheHits = data.cacheHits;
    this.totalRequests = data.totalRequests;
    debugSemantic.debug('[Analytics] Data imported successfully');
    return undefined;
  }
}
