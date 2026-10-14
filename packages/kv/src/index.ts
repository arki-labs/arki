import type { IRateLimiterOptions, RateLimiterAbstract } from 'rate-limiter-flexible';
import KeyvRedis from '@keyv/redis';
import { Redis } from 'ioredis'; // Import ioredis for rate limiter
import Keyv from 'keyv';
import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';

import { debugKV, debugLimiter } from './debug.js';

export class KV {
  readonly #keyv: Keyv;
  readonly #redisClient: Redis; // Dedicated Redis client for rate limiter
  /** Limiters by id. One id can hold several, one per distinct options (compared as JSON). */
  readonly #limiterInstances = new Map<string, LimiterEntry[]>();
  #isRateLimiterReady = false;

  constructor(
    redisUrl: string,
    private readonly namespace?: string, // Keyv namespace
    private readonly rateLimitPrefix = 'rl', // Prefix for rate limiter keys
  ) {
    debugKV.debug('[kv] Initializing KV instance (namespace: {namespace}, rateLimitPrefix: {rateLimitPrefix})', {
      namespace: namespace || 'default',
      rateLimitPrefix,
    });

    // Parse Redis URL and determine if TLS is needed
    const isTLS = redisUrl.startsWith('rediss://');
    debugKV.debug('[kv] Detected TLS: {tls}', { tls: isTLS });
    const tlsOptions = isTLS ? { rejectUnauthorized: false } : undefined;

    // Keyv setup
    debugKV.debug('[kv] Setting up Keyv store with namespace: {namespace}', { namespace: this.namespace || 'none' });
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
      const isTransientSocketClose = err instanceof Error && err.name === 'SocketClosedUnexpectedlyError';
      if (isTransientSocketClose) {
        debugKV.debug('[kv] Keyv socket closed (transient): {errMessage}', { errMessage: err.message });
        return;
      }
      debugKV.debug('[kv] Keyv connection error', { error: err.message });
      console.error('Keyv connection error:', err);
    });
    debugKV.debug('[kv] Keyv store initialized');

    // ioredis setup for rate limiter
    debugLimiter.debug('[kv] Setting up ioredis client for rate limiting');
    this.#redisClient = new Redis(redisUrl, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy(times: number) {
        if (times > 10) {
          debugLimiter.debug('[kv] Rate limiter Redis: giving up after {times} retries', { times });
          // Return null to stop retrying — the in-memory fallback will handle rate limiting
          return null;
        }
        // Exponential backoff capped at 5 seconds
        const delay = Math.min(times * 500, 5000);
        debugLimiter.debug('[kv] Rate limiter Redis: retry {times} in {delay}ms', { times, delay });
        return delay;
      },
      ...(tlsOptions && { tls: tlsOptions }),
    });

    this.#redisClient.on('error', (err: Error) => {
      debugLimiter.debug('[kv] Rate limiter Redis client error', { error: err.message });
      this.#isRateLimiterReady = false;
    });

    this.#redisClient.on('ready', () => {
      debugLimiter.debug('[kv] Rate limiter Redis client ready');
      this.#isRateLimiterReady = true;
    });

    debugKV.debug('[kv] KV instance initialization complete');
  }

  // --- Standard Key-Value Methods (using Keyv) ---

  async get<T = unknown>(key: string): Promise<T | undefined> {
    debugKV.debug('[kv] Getting key: {key}', { key });
    const result = await this.#keyv.get(key);
    debugKV.debug('[kv] Get result for key {key}: {outcome}', {
      key,
      outcome: result === undefined ? 'not found' : 'found',
    });
    return result;
  }

  async set<T = unknown>(key: string, value: T, expirationSeconds?: number): Promise<boolean> {
    debugKV.debug('[kv] Setting key: {key} (ttl: {ttl})', {
      key,
      ttl: expirationSeconds ? `${expirationSeconds}s` : 'none',
    });
    const ttl = expirationSeconds ? expirationSeconds * 1000 : undefined;
    const result = await this.#keyv.set(key, value, ttl);
    debugKV.debug('[kv] Set result for key {key}: {outcome}', { key, outcome: result ? 'success' : 'failed' });
    return result;
  }

  async setIfNotExists<T = unknown>(key: string, value: T, expirationSeconds: number): Promise<boolean> {
    debugKV.debug('[kv] Setting key if absent: {key} (ttl: {ttl}s)', { key, ttl: expirationSeconds });
    const namespacedKey = this.namespace ? `${this.namespace}:${key}` : key;
    const serialized = JSON.stringify(value) ?? 'null';
    const result = await this.#redisClient.set(namespacedKey, serialized, 'EX', expirationSeconds, 'NX');
    const acquired = result === 'OK';
    debugKV.debug('[kv] Set-if-absent result for key {key}: {outcome}', {
      key,
      outcome: acquired ? 'acquired' : 'exists',
    });
    return acquired;
  }

  async mset<T = unknown>(keyValuePairs: [string, T][], _expirationSeconds?: number): Promise<void> {
    debugKV.debug('[kv] Setting multiple keys (count: {count})', { count: keyValuePairs.length });
    const entries = keyValuePairs.map(([key, value]) => ({ key, value }));
    await this.#keyv.setMany(entries);
    debugKV.debug('[kv] Multiple keys set successfully (count: {count})', { count: keyValuePairs.length });
  }

  async mget<T = unknown>(keys: string[]): Promise<(T | undefined)[]> {
    debugKV.debug('[kv] Getting multiple keys (count: {count})', { count: keys.length });
    const results = await this.#keyv.getMany(keys);
    const foundCount = results.filter(r => r !== undefined).length;
    debugKV.debug('[kv] Got multiple keys (requested: {requested}, found: {found})', {
      requested: keys.length,
      found: foundCount,
    });
    return results;
  }

  async exists(key: string): Promise<boolean> {
    debugKV.debug('[kv] Checking existence of key: {key}', { key });
    const value = await this.#keyv.get<unknown>(key);
    const exists = value !== undefined;
    debugKV.debug('[kv] Key {key} exists: {exists}', { key, exists });
    return exists;
  }

  async delete(key: string): Promise<boolean> {
    debugKV.debug('[kv] Deleting key: {key}', { key });
    const result = await this.#keyv.delete(key);
    debugKV.debug('[kv] Delete result for key {key}: {outcome}', { key, outcome: result ? 'deleted' : 'not found' });
    return result;
  }

  async deleteMany(keys: string[]): Promise<boolean> {
    debugKV.debug('[kv] Deleting multiple keys (count: {count})', { count: keys.length });
    const result = await this.#keyv.deleteMany(keys);
    debugKV.debug('[kv] Delete many result: {result}', { result: result ? 'success' : 'failed' });
    return result;
  }

  async clear(): Promise<void> {
    debugKV.debug('[kv] Clearing all keys');
    await this.#keyv.clear();
    debugKV.debug('[kv] All keys cleared');
  }

  // --- Redis Pub/Sub Methods ---

  async publish(channel: string, message: string): Promise<number> {
    debugKV.debug('[kv] Publishing to channel: {channel} (message length: {length})', {
      channel,
      length: message.length,
    });
    const result = await this.#redisClient.publish(channel, message);
    debugKV.debug('[kv] Publish result for channel {channel}: {result} subscriber(s)', { channel, result });
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
    // A limiter is reused when `id` and `JSON.stringify(options)` both match. Most options hold
    // only primitives, so they are first compared field by field, which gives the same answer
    // without serialising the options on every call. JSON is the fallback for anything else.
    // This is the per-request path, so it logs nothing; creating a limiter does.
    const entries = this.#limiterInstances.get(id);
    if (entries) {
      const cached = findLimiter(entries, options);
      if (cached) return cached;
    }

    debugLimiter.debug(
      '[limiter] No cached rate limiter, creating one (id: {id}, points: {points}, duration: {duration}s)',
      { id, points: options.points ?? 10, duration: options.duration ?? 60 },
    );

    // Use Redis limiter if the client is ready, otherwise fallback to in-memory
    // This fallback prevents application failure but loses persistence during Redis downtime.
    let limiter: RateLimiterAbstract;
    const keyPrefix = `${this.namespace ? this.namespace + ':' : ''}${this.rateLimitPrefix}:${id}`;

    if (this.#isRateLimiterReady && this.#redisClient.status === 'ready') {
      debugLimiter.debug('[limiter] Creating Redis rate limiter (id: {id}, prefix: {prefix})', {
        id,
        prefix: keyPrefix,
      });
      console.log(`Creating Redis Rate Limiter: ${id}`);
      limiter = new RateLimiterRedis({
        storeClient: this.#redisClient,
        keyPrefix,
        points: options.points ?? 10, // Default points
        duration: options.duration ?? 60, // Default duration (seconds)
        ...options, // Allow overriding defaults and adding other options
      });
    } else {
      debugLimiter.debug(
        '[limiter] Redis not ready - creating in-memory rate limiter (id: {id}, redisReady: {redisReady}, redisStatus: {redisStatus})',
        { id, redisReady: this.#isRateLimiterReady, redisStatus: this.#redisClient.status },
      );
      console.warn(`Redis client not ready. Creating In-Memory Rate Limiter (non-persistent): ${id}`);
      limiter = new RateLimiterMemory({
        keyPrefix,
        points: options.points ?? 10,
        duration: options.duration ?? 60,
        ...options,
      });
    }

    debugLimiter.debug('[limiter] Rate limiter created and cached for id: {id}', { id });
    const entry: LimiterEntry = { json: JSON.stringify(options), fields: primitiveFields(options), limiter };
    if (entries) {
      entries.push(entry);
    } else {
      this.#limiterInstances.set(id, [entry]);
    }
    return limiter;
  }

  /**
   * Disconnects both Keyv and the Rate Limiter Redis client.
   */
  async close(): Promise<void> {
    debugKV.debug('[kv] Closing KV instance');

    // Disconnect Keyv store
    const store = this.#keyv.opts.store;

    try {
      debugKV.debug('[kv] Disconnecting Keyv store');
      await store.disconnect?.();
      debugKV.debug('[kv] Keyv store disconnected');
    } catch (error) {
      debugKV.debug('[kv] Error disconnecting Keyv store: {reason}', {
        reason: error instanceof Error ? error.message : 'unknown error',
      });
      console.error('Error disconnecting Keyv store:', error);
    }

    // Disconnect Rate Limiter Redis client

    try {
      debugLimiter.debug('[kv] Disconnecting rate limiter Redis client');
      await this.#redisClient.quit();
      debugLimiter.debug('[kv] Rate limiter Redis client disconnected');
    } catch (error) {
      debugLimiter.debug('[kv] Error disconnecting rate limiter Redis client: {reason}', {
        reason: error instanceof Error ? error.message : 'unknown error',
      });
      console.error('Error disconnecting Rate Limiter Redis client:', error);
    }

    if (debugLimiter.isEnabled('debug')) {
      let count = 0;
      for (const entries of this.#limiterInstances.values()) count += entries.length;
      debugLimiter.debug('[kv] Clearing {count} cached rate limiter instance(s)', { count });
    }
    this.#limiterInstances.clear();
    debugKV.debug('[kv] KV instance closed successfully');
  }
}

/** A cached limiter and the options it was built from: their JSON, and their fields when all are primitive. */
type LimiterEntry = {
  readonly json: string;
  readonly fields: readonly unknown[] | undefined;
  readonly limiter: RateLimiterAbstract;
};

const hasOwn = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

/** `JSON.stringify` drops these values (and their keys) from an object. */
const isDroppedByJson = (value: unknown): boolean =>
  value === undefined || typeof value === 'function' || typeof value === 'symbol';

/** Options whose JSON is not just their own fields: a `toJSON` method rewrites it. */
const hasToJson = (options: object): boolean => typeof (options as { toJSON?: unknown }).toJSON === 'function';

/**
 * The options as a flat `[key, value, ...]` list of the fields `JSON.stringify` keeps, in its order.
 * `undefined` when a field holds an object or the options define `toJSON`: then only JSON compares.
 */
function primitiveFields(options: object): unknown[] | undefined {
  if (hasToJson(options)) return undefined;
  const fields: unknown[] = [];
  for (const key in options) {
    if (!hasOwn(options, key)) continue;
    const value: unknown = options[key as keyof typeof options];
    if (isDroppedByJson(value)) continue;
    if (typeof value === 'object' && value !== null) return undefined;
    fields.push(key, value);
  }
  return fields;
}

/**
 * Whether `options` has exactly these primitive fields, in the same order. `true` implies the two
 * serialise to the same JSON; `false` may still be equal JSON (e.g. `NaN` and `null`), which the
 * caller settles by comparing JSON.
 */
function sameFields(fields: readonly unknown[], options: object): boolean {
  if (hasToJson(options)) return false;
  let index = 0;
  for (const key in options) {
    if (!hasOwn(options, key)) continue;
    const value: unknown = options[key as keyof typeof options];
    if (isDroppedByJson(value)) continue;
    if (fields[index] !== key || fields[index + 1] !== value) return false;
    index += 2;
  }
  return index === fields.length;
}

/** The cached limiter whose options serialise to the same JSON as `options`, if any. */
function findLimiter(entries: readonly LimiterEntry[], options: object): RateLimiterAbstract | undefined {
  for (const entry of entries) {
    if (entry.fields !== undefined && sameFields(entry.fields, options)) return entry.limiter;
  }
  const json = JSON.stringify(options);
  for (const entry of entries) {
    if (entry.json === json) return entry.limiter;
  }
  return undefined;
}

// Re-export factory functions
export { createKV, createRateLimitKV } from './factory.js';
