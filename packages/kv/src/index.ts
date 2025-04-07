import type { IRateLimiterOptions, RateLimiterAbstract } from 'rate-limiter-flexible';
import KeyvRedis from '@keyv/redis';
import Redis from 'ioredis'; // Import ioredis for rate limiter
import Keyv from 'keyv';
import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';

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
    // Keyv setup
    const store = new KeyvRedis(redisUrl);
    this.#keyv = new Keyv({ store, namespace: this.namespace });
    this.#keyv.on('error', err => console.error('Keyv connection error:', err));

    // ioredis setup for rate limiter
    this.#redisClient = new Redis(redisUrl, {
      // Important: enableOfflineQueue: false prevents commands from buffering
      // indefinitely if connection is lost during startup or runtime.
      // rate-limiter-flexible handles connection issues internally.
      enableOfflineQueue: false,
      // Add any other ioredis options if needed (e.g., maxRetriesPerRequest)
    });

    this.#redisClient.on('error', err => {
      console.error('Rate Limiter Redis Client Error:', err);
      this.#isRateLimiterReady = false;
      // Consider adding logic to potentially disable rate limiting or use fallback if needed
    });

    this.#redisClient.on('ready', () => {
      console.log('Rate Limiter Redis Client Ready.');
      this.#isRateLimiterReady = true;
    });
  }

  // --- Standard Key-Value Methods (using Keyv) ---

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.#keyv.get(key);
  }

  async set<T = unknown>(key: string, value: T, expirationSeconds?: number): Promise<boolean> {
    const ttl = expirationSeconds ? expirationSeconds * 1000 : undefined;
    return this.#keyv.set(key, value, ttl);
  }

  async mset<T = unknown>(keyValuePairs: [string, T][], _expirationSeconds?: number): Promise<void> {
    const entries = keyValuePairs.map(([key, value]) => ({ key, value }));
    await this.#keyv.setMany(entries);
  }

  async mget<T = unknown>(keys: string[]): Promise<(T | undefined)[]> {
    return this.#keyv.getMany(keys);
  }

  async exists(key: string): Promise<boolean> {
    const value = await this.#keyv.get<unknown>(key);
    return value !== undefined;
  }

  async delete(key: string): Promise<boolean> {
    return this.#keyv.delete(key);
  }

  async deleteMany(keys: string[]): Promise<boolean> {
    return this.#keyv.deleteMany(keys);
  }

  async clear(): Promise<void> {
    await this.#keyv.clear();
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
    const instanceKey = `${id}-${JSON.stringify(options)}`; // Simple key based on id + options

    if (this.#limiterInstances.has(instanceKey)) {
      return this.#limiterInstances.get(instanceKey)!;
    }

    // Use Redis limiter if the client is ready, otherwise fallback to in-memory
    // This fallback prevents application failure but loses persistence during Redis downtime.
    let limiter: RateLimiterAbstract;
    if (this.#isRateLimiterReady && this.#redisClient.status === 'ready') {
      console.log(`Creating Redis Rate Limiter: ${id}`);
      limiter = new RateLimiterRedis({
        storeClient: this.#redisClient,
        keyPrefix: `${this.namespace ? this.namespace + ':' : ''}${this.rateLimitPrefix}:${id}`,
        points: options.points ?? 10, // Default points
        duration: options.duration ?? 60, // Default duration (seconds)
        ...options, // Allow overriding defaults and adding other options
      });
    } else {
      console.warn(`Redis client not ready. Creating In-Memory Rate Limiter (non-persistent): ${id}`);
      limiter = new RateLimiterMemory({
        keyPrefix: `${this.namespace ? this.namespace + ':' : ''}${this.rateLimitPrefix}:${id}`,
        points: options.points ?? 10,
        duration: options.duration ?? 60,
        ...options,
      });
    }

    this.#limiterInstances.set(instanceKey, limiter);
    return limiter;
  }

  /**
   * Disconnects both Keyv and the Rate Limiter Redis client.
   */
  async close(): Promise<void> {
    // Disconnect Keyv store
    const store = this.#keyv.opts.store;

    try {
      await store.disconnect?.();
    } catch (error) {
      console.error('Error disconnecting Keyv store:', error);
    }

    // Disconnect Rate Limiter Redis client

    try {
      await this.#redisClient.quit();
    } catch (error) {
      console.error('Error disconnecting Rate Limiter Redis client:', error);
    }

    this.#limiterInstances.clear();
  }
}
