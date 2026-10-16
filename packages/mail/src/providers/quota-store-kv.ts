import type { QuotaStore } from './quota-store';
import { debugEmails } from '../debug';

/**
 * Minimal KV interface required by `kvQuotaStore`.
 *
 * Deliberately duck-typed so `@arki/mail` does not need a hard dependency on
 * `@arki/kv` (which pulls in Redis/ioredis). Any object that satisfies this
 * shape works — `@arki/kv`'s `KV` class, a custom Redis client, or a test mock.
 */
export interface KVLike {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<boolean>;
}

/**
 * A distributed quota store backed by any KV store that satisfies {@link KVLike}.
 *
 * Counters are stored under the key `email:quota:{provider}:{month}` and expire
 * after 60 days so stale entries are cleaned up automatically.
 *
 * Use this in multi-instance deployments (multiple server replicas) where the
 * default in-memory store would give each instance an independent counter.
 *
 * @example With `@arki/kv`
 * ```ts
 * import { kvQuotaStore } from '@arki/mail';
 * import { kv } from './kv';
 *
 * const router = quotaRouter(
 *   [resendProvider({ apiKey, quotaPerMonth: 3_000 })],
 *   { store: kvQuotaStore(kv) },
 * );
 * ```
 */
export function kvQuotaStore(kv: KVLike): QuotaStore {
  // Keys expire after 60 days — comfortably beyond a calendar month rollover.
  const TTL_SECONDS = 60 * 24 * 60 * 60; // 60 days

  function key(provider: string, month: string): string {
    return `email:quota:${provider}:${month}`;
  }

  return {
    async getSent(provider, month): Promise<number> {
      const k = key(provider, month);
      const value = await kv.get<number>(k);
      debugEmails.debug('[kv-quota-store] getSent provider={provider} month={month} → {value3}', {
        provider,
        month,
        value3: value ?? 0,
      });
      return value ?? 0;
    },

    async increment(provider, month): Promise<void> {
      const k = key(provider, month);
      const current = (await kv.get<number>(k)) ?? 0;
      await kv.set(k, current + 1, TTL_SECONDS);
      debugEmails.debug('[kv-quota-store] increment provider={provider} month={month}: {current} → {value4}', {
        provider,
        month,
        current,
        value4: current + 1,
      });
    },
  };
}
