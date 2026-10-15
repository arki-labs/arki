/**
 * `@arki/lock/redis`: a lease store on one Redis (ioredis).
 *
 * - Keys are hash-tagged `{<full>}` so the lock, its fence counter and its
 *   wake channel always sit in one cluster slot.
 * - Acquire is one Lua step: `SET NX PX` plus `INCR` of the fence counter.
 *   Release and extend compare the token on the server.
 * - Waiters sleep on pub/sub (`wait: 'wake'`). If subscribing fails, or you
 *   ask for `wake: 'poll'`, they poll with backoff instead (`wait: 'poll'`).
 * - The fence is best-effort: the counter is lost on a restart or failover
 *   that drops data, so a fence may repeat after that. Use a durable store
 *   when the protected resource must reject stale writers.
 */
import type { Redis } from 'ioredis';
import { z } from 'zod';

import { getLogger } from '@arki/log';

import type { AcquireRequest, Duration, Grant, Guarantees, Key, ReleaseOutcome, Store } from '../types.js';
import type { Script } from './scripts.js';
import { LockError } from '../errors.js';
import { backoffDelay, parseDuration } from '../wait.js';
import { acquireScript, extendScript, releaseScript } from './scripts.js';

const log = getLogger('arki:lock');

export type RedisStoreOptions = {
  /** Lease length. The manager renews at a third of it. */
  readonly ttl: Duration;
  /**
   * `'pubsub'` (default): waiters wake on release through a second connection.
   * `'poll'`: no second connection; waiters poll with backoff.
   */
  readonly wake?: 'pubsub' | 'poll';
};

export type RedisGuarantees = {
  readonly kind: 'lease';
  readonly scope: 'cluster';
  /** `'wake'` while pub/sub works, `'poll'` once it has failed or was switched off. */
  readonly wait: 'wake' | 'poll';
  readonly shared: false;
  readonly permits: false;
  readonly fence: 'best-effort';
  readonly releasedOnCrash: 'after-ttl';
  readonly clock: 'store';
  readonly poolerSafe: true;
  readonly runtimes: readonly ('node' | 'bun' | 'deno')[];
};

export type RedisStore = Store<RedisGuarantees> & {
  /** Resolves when the key looks free, or when `signal` aborts. */
  waitFor(key: Key, signal: AbortSignal): Promise<void>;
};

/** The three Redis keys of one lock. They share the hash tag, so they share a cluster slot. */
export function redisKeys(key: Key): { readonly lock: string; readonly fence: string; readonly channel: string } {
  const tag = `{${key.full}}`;
  return { lock: tag, fence: `${tag}:fence`, channel: `${tag}:free` };
}

const acquireReply = z.tuple([z.number(), z.number()]);
const flagReply = z.union([z.literal(0), z.literal(1)]);

