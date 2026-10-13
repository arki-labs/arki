/**
 * Search Analytics Collection
 */

import { debugSemantic } from '../debug.ts';

export type SearchAnalytics = {
  query: string;
  mode: string;
  filters?: Record<string, unknown>;
  resultCount: number;
  responseTime: number;
  userId?: string;
  timestamp: Date;
};

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
  export(): {
    history: SearchAnalytics[];
    popularSearches: [string, number][];
    cacheHits: number;
    totalRequests: number;
  } {
    const exported = {
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
   * Import analytics data from persistence
   */
  import(data: {
    history: SearchAnalytics[];
    popularSearches: [string, number][];
    cacheHits: number;
    totalRequests: number;
  }): void {
    debugSemantic.debug(
      '[Analytics] Importing data (history: {history} entries, popularSearches: {popularSearches} queries, cacheHits: {cacheHits}, totalRequests: {totalRequests})',
      {
        history: data.history.length,
        popularSearches: data.popularSearches.length,
        cacheHits: data.cacheHits,
        totalRequests: data.totalRequests,
      },
    );
    this.history = data.history.map(h => ({
      ...h,
      timestamp: new Date(h.timestamp),
    }));
    this.popularSearches = new Map(data.popularSearches);
    this.cacheHits = data.cacheHits;
    this.totalRequests = data.totalRequests;
    debugSemantic.debug('[Analytics] Data imported successfully');
  }
}
