/**
 * Search Analytics Collection
 */

export interface SearchAnalytics {
  query: string;
  mode: string;
  filters?: Record<string, unknown>;
  resultCount: number;
  responseTime: number;
  userId?: string;
  timestamp: Date;
}

export interface SearchMetrics {
  totalSearches: number;
  averageResponseTime: number;
  popularQueries: string[];
  cacheHitRate?: number;
}

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
    this.popularSearches.set(
      analytics.query,
      (this.popularSearches.get(analytics.query) || 0) + 1
    );

    // Keep only last N entries to prevent memory issues
    const maxHistory = 10000;
    if (this.history.length > maxHistory) {
      this.history = this.history.slice(-maxHistory);
    }
  }

  /**
   * Record a cache hit
   */
  recordCacheHit(_query: string): void {
    this.cacheHits++;
    this.totalRequests++;
  }

  /**
   * Get popular searches matching a prefix
   */
  async getPopularSearches(prefix: string, limit: number): Promise<string[]> {
    const matches: Array<[string, number]> = [];

    for (const [query, count] of this.popularSearches.entries()) {
      if (query.toLowerCase().startsWith(prefix.toLowerCase())) {
        matches.push([query, count]);
      }
    }

    // Sort by popularity
    matches.sort((a, b) => b[1] - a[1]);

    return matches.slice(0, limit).map(([query]) => query);
  }

  /**
   * Get analytics metrics
   */
  getMetrics(): SearchMetrics {
    const totalSearches = this.history.length;
    const averageResponseTime =
      totalSearches > 0
        ? this.history.reduce((sum, h) => sum + h.responseTime, 0) / totalSearches
        : 0;

    const popularQueries = Array.from(this.popularSearches.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([query]) => query);

    const cacheHitRate =
      this.totalRequests > 0
        ? (this.cacheHits / this.totalRequests) * 100
        : 0;

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
  getSearchesByTimeRange(
    startTime: Date,
    endTime: Date
  ): SearchAnalytics[] {
    return this.history.filter(
      h => h.timestamp >= startTime && h.timestamp <= endTime
    );
  }

  /**
   * Get query frequency over time
   */
  getQueryFrequency(query: string): {
    count: number;
    firstSeen?: Date;
    lastSeen?: Date;
  } {
    const matches = this.history.filter(
      h => h.query.toLowerCase() === query.toLowerCase()
    );

    if (matches.length === 0) {
      return { count: 0 };
    }

    return {
      count: matches.length,
      firstSeen: matches[0]!.timestamp,
      lastSeen: matches[matches.length - 1]!.timestamp,
    };
  }

  /**
   * Clear all analytics data
   */
  clear(): void {
    this.history = [];
    this.popularSearches.clear();
    this.cacheHits = 0;
    this.totalRequests = 0;
  }

  /**
   * Export analytics data for persistence
   */
  export(): {
    history: SearchAnalytics[];
    popularSearches: Array<[string, number]>;
    cacheHits: number;
    totalRequests: number;
  } {
    return {
      history: this.history,
      popularSearches: Array.from(this.popularSearches.entries()),
      cacheHits: this.cacheHits,
      totalRequests: this.totalRequests,
    };
  }

  /**
   * Import analytics data from persistence
   */
  import(data: {
    history: SearchAnalytics[];
    popularSearches: Array<[string, number]>;
    cacheHits: number;
    totalRequests: number;
  }): void {
    this.history = data.history.map(h => ({
      ...h,
      timestamp: new Date(h.timestamp),
    }));
    this.popularSearches = new Map(data.popularSearches);
    this.cacheHits = data.cacheHits;
    this.totalRequests = data.totalRequests;
  }
}