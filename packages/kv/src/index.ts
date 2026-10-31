/** A Redis-backed key-value store and rate-limiter client (`KV`) with an in-memory fallback. */
import type { IRateLimiterOptions, RateLimiterAbstract } from 'rate-limiter-flexible';
import KeyvRedis from '@keyv/redis';
import { Redis } from 'ioredis'; // Import ioredis for rate limiter
import Keyv from 'keyv';
import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';

import type { SchemaOutput, StandardSchemaV1 } from '@arki/schema';
import type { Failure } from '@arki/failure';
import { attempt, InvalidInput, isFailure } from '@arki/failure';
import { formatIssues, parse } from '@arki/schema';

import { debugKV, debugLimiter } from './debug.js';
import { KvCancelled, KvCloseFailed, KvUnavailable, KvValueInvalid } from './errors.js';
import { observeKv } from './telemetry.js';

/** Options for {@link KV} beyond the URL, namespace and rate limit prefix. */
export type KvOptions = {
  /**
   * Skip TLS certificate checks for a `rediss://` URL (default `false`: the certificate is verified).
   * Turn it on only for a server with a self-signed certificate that you trust, such as a local test Redis.
   */
  readonly allowUnverifiedTls?: boolean;
  /**
   * How long one command may take before it returns {@link KvUnavailable}, in milliseconds (default `5000`).
   * A Redis that is down never answers (the client keeps reconnecting), so without this limit a call would wait for ever.
   */
  readonly commandTimeoutMs?: number;
};

/** Options for one command. */
export type KvCallOptions = {
  /** Aborting the signal ends the wait with {@link KvCancelled}. A write that was already sent may still land. */
  readonly signal?: AbortSignal;
};

export class KV {
  readonly #keyv: Keyv;
  readonly #store: KeyvRedis<unknown>;
  readonly #redisClient: Redis; // Dedicated Redis client for rate limiter
  /** Limiters by id. One id can hold several, one per distinct options (compared as JSON). */
  readonly #limiterInstances = new Map<string, LimiterEntry[]>();
  #isRateLimiterReady = false;
  #limiterClosed = false;
  readonly #commandTimeoutMs: number;

