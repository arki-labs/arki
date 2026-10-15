/**
 * The memory hand-off under churn: seeded random mixes of tryRun, waits and aborts never show two holders or strand a reservation.
 */
import { describe, expect, it } from 'vitest';

import type { Duration, Grant, Store } from './types.js';
import { LockError } from './errors.js';
import { createKey } from './key.js';
import { createLocks } from './locks.js';
import { memoryStore } from './memory.js';

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

/** Deterministic PRNG so a failing seed can be replayed. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D_2B_79_F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const codeOf = (error: unknown): string => (error instanceof LockError ? error.code : String(error));

describe('memory hand-off under churn', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    it(`mutex seed ${seed}: never two holders, and the key ends free (no stranded reservation)`, async () => {
      const random = rng(seed);
      const store = memoryStore();
      const locks = createLocks({ store, namespace: 'r' });
      const handle = locks.mutex('m');
      let inside = 0;
      let maxInside = 0;
      const tasks: Promise<unknown>[] = [];
      for (let index = 0; index < 120; index++) {
        const roll = random();
        const controller = new AbortController();
        const work = async (): Promise<void> => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await sleep(Math.floor(random() * 3));
          inside -= 1;
        };
        let task: Promise<unknown>;
        if (roll < 0.2) task = handle.tryRun(work);
        else if (roll < 0.5) task = handle.run(work, { wait: Math.floor(random() * 15), signal: controller.signal });
        else task = handle.run(work, { wait: '2s', signal: controller.signal });
        if (random() < 0.3) setTimeout(() => controller.abort(), Math.floor(random() * 20));
        tasks.push(task.catch(codeOf));
        if (random() < 0.3) await sleep(Math.floor(random() * 3));
      }
      const outcomes = await Promise.all(tasks);
      const codes = outcomes.filter(outcome => typeof outcome === 'string');
      for (const code of codes) expect(['held', 'aborted']).toContain(code);
      expect(maxInside).toBe(1);
      expect(store.peek(createKey('r', 'm'))).toBeUndefined();
      // A stranded reservation would refuse every newcomer forever.
      expect(await handle.tryRun(() => 'free')).toEqual({ ran: true, value: 'free' });
    });

    it(`semaphore seed ${seed}: never over the limit, and every permit comes back`, async () => {
      const random = rng(seed * 7);
      const store = memoryStore();
      const locks = createLocks({ store, namespace: 'r' });
      const handle = locks.semaphore('s', { limit: 4 });
      let used = 0;
      let maxUsed = 0;
      const tasks: Promise<unknown>[] = [];
      for (let index = 0; index < 120; index++) {
        const weight = 1 + Math.floor(random() * 4);
        const controller = new AbortController();
        const work = async (): Promise<void> => {
          used += weight;
          maxUsed = Math.max(maxUsed, used);
          await sleep(Math.floor(random() * 3));
          used -= weight;
        };
        const roll = random();
        let task: Promise<unknown>;
        if (roll < 0.2) task = handle.tryRun(work, { weight });
        else
          task = handle.run(work, {
            weight,
            wait: roll < 0.5 ? Math.floor(random() * 15) : '3s',
            signal: controller.signal,
          });
        if (random() < 0.3) setTimeout(() => controller.abort(), Math.floor(random() * 20));
        tasks.push(task.catch(codeOf));
        if (random() < 0.3) await sleep(Math.floor(random() * 3));
      }
      await Promise.all(tasks);
      expect(maxUsed).toBeLessThanOrEqual(4);
      expect(store.peek(createKey('r', 's', 'semaphore'))).toBeUndefined();
      expect(await handle.tryRun(() => 'free', { weight: 4 })).toEqual({ ran: true, value: 'free' });
    });

    it(`read/write seed ${seed}: a writer is always alone, and the key ends free`, async () => {
      const random = rng(seed * 13);
      const store = memoryStore();
      const locks = createLocks({ store, namespace: 'r' });
      const rw = locks.readWrite('w');
      let readers = 0;
      let writers = 0;
      let violations = 0;
      const tasks: Promise<unknown>[] = [];
      for (let index = 0; index < 120; index++) {
        const write = random() < 0.35;
        const controller = new AbortController();
        const work = async (): Promise<void> => {
          if (write) writers += 1;
          else readers += 1;
          if (writers > 1 || (writers === 1 && readers > 0)) violations += 1;
          await sleep(Math.floor(random() * 3));
          if (write) writers -= 1;
          else readers -= 1;
        };
        const side = write ? rw.write : rw.read;
        const roll = random();
        let task: Promise<unknown>;
        if (roll < 0.2) task = side.tryRun(work);
        else task = side.run(work, { wait: roll < 0.5 ? Math.floor(random() * 15) : '3s', signal: controller.signal });
        if (random() < 0.3) setTimeout(() => controller.abort(), Math.floor(random() * 20));
        tasks.push(task.catch(codeOf));
        if (random() < 0.3) await sleep(Math.floor(random() * 3));
      }
      await Promise.all(tasks);
      expect(violations).toBe(0);
      expect(store.peek(createKey('r', 'w', 'readWrite'))).toBeUndefined();
      expect(await rw.write.tryRun(() => 'free')).toEqual({ ran: true, value: 'free' });
    });
  }
});

describe('memory hand-off edges through the manager', () => {
  it('a waiter whose deadline passes while it is queued leaves no reservation behind', async () => {
    const store = memoryStore();
    const locks = createLocks({ store, namespace: 'r' });
    const holder = await locks.mutex('d').acquire();
    const late = locks
      .mutex('d')
      .run(() => 'late', { wait: 20 })
      .catch(codeOf);
    const patient = locks.mutex('d').run(() => 'patient', { wait: '2s' });
    expect(await late).toBe('held');
    await holder.release();
    expect(await patient).toBe('patient');
    expect(await locks.mutex('d').tryRun(() => 'free')).toEqual({ ran: true, value: 'free' });
  });

  it('a woken waiter aborted in the same turn as the release passes the lock on', async () => {
    const store = memoryStore();
    const locks = createLocks({ store, namespace: 'r' });
    const holder = await locks.mutex('a').acquire();
    const controller = new AbortController();
    const first = locks
      .mutex('a')
      .run(() => 'first', { wait: '2s', signal: controller.signal })
      .catch(codeOf);
    const second = locks.mutex('a').run(() => 'second', { wait: '2s' });
    await sleep(5);
    // Release reserves for `first`; it aborts before its retry can run.
    const released = holder.release();
    controller.abort();
    await released;
    expect(await first).toBe('aborted');
    expect(await second).toBe('second');
    expect(await locks.mutex('a').tryRun(() => 'free')).toEqual({ ran: true, value: 'free' });
  });

  it('tryRun is refused while a release is reserved for a queued waiter (FIFO kept)', async () => {
    const store = memoryStore();
    const locks = createLocks({ store, namespace: 'r' });
    const holder = await locks.mutex('f').acquire();
    const waiting = locks.mutex('f').run(() => 'waiter', { wait: '2s' });
    await sleep(5);
    await holder.release();
    expect(await locks.mutex('f').tryRun(() => 'barger')).toEqual({ ran: false });
    expect(await waiting).toBe('waiter');
  });

  it('an invalid holdAtLeast must not leave the key held by nobody', async () => {
    const store = memoryStore();
    const locks = createLocks({ store, namespace: 'r' });
    const error = await locks
      .mutex('h')
      .run(() => 'never', { holdAtLeast: 'bogus' as Duration })
      .catch(codeOf);
    expect(error).toBe('config');
    expect(await locks.mutex('h').tryRun(() => 'free')).toEqual({ ran: true, value: 'free' });
  });
});

describe('lazy ctx.signal', () => {
  it('a loss reported before the callback reads ctx.signal still shows as an aborted signal with the lost error', async () => {
    const inner = memoryStore();
    const store: Store = {
      name: 'lossy',
      guarantees: { ...inner.guarantees, shared: false, permits: false, writerPreference: false },
      async acquire(key, req) {
        const grant = await inner.acquire(key, { token: req.token });
        if (grant === undefined) return;
        const lost = Promise.resolve(new LockError({ code: 'lost', message: 'gone', remediation: 'none' }));
        return { ...grant, lost } satisfies Grant;
      },
      release: grant => inner.release(grant),
    };
    const locks = createLocks({ store, namespace: 'r' });
    const result = await locks.mutex('l').run(
      async ctx => {
        await sleep(5);
        return { aborted: ctx.signal.aborted, code: codeOf(ctx.signal.reason) };
      },
      { wait: '1s', onLost: 'ignore' },
    );
    expect(result).toEqual({ aborted: true, code: 'lost' });
  });
});
