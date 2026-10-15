import { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createKey } from '../key.js';
import { redisKeys, redisStore } from './index.js';
import { ACQUIRE, EXTEND, RELEASE } from './scripts.js';

// `lazyConnect` means no socket is ever opened: these tests need no Redis.
const clients: Redis[] = [];
function offlineClient(): Redis {
  const client = new Redis({ lazyConnect: true });
  clients.push(client);
  return client;
}

afterEach(() => {
  for (const client of clients.splice(0)) client.disconnect();
  vi.restoreAllMocks();
});

describe('redisStore (no server)', () => {
  it('claims exactly what a Redis lease store delivers, so the types never promise a durable fence or an instant crash release', () => {
    const store = redisStore(offlineClient(), { ttl: '30s' });
    expect(store.guarantees).toMatchObject({
      kind: 'lease',
      scope: 'cluster',
      wait: 'wake',
      shared: false,
      permits: false,
      fence: 'best-effort',
      releasedOnCrash: 'after-ttl',
      clock: 'store',
      poolerSafe: true,
    });
    expect(store.guarantees.runtimes).toEqual(['node', 'bun', 'deno']);
  });

  it('exposes the configured lease length so the manager renews at a third of it', () => {
    expect(redisStore(offlineClient(), { ttl: '30s' }).ttlMs).toBe(30_000);
  });

  it.each([0, 0.5, '0ms'] as const)('rejects ttl %s, because a lease that expires at once can never be held', ttl => {
    expect(() => redisStore(offlineClient(), { ttl })).toThrowError(expect.objectContaining({ code: 'config' }));
  });

  it('reports wait "poll" when pub/sub is switched off, so callers know waits are not instant', () => {
    expect(redisStore(offlineClient(), { ttl: '30s', wake: 'poll' }).guarantees.wait).toBe('poll');
  });

  it('puts the lock, fence counter and wake channel in one cluster slot, so one Lua step can touch all of them', () => {
    const keys = redisKeys(createKey('ns', 'job'));
    const tags = Object.values(keys).map(name => /\{([^}]*)\}/.exec(name)?.[1]);
    expect(new Set(tags).size).toBe(1);
    expect(tags[0]).toBe('1:2:ns:3:job');
    expect(keys.lock).toBe('{1:2:ns:3:job}');
  });

  it('keeps two different names in two different slots, so unrelated locks do not share a hot key', () => {
    expect(redisKeys(createKey('ns', 'a')).lock).not.toBe(redisKeys(createKey('ns', 'b')).lock);
  });

  it('opens no second connection until someone waits, so an uncontended app holds one connection', async () => {
    const client = offlineClient();
    const duplicate = vi.spyOn(client, 'duplicate');
    const store = redisStore(client, { ttl: '30s' });
    await store.dispose?.();
    expect(duplicate).not.toHaveBeenCalled();
  });

  it('does not use DELEX, because the supported floor is Redis 7', () => {
    for (const source of [ACQUIRE, RELEASE, EXTEND]) expect(source).not.toMatch(/DELEX/i);
  });

  it('bumps the fence in the same step as the win, so a fence can never be taken without the lock', () => {
    expect(ACQUIRE.indexOf("'NX'")).toBeLessThan(ACQUIRE.indexOf('INCR'));
    expect(ACQUIRE).toMatch(/TIME/);
  });

  it('compares the token before it deletes or extends, so a stale owner cannot touch a newer lock', () => {
    expect(RELEASE).toMatch(/GET.*== ARGV\[1\]/);
    expect(EXTEND).toMatch(/GET.*== ARGV\[1\]/);
  });
});