/** Read again after an await: TypeScript still thinks the signal is the way it was before. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function noop(): void {
  // A failed cleanup has nobody to tell.
}

function isNoScript(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('NOSCRIPT');
}

type Channel = { readonly waiters: Set<() => void>; readonly ready: Promise<void> };

export function redisStore(client: Redis, options: RedisStoreOptions): RedisStore {
  const ttlMs = parseDuration(options.ttl);
  if (!Number.isInteger(ttlMs) || ttlMs < 1) {
    throw new LockError({
      code: 'config',
      message: `redis ttl must be a whole number of milliseconds, at least 1 (got ${ttlMs})`,
      remediation: "Pass a ttl such as '30s'.",
    });
  }

  let mode: 'wake' | 'poll' = options.wake === 'poll' ? 'poll' : 'wake';
  const guarantees: RedisGuarantees = {
    kind: 'lease',
    scope: 'cluster',
    // Read on every use: a failed subscribe downgrades the store, and the guarantee must say so.
    get wait() {
      return mode;
    },
    shared: false,
    permits: false,
    fence: 'best-effort',
    releasedOnCrash: 'after-ttl',
    clock: 'store',
    poolerSafe: true,
    runtimes: ['node', 'bun', 'deno'],
  } satisfies Guarantees;

  /** EVALSHA first (small on the wire), EVAL when the server has not cached the script yet. */
  async function run(script: Script, keys: readonly string[], args: readonly (string | number)[]): Promise<unknown> {
    try {
      return await client.evalsha(script.sha, keys.length, ...keys, ...args);
    } catch (error) {
      if (!isNoScript(error)) throw error;
      return client.eval(script.source, keys.length, ...keys, ...args);
    }
  }

  // ---- wake-ups -----------------------------------------------------------

  let subscriber: Redis | undefined;
  const channels = new Map<string, Channel>();

  function subscriberConnection(): Redis {
    if (subscriber !== undefined) return subscriber;
    const sub = client.duplicate();
    sub.on('error', (error: Error) => {
      log.debug('redis lock subscriber error: {message}', { message: error.message });
    });
    sub.on('message', (channel: string) => {
      const entry = channels.get(channel);
      if (entry === undefined) return;
      for (const wake of entry.waiters) wake();
    });
    subscriber = sub;
    return sub;
  }

  function join(channel: string, wake: () => void): Channel {
    const existing = channels.get(channel);
    if (existing !== undefined) {
      existing.waiters.add(wake);
      return existing;
    }
    const created: Channel = { waiters: new Set([wake]), ready: subscriberConnection().subscribe(channel).then(noop) };
    channels.set(channel, created);
    return created;
  }

  function leave(channel: string, wake: () => void): void {
    const entry = channels.get(channel);
    if (entry === undefined) return;
    entry.waiters.delete(wake);
    if (entry.waiters.size > 0) return;
    channels.delete(channel);
    subscriber?.unsubscribe(channel).then(noop, noop);
  }

  async function isFree(lock: string): Promise<boolean> {
    return (await client.exists(lock)) === 0;
  }

  /** Poll with the core's backoff until the key is free or `signal` aborts. */
  async function pollUntilFree(lock: string, signal: AbortSignal): Promise<void> {
    for (let attempt = 0; !signal.aborted; attempt++) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, backoffDelay(attempt));
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      if (isAborted(signal) || (await isFree(lock))) return;
    }
  }

  async function waitFor(key: Key, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const { lock, channel } = redisKeys(key);
    if (mode === 'poll') return pollUntilFree(lock, signal);

    let wake: () => void = noop;
    const woken = new Promise<void>(resolve => {
      wake = resolve;
    });
    signal.addEventListener('abort', wake, { once: true });
    try {
      // Join first, check after: a release between the failed attempt and the
      // subscribe is caught by the check, one after it by the message.
      // Raced with `woken`: a subscribe stuck in ioredis's offline queue must not outlive an abort.
      await Promise.race([join(channel, wake).ready, woken]);
      if (isAborted(signal) || (await isFree(lock))) return;
      await woken;
    } catch (error) {
      if (isAborted(signal)) return;
      log.debug('redis pub/sub wake-up failed ({message}); polling from now on', {
        message: error instanceof Error ? error.message : String(error),
      });
      mode = 'poll';
      await pollUntilFree(lock, signal);
    } finally {
      signal.removeEventListener('abort', wake);
      leave(channel, wake);
    }
  }

  // ---- the store port -----------------------------------------------------

  return {
    name: 'redis',
    guarantees,
    ttlMs,
    async acquire(key: Key, req: AcquireRequest): Promise<Grant | undefined> {
      // A closed client never sent anything, so we can say for sure that nothing was acquired.
      // An error after the send stays a plain failure: the manager reports that as `unknown`.
      if (client.status === 'end') {
        throw new LockError({
          code: 'store',
          message: 'the redis connection is closed',
          remediation: 'Create a new client; this one was disconnected on purpose or gave up reconnecting.',
          outcome: 'not-acquired',
          method: 'acquire',
        });
      }
      const { lock, fence } = redisKeys(key);
      const lease = req.ttlMs ?? ttlMs;
      const [fenceValue, nowMs] = acquireReply.parse(await run(acquireScript, [lock, fence], [req.token, lease]));
      if (fenceValue === 0) return undefined;
      return { key, token: req.token, fence: BigInt(fenceValue), expiresAt: nowMs + lease };
    },
    async release(grant: Grant): Promise<ReleaseOutcome> {
      const { lock, channel } = redisKeys(grant.key);
      return flagReply.parse(await run(releaseScript, [lock], [grant.token, channel])) === 1 ? 'released' : 'not-owner';
    },
    async extend(grant: Grant, leaseMs: number): Promise<boolean> {
      const { lock } = redisKeys(grant.key);
      return flagReply.parse(await run(extendScript, [lock], [grant.token, leaseMs])) === 1;
    },
    waitFor,
    dispose(): Promise<void> {
      const sub = subscriber;
      subscriber = undefined;
      channels.clear();
      if (sub !== undefined) {
        // The caller's own client stays open; only the connection we made goes.
        sub.disconnect();
        log.debug('redis lock subscriber closed');
      }
      return Promise.resolve();
    },
  };
}
