/**
 * Abstraction over where email quota usage counters are stored.
 *
 * The default (`inMemoryQuotaStore`) keeps counts in a process-local Map
 * which resets on restart. For multi-instance deployments (e.g. multiple
 * Coolify replicas), provide a distributed store backed by Redis/KV so all
 * instances share the same counter.
 *
 * @example Bring-your-own KV store
 * ```ts
 * import type { QuotaStore } from '@arki/emails';
 * import { kv } from '@arki/kv';
 *
 * function kvQuotaStore(): QuotaStore {
 *   return {
 *     async getSent(provider, month) {
 *       return (await kv.get<number>(`email:quota:${provider}:${month}`)) ?? 0;
 *     },
 *     async increment(provider, month) {
 *       const key = `email:quota:${provider}:${month}`;
 *       await kv.set(key, ((await kv.get<number>(key)) ?? 0) + 1);
 *     },
 *   };
 * }
 * ```
 */
export type QuotaStore = {
  /**
   * Return how many emails have been sent via `provider` in `month`.
   *
   * @param provider - Provider name (e.g. `'resend'`).
   * @param month    - Calendar-month key, e.g. `'2026-2'`.
   */
  getSent(provider: string, month: string): Promise<number>;

  /**
   * Record one successful send for `provider` in `month`.
   */
  increment(provider: string, month: string): Promise<void>;
};

type Entry = { month: string; sent: number };

/**
 * Default in-process quota store.
 *
 * Counters reset automatically when the month changes (the old key is
 * overwritten on the first send of the new month). In single-instance
 * deployments this is accurate; for multi-instance deployments, replace it
 * with a distributed store.
 */
export function inMemoryQuotaStore(): QuotaStore {
  const data = new Map<string, Entry>();

  return {
    async getSent(provider, month): Promise<number> {
      const entry = data.get(provider);
      return entry?.month === month ? entry.sent : 0;
    },

    async increment(provider, month): Promise<void> {
      const prev = data.get(provider);
      data.set(provider, {
        month,
        sent: prev?.month === month ? prev.sent + 1 : 1,
      });
    },
  };
}
