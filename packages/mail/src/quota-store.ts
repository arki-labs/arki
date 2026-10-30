/**
 * Where `failover` counts sends per transport per month. A quota is advisory: two replicas can
 * read the same count and both send. Atomic reservations are a later step (MAIL-QUOTAS).
 */
import { z } from 'zod';

import { log } from './log.js';

export type QuotaStore = {
  /** Sends counted for `transport` in `month` (`YYYY-MM`, UTC). */
  getSent(transport: string, month: string): Promise<number>;
  /** Counts one accepted send. */
  increment(transport: string, month: string): Promise<void>;
};

const memoryKey = (transport: string, month: string): string => `${transport}:${month}`;
const kvKey = (transport: string, month: string): string => `email:quota:${transport}:${month}`;

/** Counts in this process only; resets on restart. Right for one instance and for tests. */
export function inMemoryQuotaStore(): QuotaStore {
  const counts = new Map<string, number>();
  return {
    getSent: (transport, month) => Promise.resolve(counts.get(memoryKey(transport, month)) ?? 0),
    increment: (transport, month) => {
      const key = memoryKey(transport, month);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return Promise.resolve();
    },
  };
}

/**
 * The part of a key-value store `kvQuotaStore` needs. `@arki/kv` fits, so does a test double.
 * `get` returns `unknown`: the store checks it is a count instead of trusting a type argument.
 */
export type KVLike = {
  get(key: string): Promise<unknown>;
  set(key: string, value: number, ttlSeconds?: number): Promise<boolean>;
};

/** A stored count. Anything else (a missing key, a corrupt value) reads as 0. */
const countSchema = z.number().nonnegative();
const countOf = (value: unknown): number => {
  const parsed = countSchema.safeParse(value);
  return parsed.success ? parsed.data : 0;
};

/** Counters expire after 60 days, well past a month's end. */
const COUNTER_TTL_SECONDS = 60 * 24 * 60 * 60;

/**
 * Counts shared by every replica through a key-value store. Keys: `email:quota:{transport}:{month}`
 * (the prefix predates the package rename; changing it would reset live counters mid-month).
 */
export function kvQuotaStore(kv: KVLike): QuotaStore {
  return {
    getSent: async (transport, month) => countOf(await kv.get(kvKey(transport, month))),
    increment: async (transport, month) => {
      const key = kvKey(transport, month);
      const next = countOf(await kv.get(key)) + 1;
      const stored = await kv.set(key, next, COUNTER_TTL_SECONDS);
      if (!stored) log.warn('quota counter for {transport} in {month} was not stored', { transport, month });
    },
  };
}
