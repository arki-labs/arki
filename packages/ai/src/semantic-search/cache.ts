/**
 * Search Cache Implementation
 */

import { debugCache } from '../debug.ts';

export type CacheableValue = string | number | boolean | Record<string, unknown> | unknown[];

export type SearchCache = {
  get<T extends CacheableValue = CacheableValue>(key: string): Promise<T | null>;
  set<T extends CacheableValue>(key: string, value: T): Promise<void>;
  clear(): void;
  destroy(): void;
};

/**
 * In-memory cache implementation
 */
export class InMemorySearchCache implements SearchCache {
  private cache = new Map<string, { value: CacheableValue; expires: number }>();
  private cleanupInterval: NodeJS.Timeout;

  constructor(private ttl = 3600) {
    // Cleanup expired entries every minute
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    debugCache.debug('[InMemorySearchCache] Initialized with TTL: {TTL}s', { TTL: ttl });
  }

  async get<T extends CacheableValue = CacheableValue>(key: string): Promise<T | null> {
    const entry = this.cache.get(key);
    if (!entry) {
      debugCache.debug('[InMemorySearchCache] Cache miss for key: {key}', { key });
      return null;
    }

    if (Date.now() > entry.expires) {
      debugCache.debug('[InMemorySearchCache] Cache entry expired for key: {key}', { key });
      this.cache.delete(key);
      return null;
    }

    debugCache.debug('[InMemorySearchCache] Cache hit for key: {key}', { key });
    return entry.value as T;
  }

  async set<T extends CacheableValue>(key: string, value: T): Promise<void> {
    this.cache.set(key, {
      value,
      expires: Date.now() + this.ttl * 1000,
    });
    debugCache.debug('[InMemorySearchCache] Cached value for key: {key} (TTL: {TTL}s)', { key, TTL: this.ttl });
  }

  cleanup(): void {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expires) {
        this.cache.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      debugCache.debug('[InMemorySearchCache] Cleanup removed {removed} expired entries', { removed });
    }
  }

  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    debugCache.debug('[InMemorySearchCache] Cache cleared (removed {size} entries)', { size });
  }

  destroy(): void {
    debugCache.debug('[InMemorySearchCache] Destroying cache and stopping cleanup interval');
    clearInterval(this.cleanupInterval);
    this.clear();
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const stats = {
      size: this.cache.size,
      ttl: this.ttl,
    };
    debugCache.debug('[InMemorySearchCache] Stats retrieved (size: {size}, TTL: {TTL}s)', {
      size: stats.size,
      TTL: stats.ttl,
    });
    return stats;
  }
}

/**
 * Redis-based cache implementation (placeholder)
 */
export class RedisSearchCache implements SearchCache {
  constructor(
    private redisClient: unknown, // Redis client instance
    private ttl = 3600,
  ) {
    debugCache.debug('[RedisSearchCache] Initialized with TTL: {TTL}s', { TTL: ttl });
  }

  async get<T extends CacheableValue = CacheableValue>(key: string): Promise<T | null> {
    const client = this.redisClient as {
      get: (key: string) => Promise<string | null>;
    };
    const value = await client.get(key);
    if (!value) {
      debugCache.debug('[RedisSearchCache] Cache miss for key: {key}', { key });
      return null;
    }

    debugCache.debug('[RedisSearchCache] Cache hit for key: {key}', { key });
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as T;
    }
  }

  async set<T extends CacheableValue>(key: string, value: T): Promise<void> {
    const client = this.redisClient as {
      setex: (key: string, ttl: number, value: string) => Promise<void>;
    };
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    await client.setex(key, this.ttl, serialized);
    debugCache.debug('[RedisSearchCache] Cached value for key: {key} (TTL: {TTL}s)', { key, TTL: this.ttl });
  }

  async clear(): Promise<void> {
    // Clear all keys with a pattern (requires pattern or flush)
    debugCache.debug('[RedisSearchCache] Clearing cache (flushing database)');
    const client = this.redisClient as {
      flushdb: () => Promise<void>;
    };
    await client.flushdb();
    debugCache.debug('[RedisSearchCache] Cache cleared successfully');
  }

  destroy(): void {
    debugCache.debug('[RedisSearchCache] Destroying cache');
    // Cleanup if needed
  }
}
