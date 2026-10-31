/**
 * Quota counters shared through a key-value store. Why: replicas must see one count, and a
 * counter that was not stored must be visible in the logs, not silently believed.
 */
import { describe, expect, it, vi } from 'vitest';

import { z } from 'zod';

import { defineFailure, isFailure, orThrow } from '@arki/failure';

import type { KVLike } from './quota-store.js';
import { kvQuotaStore } from './quota-store.js';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('./log.js', () => ({ log: { warn, debug: vi.fn() }, errorField: (error: unknown) => error }));

/** What `@arki/kv` returns when Redis is down. */
const KvDown = defineFailure('test.kv_down', {
  status: 503,
  data: z.object({ command: z.string() }),
  message: ({ command }) => `KV ${command} did not complete`,
  remediation: 'Retry later.',
});

/** A KV double over a Map; `set` can be told to fail with a refusal, `down` makes every command return a failure. */
function memoryKv(options: { failSet?: boolean; down?: boolean } = {}) {
  const values = new Map<string, number>();
  const kv: KVLike = {
    get: (key, schema) => {
      if (options.down === true) return Promise.resolve(KvDown({ command: 'get' }));
      const parsed = schema.safeParse(values.get(key));
      return Promise.resolve(parsed.success ? parsed.data : undefined);
    },
    set: (key, value) => {
      if (options.down === true) return Promise.resolve(KvDown({ command: 'set' }));
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
    await orThrow(store.increment('resend', '2026-10'));
    await orThrow(store.increment('resend', '2026-10'));
    expect(await store.getSent('resend', '2026-10')).toBe(2);
    expect(await store.getSent('ses', '2026-10')).toBe(0);
    expect(values.get('email:quota:resend:2026-10')).toBe(2);
  });

  it('a counter the store refused to keep is logged', async () => {
    const store = kvQuotaStore(memoryKv({ failSet: true }).kv);
    await orThrow(store.increment('resend', '2026-10'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('was not stored'), {
      transport: 'resend',
      month: '2026-10',
    });
    expect(await store.getSent('resend', '2026-10')).toBe(0);
  });

  it('a store that is down returns the failure instead of a made-up count, so failover can decide', async () => {
    const store = kvQuotaStore(memoryKv({ down: true }).kv);
    expect(isFailure(await store.getSent('resend', '2026-10'))).toBe(true);
    expect(isFailure(await store.increment('resend', '2026-10'))).toBe(true);
  });
});
