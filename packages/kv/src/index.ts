import KeyvRedis from '@keyv/redis';
import { Redis } from 'ioredis'; // Import ioredis for rate limiter
import Keyv from 'keyv';
import type { IRateLimiterOptions, RateLimiterAbstract } from 'rate-limiter-flexible';
import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';

import { debugKV, debugLimiter } from './debug.js';

export class KV {
  readonly #keyv: Keyv;
  readonly #redisClient: Redis; // Dedicated Redis client for rate limiter
  readonly #limiterInstances = new Map<string, RateLimiterAbstract>();
  #isRateLimiterReady = false;

  constructor(
    redisUrl: string,
    private readonly namespace?: string, // Keyv namespace
    private readonly rateLimitPrefix = 'rl', // Prefix for rate limiter keys
  ) {
    debugKV('[kv] Initializing KV instance (namespace: %s, rateLimitPrefix: %s)', namespace || 'default', rateLimitPrefix);

    // Parse Redis URL and determine if TLS is needed
    const isTLS = redisUrl.startsWith('rediss://');
    debugKV('[kv] Detected TLS: %s', isTLS);
    const tlsOptions = isTLS ? { rejectUnauthorized: false } : undefined;

    // Keyv setup
    debugKV('[kv] Setting up Keyv store with namespace: %s', this.namespace || 'none');
    const store = new KeyvRedis(redisUrl, {
      namespace: this.namespace,
      ...(tlsOptions && { socket: { tls: true, rejectUnauthorized: false } }),
    });
    this.#keyv = new Keyv({ store, namespace: this.namespace });
    this.#keyv.on('error', err => {
      // `SocketClosedUnexpectedlyError` from @redis/client fires during
      // normal events: dev-server SSR reloads tearing down the old module,
      // network blips that auto-reconnect, Redis server restarts. The
      // client retries transparently; callers see no effect unless a KV
      // call is in flight at that moment (and those throw at the call site
      // with a meaningful stack). Keep the noise at debug level.
      //
      // Any other Keyv error is genuinely unexpected and still loud.
      const isTransientSocketClose =
        err instanceof Error && err.name === 'SocketClosedUnexpectedlyError';
      if (isTransientSocketClose) {
        debugKV('[kv] Keyv socket closed (transient): %s', err.message);
        return;
      }
      debugKV('[kv] Keyv connection error: %s', err.message);
      console.error('Keyv connection error:', err);
    });
    debugKV('[kv] Keyv store initialized');

    // ioredis setup for rate limiter
    debugLimiter('[kv] Setting up ioredis client for rate limiting');
    this.#redisClient = new Redis(redisUrl, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy(times: number) {
        if (times > 10) {
          debugLimiter('[kv] Rate limiter Redis: giving up after %d retries', times);
          // Return null to stop retrying — the in-memory fallback will handle rate limiting
          return null;
        }
        // Exponential backoff capped at 5 seconds
        const delay = Math.min(times * 500, 5_000);
        debugLimiter('[kv] Rate limiter Redis: retry %d in %dms', times, delay);
        return delay;
      },
      ...(tlsOptions && { tls: tlsOptions }),
    });

    this.#redisClient.on('error', (err: Error) => {
      debugLimiter('[kv] Rate limiter Redis client error: %s', err.message);
      this.#isRateLimiterReady = false;
    });

    this.#redisClient.on('ready', () => {
      debugLimiter('[kv] Rate limiter Redis client ready');
      this.#isRateLimiterReady = true;
    });

    debugKV('[kv] KV instance initialization complete');
  }

  // --- Standard Key-Value Methods (using Keyv) ---

  async get<T = unknown>(key: string): Promise<T | undefined> {
    debugKV('[kv] Getting key: %s', key);
    const result = await this.#keyv.get(key);
    debugKV('[kv] Get result for key %s: %s', key, result === undefined ? 'not found' : 'found');
    return result;
  }

  async set<T = unknown>(key: string, value: T, expirationSeconds?: number): Promise<boolean> {
    debugKV('[kv] Setting key: %s (ttl: %s)', key, expirationSeconds ? `${expirationSeconds}s` : 'none');
    const ttl = expirationSeconds ? expirationSeconds * 1000 : undefined;
    const result = await this.#keyv.set(key, value, ttl);
    debugKV('[kv] Set result for key %s: %s', key, result ? 'success' : 'failed');
    return result;
  }

  async setIfNotExists<T = unknown>(key: string, value: T, expirationSeconds: number): Promise<boolean> {
    debugKV('[kv] Setting key if absent: %s (ttl: %ss)', key, expirationSeconds);
    const namespacedKey = this.namespace ? `${this.namespace}:${key}` : key;
    const serialized = JSON.stringify(value) ?? 'null';
    const result = await this.#redisClient.set(
      namespacedKey,
      serialized,
      'EX',
      expirationSeconds,
      'NX',
    );
    const acquired = result === 'OK';
    debugKV('[kv] Set-if-absent result for key %s: %s', key, acquired ? 'acquired' : 'exists');
    return acquired;
  }

  async mset<T = unknown>(keyValuePairs: [string, T][], _expirationSeconds?: number): Promise<void> {
    debugKV('[kv] Setting multiple keys (count: %d)', keyValuePairs.length);
    const entries = keyValuePairs.map(([key, value]) => ({ key, value }));
    await this.#keyv.setMany(entries);
    debugKV('[kv] Multiple keys set successfully (count: %d)', keyValuePairs.length);
  }

  async mget<T = unknown>(keys: string[]): Promise<(T | undefined)[]> {
    debugKV('[kv] Getting multiple keys (count: %d)', keys.length);
    const results = await this.#keyv.getMany(keys);
    const foundCount = results.filter(r => r !== undefined).length;
    debugKV('[kv] Got multiple keys (requested: %d, found: %d)', keys.length, foundCount);
    return results;
  }

  async exists(key: string): Promise<boolean> {
    debugKV('[kv] Checking existence of key: %s', key);
    const value = await this.#keyv.get<unknown>(key);
    const exists = value !== undefined;
    debugKV('[kv] Key %s exists: %s', key, exists);
    return exists;
  }

  async delete(key: string): Promise<boolean> {
    debugKV('[kv] Deleting key: %s', key);
    const result = await this.#keyv.delete(key);
    debugKV('[kv] Delete result for key %s: %s', key, result ? 'deleted' : 'not found');
    return result;
  }

  async deleteMany(keys: string[]): Promise<boolean> {
    debugKV('[kv] Deleting multiple keys (count: %d)', keys.length);
    const result = await this.#keyv.deleteMany(keys);
    debugKV('[kv] Delete many result: %s', result ? 'success' : 'failed');
    return result;
  }

  async clear(): Promise<void> {
    debugKV('[kv] Clearing all keys');
    await this.#keyv.clear();
    debugKV('[kv] All keys cleared');
  }

  // --- Redis Pub/Sub Methods ---

  async publish(channel: string, message: string): Promise<number> {
    debugKV('[kv] Publishing to channel: %s (message length: %d)', channel, message.length);
    const result = await this.#redisClient.publish(channel, message);
    debugKV('[kv] Publish result for channel %s: %d subscriber(s)', channel, result);
    return result;
  }

  // --- Rate Limiting Methods (using rate-limiter-flexible) ---

  /**
   * Gets or creates a RateLimiter instance with the specified options.
   *
   * @param id A unique identifier for this rate limiter configuration (e.g., 'login', 'api_global').
   * @param options Configuration options for the rate limiter (points, duration, etc.).
   *                See `rate-limiter-flexible` documentation for details.
   *                Defaults typically include `points` and `duration`.
   * @returns A RateLimiterAbstract instance ready to use (.consume, .get, etc.).
   *          Returns a RateLimiterMemory instance if Redis client is not ready.
   */
  getRateLimiter(id: string, options: Partial<IRateLimiterOptions>): RateLimiterAbstract {
    debugLimiter('[limiter] Getting rate limiter (id: %s, points: %d, duration: %ds)', id, options.points ?? 10, options.duration ?? 60);

    const instanceKey = `${id}-${JSON.stringify(options)}`; // Simple key based on id + options

    const existingLimiter = this.#limiterInstances.get(instanceKey);
    if (existingLimiter) {
      debugLimiter('[limiter] Returning cached rate limiter for id: %s', id);
      return existingLimiter;
    }

    // Use Redis limiter if the client is ready, otherwise fallback to in-memory
    // This fallback prevents application failure but loses persistence during Redis downtime.
    let limiter: RateLimiterAbstract;
    const keyPrefix = `${this.namespace ? this.namespace + ':' : ''}${this.rateLimitPrefix}:${id}`;

    if (this.#isRateLimiterReady && this.#redisClient.status === 'ready') {
      debugLimiter('[limiter] Creating Redis rate limiter (id: %s, prefix: %s)', id, keyPrefix);
      console.log(`Creating Redis Rate Limiter: ${id}`);
      limiter = new RateLimiterRedis({
        storeClient: this.#redisClient,
        keyPrefix,
        points: options.points ?? 10, // Default points
        duration: options.duration ?? 60, // Default duration (seconds)
        ...options, // Allow overriding defaults and adding other options
      });
    } else {
      debugLimiter('[limiter] Redis not ready - creating in-memory rate limiter (id: %s, redisReady: %s, redisStatus: %s)',
        id, this.#isRateLimiterReady, this.#redisClient.status);
      console.warn(`Redis client not ready. Creating In-Memory Rate Limiter (non-persistent): ${id}`);
      limiter = new RateLimiterMemory({
        keyPrefix,
        points: options.points ?? 10,
        duration: options.duration ?? 60,
        ...options,
      });
    }

    debugLimiter('[limiter] Rate limiter created and cached for id: %s', id);
    this.#limiterInstances.set(instanceKey, limiter);
    return limiter;
  }

  /**
   * Disconnects both Keyv and the Rate Limiter Redis client.
   */
  async close(): Promise<void> {
    debugKV('[kv] Closing KV instance');

    // Disconnect Keyv store
    const store = this.#keyv.opts.store;

    try {
      debugKV('[kv] Disconnecting Keyv store');
      await store.disconnect?.();
      debugKV('[kv] Keyv store disconnected');
    } catch (error) {
      debugKV('[kv] Error disconnecting Keyv store: %s', error instanceof Error ? error.message : 'unknown error');
      console.error('Error disconnecting Keyv store:', error);
    }

    // Disconnect Rate Limiter Redis client

    try {
      debugLimiter('[kv] Disconnecting rate limiter Redis client');
      await this.#redisClient.quit();
      debugLimiter('[kv] Rate limiter Redis client disconnected');
    } catch (error) {
      debugLimiter('[kv] Error disconnecting rate limiter Redis client: %s', error instanceof Error ? error.message : 'unknown error');
      console.error('Error disconnecting Rate Limiter Redis client:', error);
    }

    debugLimiter('[kv] Clearing %d cached rate limiter instance(s)', this.#limiterInstances.size);
    this.#limiterInstances.clear();
    debugKV('[kv] KV instance closed successfully');
  }
}

// Re-export factory functions
export { createKV, createRateLimitKV } from './factory.js';
