/**
 * Quota counters shared through a key-value store. Why: replicas must see one count, and a
 * counter that was not stored must be visible in the logs, not silently believed.
 */
import { describe, expect, it, vi } from 'vitest';

import type { KVLike } from './quota-store.js';
import { kvQuotaStore } from './quota-store.js';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('./log.js', () => ({ log: { warn, debug: vi.fn() }, errorField: (error: unknown) => error }));

/** A KV double over a Map; `set` can be told to fail. */
function memoryKv(options: { failSet?: boolean } = {}) {
  const values = new Map<string, number>();
  const kv: KVLike = {
    get: key => Promise.resolve(values.get(key)),
    set: (key, value) => {
      if (options.failSet === true) return Promise.resolve(false);
      values.set(key, value);
      return Promise.resolve(true);
    },
  };
  return { kv, values };
}

describe('kvQuotaStore', () => {
  it('counts per transport and month under the existing email:quota keys', async () => {
    const { kv, values } = memoryKv();
    const store = kvQuotaStore(kv);
    await store.increment('resend', '2026-10');
    await store.increment('resend', '2026-10');
    expect(await store.getSent('resend', '2026-10')).toBe(2);
    expect(await store.getSent('ses', '2026-10')).toBe(0);
    expect(values.get('email:quota:resend:2026-10')).toBe(2);
  });

  it('a counter the store refused to keep is logged', async () => {
    const store = kvQuotaStore(memoryKv({ failSet: true }).kv);
    await store.increment('resend', '2026-10');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('was not stored'), {
      transport: 'resend',
      month: '2026-10',
    });
    expect(await store.getSent('resend', '2026-10')).toBe(0);
  });
});
