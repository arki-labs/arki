import { describe, expect, it } from 'vitest';

import { createKey } from './key.js';
import { createLocks } from './locks.js';
import { memoryStore } from './memory.js';

const key = createKey('t', 'job');

async function grab(store: ReturnType<typeof memoryStore>, token: string) {
  const grant = await store.acquire(key, { token });
  if (grant === undefined) throw new Error(`expected ${token} to get the lock`);
  return grant;
}

describe('memoryStore', () => {
  it('wakes waiters in the order they began to wait, so contended jobs run first come, first served', async () => {
    const locks = createLocks({ store: memoryStore(), namespace: 't' });
    const holder = await locks.mutex('job').acquire();
    const order: string[] = [];
    const waiters = ['a', 'b', 'c'].map(async name => {
      await locks.mutex('job').run(
        () => {
          order.push(name);
        },
        { wait: '5s' },
      );
    });
    // Let all three reach their wait before the holder lets go.
    await new Promise(resolve => setTimeout(resolve, 20));
    await holder.release();
    await Promise.all(waiters);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('hands out strictly increasing fences, so a stale holder can always be told apart from the newest one', async () => {
    const store = memoryStore();
    const fences: bigint[] = [];
    for (const token of ['one', 'two', 'three']) {
      const grant = await grab(store, token);
      if (grant.fence === undefined) throw new Error('memory grants carry a fence');
      fences.push(grant.fence);
      await store.release(grant);
    }
    expect(fences[1]).toBeGreaterThan(fences[0] ?? 0n);
    expect(fences[2]).toBeGreaterThan(fences[1] ?? 0n);
  });

  it('refuses a second holder and a release by the wrong owner, so only the real owner can free the key', async () => {
    const store = memoryStore();
    const grant = await grab(store, 'owner');
    expect(await store.acquire(key, { token: 'other' })).toBeUndefined();
    expect(await store.release({ ...grant, token: 'imposter' })).toBe('not-owner');
    expect(store.peek(key)?.owner).toBe('owner');
    expect(await store.release(grant)).toBe('released');
    expect(await store.release(grant)).toBe('not-owner');
    expect(store.peek(key)).toBeUndefined();
  });

  it('peek shows the holder as a copy, so tests and debugging can look without touching the lock', async () => {
    const store = memoryStore();
    expect(store.peek(key)).toBeUndefined();
    const grant = await grab(store, 'owner');
    const first = store.peek(key);
    expect(first).toEqual({ owner: 'owner', fence: grant.fence });
    expect(store.peek(key)).not.toBe(first);
  });

  it('stops waiting when the signal aborts, so an aborted caller leaves no waiter behind', async () => {
    const store = memoryStore();
    await grab(store, 'owner');
    const controller = new AbortController();
    const waiting = store.waitFor(key, controller.signal);
    controller.abort();
    await expect(waiting).resolves.toBeUndefined();
  });
});
