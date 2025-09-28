/**
 * Search Cache Implementation
 */

export type CacheableValue =
  | string
  | number
  | boolean
  | Record<string, unknown>
  | unknown[];

export interface SearchCache {
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

  constructor(private ttl: number = 3600) {
    // Cleanup expired entries every minute
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  async get<T extends CacheableValue = CacheableValue>(key: string): Promise<T | null> {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expires) {
      this.cache.delete(key);
      return null;
    }

    return entry.value as T;
  }

  async set<T extends CacheableValue>(key: string, value: T): Promise<void> {
    this.cache.set(key, {
      value,
      expires: Date.now() + this.ttl * 1000,
    });
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expires) {
        this.cache.delete(key);
      }
    }
  }

  clear(): void {
    this.cache.clear();
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.clear();
  }

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      size: this.cache.size,
      ttl: this.ttl,
    };
  }
}

/**
 * Redis-based cache implementation (placeholder)
 */
export class RedisSearchCache implements SearchCache {
  constructor(
    private redisClient: unknown, // Redis client instance
    private ttl: number = 3600
  ) {}

  async get<T extends CacheableValue = CacheableValue>(key: string): Promise<T | null> {
    const client = this.redisClient as {
      get: (key: string) => Promise<string | null>
    };
    const value = await client.get(key);
    if (!value) return null;

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
  }

  async clear(): Promise<void> {
    // Clear all keys with a pattern (requires pattern or flush)
    const client = this.redisClient as {
      flushdb: () => Promise<void>
    };
    await client.flushdb();
  }

  destroy(): void {
    // Cleanup if needed
  }
}