  constructor(
    redisUrl: string,
    private readonly namespace?: string, // Keyv namespace
    private readonly rateLimitPrefix = 'rl', // Prefix for rate limiter keys
    options: KvOptions = {},
  ) {
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 5000;
    debugKV.debug('[kv] Initializing KV instance (namespace: {namespace}, rateLimitPrefix: {rateLimitPrefix})', {
      namespace: namespace || 'default',
      rateLimitPrefix,
    });

    // `rediss://` turns TLS on in both clients, with certificate checks. Checks come off only by name.
    const isTLS = redisUrl.startsWith('rediss://');
    const skipTlsVerification = isTLS && options.allowUnverifiedTls === true;
    debugKV.debug('[kv] Detected TLS: {tls} (verify certificate: {verify})', {
      tls: isTLS,
      verify: !skipTlsVerification,
    });
    if (skipTlsVerification) {
      debugKV.warn('[kv] TLS certificate checks are OFF for this connection (allowUnverifiedTls)');
    }

    // Keyv setup
    debugKV.debug('[kv] Setting up Keyv store with namespace: {namespace}', { namespace: this.namespace || 'none' });
    this.#store = new KeyvRedis(redisUrl, {
      namespace: this.namespace,
      ...(skipTlsVerification && { socket: { tls: true, rejectUnauthorized: false } }),
    });
    this.#keyv = new Keyv({ store: this.#store, namespace: this.namespace, throwOnErrors: true });
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
      debugKV.error(err instanceof Error ? err : new Error(String(err)), { source: 'keyv connection' });
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
      ...(skipTlsVerification && { tls: { rejectUnauthorized: false } }),
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

  /** Resolves once the dedicated Redis client can take commands (it has no offline queue); rejects if it ends first. */
  async #whenRedisReady(): Promise<void> {
    const client = this.#redisClient;
    if (client.status === 'ready') return;
    await new Promise<void>((resolve, reject) => {
      const done = (error?: Error) => {
        client.off('ready', onReady);
        client.off('end', onEnd);
        if (error) reject(error);
        else resolve();
      };
      const onReady = () => done();
      const onEnd = () => done(new Error('the Redis connection ended before it was ready'));
      client.once('ready', onReady);
      client.once('end', onEnd);
      if (client.status === 'ready') onReady();
    });
  }

  /**
   * Run one command under its `kv.<command>` span. A driver error or a missing answer within
   * `commandTimeoutMs` becomes {@link KvUnavailable}; the caller's abort signal becomes {@link KvCancelled}.
   * No driver error escapes.
   */
  async #run<Result>(command: string, options: KvCallOptions | undefined, execute: () => Promise<Result>) {
    return await observeKv(command, async () => {
      const signal = options?.signal;
      if (signal?.aborted) return KvCancelled({ command });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const interrupted = new Promise<KvUnavailable | KvCancelled>(resolve => {
        timer = setTimeout(() => {
          resolve(KvUnavailable({ command, reason: `no answer within ${this.#commandTimeoutMs} ms` }));
        }, this.#commandTimeoutMs);
        onAbort = () => resolve(KvCancelled({ command }));
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      try {
        const done = attempt(execute, cause =>
          KvUnavailable({ command, reason: cause instanceof Error ? cause.message : String(cause) }),
        );
        return await Promise.race([done, interrupted]);
      } finally {
        clearTimeout(timer);
        if (onAbort) signal?.removeEventListener('abort', onAbort);
      }
    });
  }

  /** Wait for a disconnect, but no longer than `commandTimeoutMs`: a client that is reconnecting never answers `quit`. */
  async #within(pending: Promise<unknown> | undefined): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${this.#commandTimeoutMs} ms`)), this.#commandTimeoutMs);
    });
    try {
      await Promise.race([pending, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** A stored value checked against the schema: its output, or {@link KvValueInvalid} (other schema failures pass through). */
  #check<Schema extends StandardSchemaV1>(
    key: string,
    schema: Schema,
    stored: unknown,
  ): Failure | { readonly value: SchemaOutput<Schema> | undefined } {
    if (stored === undefined) return { value: undefined };
    const parsed = parse(schema, stored);
    if (isFailure(parsed)) {
      return InvalidInput.is(parsed) ? KvValueInvalid({ key, issues: formatIssues(parsed.data.issues) }) : parsed;
    }
    return { value: parsed };
  }

  // --- Standard Key-Value Methods (using Keyv) ---

  /**
   * Read `key` and check it against `schema` (any Standard Schema, zod by default). Returns the parsed
   * value, `undefined` for a missing key, {@link KvValueInvalid} when the stored value has the wrong shape,
   * or {@link KvUnavailable} / {@link KvCancelled}.
   */
  async get<Schema extends StandardSchemaV1>(key: string, schema: Schema, options?: KvCallOptions) {
    const stored = await this.#run('get', options, async () => {
      debugKV.debug('[kv] Getting key: {key}', { key });
      const result: unknown = await this.#keyv.get(key);
      debugKV.debug('[kv] Get result for key {key}: {outcome}', {
        key,
        outcome: result === undefined ? 'not found' : 'found',
      });
      return { stored: result };
    });
    if (isFailure(stored)) return stored;
    const checked = this.#check(key, schema, stored.stored);
    return isFailure(checked) ? checked : checked.value;
  }

  /** Write `value` (anything JSON can hold). With `expirationSeconds` the key expires after that many seconds. */
  async set(key: string, value: unknown, expirationSeconds?: number, options?: KvCallOptions) {
    return await this.#run('set', options, async () => {
      debugKV.debug('[kv] Setting key: {key} (ttl: {ttl})', {
        key,
        ttl: expirationSeconds ? `${expirationSeconds}s` : 'none',
      });
      const ttl = expirationSeconds ? expirationSeconds * 1000 : undefined;
      const result = await this.#keyv.set(key, value, ttl);
      debugKV.debug('[kv] Set result for key {key}: {outcome}', { key, outcome: result ? 'success' : 'failed' });
      return result;
    });
  }

  /**
   * Write `value` only if `key` is absent, in one atomic Redis `SET NX EX`. The key and the stored
   * format are the ones {@link KV.set} uses, so {@link KV.get} reads the value back.
   */
  async setIfNotExists(key: string, value: unknown, expirationSeconds: number, options?: KvCallOptions) {
    return await this.#run('setIfNotExists', options, async () => {
      debugKV.debug('[kv] Setting key if absent: {key} (ttl: {ttl}s)', { key, ttl: expirationSeconds });
      await this.#whenRedisReady();
      const keyvKey = this.namespace ? `${this.namespace}:${key}` : key;
      const redisKey = this.namespace ? this.#store.createKeyPrefix(keyvKey, this.namespace) : keyvKey;
      const stored = await this.#keyv.serializeData({ value, expires: Date.now() + expirationSeconds * 1000 });
      const result = await this.#redisClient.set(
        redisKey,
        typeof stored === 'string' ? stored : JSON.stringify(stored),
        'EX',
        expirationSeconds,
        'NX',
      );
      const acquired = result === 'OK';
      debugKV.debug('[kv] Set-if-absent result for key {key}: {outcome}', {
        key,
        outcome: acquired ? 'acquired' : 'exists',
      });
      return acquired;
    });
  }

  /** Write every pair; with `expirationSeconds`, each pair expires after that many seconds. */
  async mset(keyValuePairs: readonly (readonly [string, unknown])[], expirationSeconds?: number, options?: KvCallOptions) {
    return await this.#run('mset', options, async () => {
      debugKV.debug('[kv] Setting multiple keys (count: {count})', { count: keyValuePairs.length });
      const ttl = expirationSeconds ? expirationSeconds * 1000 : undefined;
      const entries = keyValuePairs.map(([key, value]) => ({ key, value, ttl }));
      await this.#keyv.setMany(entries);
      debugKV.debug('[kv] Multiple keys set successfully (count: {count})', { count: keyValuePairs.length });
    });
  }

  /**
   * Read several keys and check each stored value against `schema`. Missing keys are `undefined`.
   * The first value with the wrong shape fails the whole call with {@link KvValueInvalid}.
   */
  async mget<Schema extends StandardSchemaV1>(keys: readonly string[], schema: Schema, options?: KvCallOptions) {
    const stored = await this.#run('mget', options, async () => {
      debugKV.debug('[kv] Getting multiple keys (count: {count})', { count: keys.length });
      const results: unknown[] = await this.#keyv.getMany([...keys]);
      const foundCount = results.filter(r => r !== undefined).length;
      debugKV.debug('[kv] Got multiple keys (requested: {requested}, found: {found})', {
        requested: keys.length,
        found: foundCount,
      });
      return { stored: results };
    });
    if (isFailure(stored)) return stored;
    const values: (SchemaOutput<Schema> | undefined)[] = [];
    for (const [index, value] of stored.stored.entries()) {
      const checked = this.#check(keys[index] ?? '', schema, value);
      if (isFailure(checked)) return checked;
      values.push(checked.value);
    }
    return values;
  }

  async exists(key: string, options?: KvCallOptions) {
    return await this.#run('exists', options, async () => {
      debugKV.debug('[kv] Checking existence of key: {key}', { key });
      const value: unknown = await this.#keyv.get(key);
      const exists = value !== undefined;
      debugKV.debug('[kv] Key {key} exists: {exists}', { key, exists });
      return exists;
    });
  }

  async delete(key: string, options?: KvCallOptions) {
    return await this.#run('delete', options, async () => {
      debugKV.debug('[kv] Deleting key: {key}', { key });
      const result = await this.#keyv.delete(key);
      debugKV.debug('[kv] Delete result for key {key}: {outcome}', { key, outcome: result ? 'deleted' : 'not found' });
      return result;
    });
  }

  async deleteMany(keys: readonly string[], options?: KvCallOptions) {
    return await this.#run('deleteMany', options, async () => {
      debugKV.debug('[kv] Deleting multiple keys (count: {count})', { count: keys.length });
      const result = await this.#keyv.deleteMany([...keys]);
      debugKV.debug('[kv] Delete many result: {result}', { result: result ? 'success' : 'failed' });
      return result;
    });
  }

  async clear(options?: KvCallOptions) {
    return await this.#run('clear', options, async () => {
      debugKV.debug('[kv] Clearing all keys');
      await this.#keyv.clear();
      debugKV.debug('[kv] All keys cleared');
    });
  }

  // --- Redis Pub/Sub Methods ---

  /** Publish `message` on `channel`. Returns how many subscribers received it. */
  async publish(channel: string, message: string, options?: KvCallOptions) {
    return await this.#run('publish', options, async () => {
      debugKV.debug('[kv] Publishing to channel: {channel} (message length: {length})', {
        channel,
        length: message.length,
      });
      await this.#whenRedisReady();
      const result = await this.#redisClient.publish(channel, message);
      debugKV.debug('[kv] Publish result for channel {channel}: {result} subscriber(s)', { channel, result });
      return result;
    });
  }

  // --- Rate Limiting Methods (using rate-limiter-flexible) ---

  /**
   * The ids of rate limiters that count in this process only, because Redis was not ready when they
   * were made. Their limits are not shared with other replicas. A limiter leaves this list when
   * `getRateLimiter` rebuilds it on Redis after the connection is ready.
   */
  get degradedRateLimiters(): readonly string[] {
    const ids: string[] = [];
    for (const [id, entries] of this.#limiterInstances) {
      if (entries.some(entry => entry.backing === 'memory')) ids.push(id);
    }
    return ids;
  }

  /**
   * Gets or creates a RateLimiter instance with the specified options.
   *
   * @param id A unique identifier for this rate limiter configuration (e.g., 'login', 'api_global').
   * @param options Configuration options for the rate limiter (points, duration, etc.).
   *                See `rate-limiter-flexible` documentation for details.
   *                Defaults typically include `points` and `duration`.
   * @returns A RateLimiterAbstract instance ready to use (.consume, .get, etc.).
   *          While Redis is not ready this is a per-process `RateLimiterMemory`: a warning is logged,
   *          the id appears in {@link KV.degradedRateLimiters}, and the next call after Redis becomes
   *          ready returns a Redis-backed limiter instead.
   */
  getRateLimiter(id: string, options: Partial<IRateLimiterOptions>): RateLimiterAbstract {
    // A limiter is reused when `id` and `JSON.stringify(options)` both match. Most options hold
    // only primitives, so they are first compared field by field, which gives the same answer
    // without serialising the options on every call. JSON is the fallback for anything else.
    // This is the per-request path, so it logs nothing; creating a limiter does.
    const redisReady = this.#isRateLimiterReady && this.#redisClient.status === 'ready';
    const entries = this.#limiterInstances.get(id);
    if (entries) {
      const cached = findLimiter(entries, options);
      // A memory limiter is replaced once Redis is ready, so the degrade does not outlive the outage.
      if (cached && (cached.backing === 'redis' || !redisReady)) return cached.limiter;
    }

    debugLimiter.debug(
      '[limiter] No cached rate limiter, creating one (id: {id}, points: {points}, duration: {duration}s)',
      { id, points: options.points ?? 10, duration: options.duration ?? 60 },
    );

    let limiter: RateLimiterAbstract;
    const keyPrefix = `${this.namespace ? this.namespace + ':' : ''}${this.rateLimitPrefix}:${id}`;

    if (redisReady) {
      debugLimiter.debug('[limiter] Creating Redis rate limiter (id: {id}, prefix: {prefix})', {
        id,
        prefix: keyPrefix,
      });
      limiter = new RateLimiterRedis({
        storeClient: this.#redisClient,
        keyPrefix,
        points: options.points ?? 10, // Default points
        duration: options.duration ?? 60, // Default duration (seconds)
        ...options, // Allow overriding defaults and adding other options
      });
    } else {
      debugLimiter.warn(
        '[limiter] Redis is not ready, so rate limiter {id} counts in this process only and its limit is not shared across replicas (redis status: {redisStatus})',
        { id, redisStatus: this.#redisClient.status },
      );
      limiter = new RateLimiterMemory({
        keyPrefix,
        points: options.points ?? 10,
        duration: options.duration ?? 60,
        ...options,
      });
    }

    debugLimiter.debug('[limiter] Rate limiter created and cached for id: {id}', { id });
    const entry: LimiterEntry = {
      json: JSON.stringify(options),
      fields: primitiveFields(options),
      limiter,
      backing: redisReady ? 'redis' : 'memory',
    };
    if (entries) {
      const stale = findLimiter(entries, options);
      if (stale) entries.splice(entries.indexOf(stale), 1);
      entries.push(entry);
    } else {
      this.#limiterInstances.set(id, [entry]);
    }
    return limiter;
  }

  /**
   * Disconnects both Keyv and the Rate Limiter Redis client. Both disconnects are tried; a returned
   * {@link KvCloseFailed} names the first one that failed. `undefined` means both closed.
   */
  async close(): Promise<KvCloseFailed | undefined> {
    debugKV.debug('[kv] Closing KV instance');
    let failed: KvCloseFailed | undefined;

    try {
      debugKV.debug('[kv] Disconnecting Keyv store');
      await this.#within(this.#keyv.opts.store.disconnect?.());
      debugKV.debug('[kv] Keyv store disconnected');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      debugKV.warn('[kv] Error disconnecting Keyv store: {reason}', { reason });
      failed = KvCloseFailed({ target: 'store', reason });
    }

    try {
      debugLimiter.debug('[kv] Disconnecting rate limiter Redis client');
      // A connection that never came up (or is retrying) has nothing to flush, so it is dropped, not asked to quit.
      // ioredis reports `ready` for a moment after `quit` is answered, so a closed client is remembered here.
      if (this.#limiterClosed) debugLimiter.debug('[kv] Rate limiter Redis client was already closed');
      else if (this.#redisClient.status === 'ready') await this.#within(this.#redisClient.quit());
      else this.#redisClient.disconnect();
      this.#limiterClosed = true;
      debugLimiter.debug('[kv] Rate limiter Redis client disconnected');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      debugLimiter.warn('[kv] Error disconnecting rate limiter Redis client: {reason}', { reason });
      failed ??= KvCloseFailed({ target: 'limiter', reason });
    }

    if (debugLimiter.isEnabled('debug')) {
      let count = 0;
      for (const entries of this.#limiterInstances.values()) count += entries.length;
      debugLimiter.debug('[kv] Clearing {count} cached rate limiter instance(s)', { count });
    }
    this.#limiterInstances.clear();
    debugKV.debug('[kv] KV instance closed (failed: {failed})', { failed: failed?.code ?? 'no' });
    return failed;
  }
}

/** A cached limiter and the options it was built from: their JSON, and their fields when all are primitive. */
type LimiterEntry = {
  readonly json: string;
  readonly fields: readonly unknown[] | undefined;
  readonly limiter: RateLimiterAbstract;
  /** Where the limiter keeps its counts: `redis` is shared by every replica, `memory` is this process only. */
  readonly backing: 'redis' | 'memory';
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

/** The cached entry whose options serialise to the same JSON as `options`, if any. */
function findLimiter(entries: readonly LimiterEntry[], options: object): LimiterEntry | undefined {
  for (const entry of entries) {
    if (entry.fields !== undefined && sameFields(entry.fields, options)) return entry;
  }
  const json = JSON.stringify(options);
  for (const entry of entries) {
    if (entry.json === json) return entry;
  }
  return undefined;
}

/** What `getRateLimiter(...).consume()` rejects with when the limit is hit; check it with `instanceof`. */
export { RateLimiterRes } from 'rate-limiter-flexible';
export { KvCancelled, KvCloseFailed, KvUnavailable, KvValueInvalid } from './errors.js';

// Re-export factory functions
export { createKV, createRateLimitKV } from './factory.js';
