/**
 * Search Cache Implementation
 */

import type { StandardSchemaV1 } from '@arki/schema';
import { isSchemaFailure } from '@arki/failure';
import { parse } from '@arki/schema';

import { debugCache } from '../debug.js';

/** A cache of one value type. `SemanticSearchService` stores its result lists in one. */
export type SearchCache<TValue> = {
  get(key: string): Promise<TValue | null>;
  set(key: string, value: TValue): Promise<void>;
  /** Removes every entry this cache wrote, and nothing else. */
  clear(): Promise<void>;
  destroy(): void;
};

/**
 * In-memory cache implementation
 */
export class InMemorySearchCache<TValue> implements SearchCache<TValue> {
  private cache = new Map<string, { value: TValue; expires: number }>();
  private cleanupInterval: NodeJS.Timeout;

  constructor(private ttl = 3600) {
    // Cleanup expired entries every minute
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    debugCache.debug('[InMemorySearchCache] Initialized with TTL: {TTL}s', { TTL: ttl });
  }

  async get(key: string): Promise<TValue | null> {
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
    return entry.value;
  }

  async set(key: string, value: TValue): Promise<void> {
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

  async clear(): Promise<void> {
    const size = this.cache.size;
    this.cache.clear();
    debugCache.debug('[InMemorySearchCache] Cache cleared (removed {size} entries)', { size });
  }

  destroy(): void {
    debugCache.debug('[InMemorySearchCache] Destroying cache and stopping cleanup interval');
    clearInterval(this.cleanupInterval);
    this.cache.clear();
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
 * The Redis commands `RedisSearchCache` uses, in the shape of an `ioredis` client. Any client with
 * these methods works.
 */
export type RedisSearchClient = {
  get(key: string): Promise<string | null>;
  setex(key: string, seconds: number, value: string): Promise<unknown>;
  scan(
    cursor: string,
    matchToken: 'MATCH',
    pattern: string,
    countToken: 'COUNT',
    count: number,
  ): Promise<[cursor: string, keys: string[]]>;
  del(...keys: string[]): Promise<number>;
};

/** Options of a {@link RedisSearchCache}. */
export type RedisSearchCacheOptions<TValue> = {
  /** Checks every value read back from Redis; a value it rejects is a cache miss. Its output type is the cache's value type. */
  schema: StandardSchemaV1<unknown, TValue>;
  /** Seconds an entry lives. Default 3600. */
  ttl?: number;
  /** Prefix of every key this cache writes; `clear` deletes only keys with it. Default `arki:search-cache:`. */
  keyPrefix?: string;
};

/** Escapes the glob characters of a Redis `MATCH` pattern. */
function escapeGlob(text: string): string {
  return text.replaceAll(/[*?[\]\\]/g, String.raw`\$&`);
}

/**
 * Redis-backed cache. Keys live under `keyPrefix`, so `clear` removes only this cache's entries
 * (SCAN + DEL), never the rest of the database. Values are JSON, checked by `schema` on read.
 */
export class RedisSearchCache<TValue> implements SearchCache<TValue> {
  private readonly schema: StandardSchemaV1<unknown, TValue>;
  private readonly ttl: number;
  private readonly keyPrefix: string;

  constructor(
    private readonly redisClient: RedisSearchClient,
    options: RedisSearchCacheOptions<TValue>,
  ) {
    this.schema = options.schema;
    this.ttl = options.ttl ?? 3600;
    this.keyPrefix = options.keyPrefix ?? 'arki:search-cache:';
    debugCache.debug('[RedisSearchCache] Initialized with TTL: {TTL}s, prefix: {prefix}', {
      TTL: this.ttl,
      prefix: this.keyPrefix,
    });
  }

  async get(key: string): Promise<TValue | null> {
    const raw = await this.redisClient.get(this.keyPrefix + key);
    if (raw === null) {
      debugCache.debug('[RedisSearchCache] Cache miss for key: {key}', { key });
      return null;
    }

    let stored: unknown;
    try {
      stored = JSON.parse(raw);
    } catch {
      // JSON.parse throws only SyntaxError: an entry this cache did not write. Treat it as a miss.
      debugCache.debug('[RedisSearchCache] Entry is not JSON, treated as a miss (key: {key})', { key });
      return null;
    }

    const value = parse(this.schema, stored);
    if (isSchemaFailure(value)) {
      debugCache.debug(
        '[RedisSearchCache] Entry rejected by the schema, treated as a miss (key: {key}, code: {code})',
        {
          key,
          code: value.code,
        },
      );
      return null;
    }

    debugCache.debug('[RedisSearchCache] Cache hit for key: {key}', { key });
    return value;
  }

  async set(key: string, value: TValue): Promise<void> {
    await this.redisClient.setex(this.keyPrefix + key, this.ttl, JSON.stringify(value));
    debugCache.debug('[RedisSearchCache] Cached value for key: {key} (TTL: {TTL}s)', { key, TTL: this.ttl });
  }

  async clear(): Promise<void> {
    const pattern = `${escapeGlob(this.keyPrefix)}*`;
    let cursor = '0';
    let removed = 0;
    do {
      const [next, keys] = await this.redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      if (keys.length > 0) removed += await this.redisClient.del(...keys);
      cursor = next;
    } while (cursor !== '0');
    debugCache.debug('[RedisSearchCache] Cache cleared (removed {removed} keys under {prefix})', {
      removed,
      prefix: this.keyPrefix,
    });
  }

  destroy(): void {
    debugCache.debug('[RedisSearchCache] Destroying cache');
  }
}
