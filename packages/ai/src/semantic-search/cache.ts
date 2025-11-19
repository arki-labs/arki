/**
 * Search Cache Implementation
 */

import { debugCache } from '../debug.ts';

export type CacheableValue =
  | string
  | number
  | boolean
  | Record<string, unknown>
  | unknown[];

export type SearchCache = {
  get<T extends CacheableValue = CacheableValue>(key: string): Promise<T | null>;
  set<T extends CacheableValue>(key: string, value: T): Promise<void>;
  clear(): void;
  destroy(): void;
}

/**
 * In-memory cache implementation
 */
export class InMemorySearchCache implements SearchCache {
  private cache = new Map<string, { value: CacheableValue; expires: number }>();
  private cleanupInterval: NodeJS.Timeout;

  constructor(private ttl = 3600) {
    // Cleanup expired entries every minute
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    debugCache('[InMemorySearchCache] Initialized with TTL: %ds', ttl);
  }

  async get<T extends CacheableValue = CacheableValue>(key: string): Promise<T | null> {
    const entry = this.cache.get(key);
    if (!entry) {
      debugCache('[InMemorySearchCache] Cache miss for key: %s', key);
      return null;
    }

    if (Date.now() > entry.expires) {
      debugCache('[InMemorySearchCache] Cache entry expired for key: %s', key);
      this.cache.delete(key);
      return null;
    }

    debugCache('[InMemorySearchCache] Cache hit for key: %s', key);
    return entry.value as T;
  }

  async set<T extends CacheableValue>(key: string, value: T): Promise<void> {
    this.cache.set(key, {
      value,
      expires: Date.now() + this.ttl * 1000,
    });
    debugCache('[InMemorySearchCache] Cached value for key: %s (TTL: %ds)', key, this.ttl);
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
      debugCache('[InMemorySearchCache] Cleanup removed %d expired entries', removed);
    }
  }

  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    debugCache('[InMemorySearchCache] Cache cleared (removed %d entries)', size);
  }

  destroy(): void {
    debugCache('[InMemorySearchCache] Destroying cache and stopping cleanup interval');
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
    debugCache('[InMemorySearchCache] Stats retrieved (size: %d, TTL: %ds)', stats.size, stats.ttl);
    return stats;
  }
}

/**
 * Redis-based cache implementation (placeholder)
 */
export class RedisSearchCache implements SearchCache {
  constructor(
    private redisClient: unknown, // Redis client instance
    private ttl = 3600
  ) {
    debugCache('[RedisSearchCache] Initialized with TTL: %ds', ttl);
  }

  async get<T extends CacheableValue = CacheableValue>(key: string): Promise<T | null> {
    const client = this.redisClient as {
      get: (key: string) => Promise<string | null>
    };
    const value = await client.get(key);
    if (!value) {
      debugCache('[RedisSearchCache] Cache miss for key: %s', key);
      return null;
    }

    debugCache('[RedisSearchCache] Cache hit for key: %s', key);
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as T;
    }
  }

  async set<T extends CacheableValue>(key: string, value: T): Promise<void> {
    const client = this.redisClient as {
      setex: (key: string, ttl: number, value: string) => Promise<void>
    };
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    await client.setex(key, this.ttl, serialized);
    debugCache('[RedisSearchCache] Cached value for key: %s (TTL: %ds)', key, this.ttl);
  }

  async clear(): Promise<void> {
    // Clear all keys with a pattern (requires pattern or flush)
    debugCache('[RedisSearchCache] Clearing cache (flushing database)');
    const client = this.redisClient as {
      flushdb: () => Promise<void>
    };
    await client.flushdb();
    debugCache('[RedisSearchCache] Cache cleared successfully');
  }

  destroy(): void {
    debugCache('[RedisSearchCache] Destroying cache');
    // Cleanup if needed
  }
}
