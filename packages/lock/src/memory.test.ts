import { isFailure } from '@arki/failure';
import { lockTokenSchema, lockFenceSchema } from './identity-schemas.js';
import { describe, expect, it } from 'vitest';

import { orThrow } from '@arki/failure';

import type { MemoryGuarantees } from './memory.js';
import type { Grant, Store } from './types.js';
import { LockError, LockHeld } from './errors.js';
import { createKey } from './key.js';
import { createLocks } from './locks.js';
import { memoryStore } from './memory.js';
import { ContractSkip, defineCase, storeContract } from './testing/contract.js';

const key = createKey('t', 'job');

async function grab(store: ReturnType<typeof memoryStore>, token: string) {
  const grant = orThrow(await store.acquire(key, { token: lockTokenSchema.parse(token) }));
  if (grant === undefined) throw new Error(`expected ${token} to get the lock`);
  return grant;
}

describe('memoryStore', () => {
  it('wakes waiters in the order they began to wait, so contended jobs run first come, first served', async () => {
    const locks = createLocks({ store: memoryStore(), namespace: 't' });
    const holder = await orThrow(locks.mutex('job').acquire());
    const order: string[] = [];
    const waiters = ['a', 'b', 'c'].map(async name => {
      await orThrow(
        locks.mutex('job').run(
          () => {
            order.push(name);
          },
          { wait: '5s' },
        ),
      );
    });
    // Let all three reach their wait before the holder lets go.
    await new Promise(resolve => setTimeout(resolve, 20));
    orThrow(await holder.release());
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
    expect(await store.acquire(key, { token: lockTokenSchema.parse('other') })).toBeUndefined();
    expect(await store.release({ ...grant, token: lockTokenSchema.parse('imposter') })).toBe('not-owner');
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
    expect(first).toEqual({ owner: 'owner', fence: lockFenceSchema.parse(grant.fence) });
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

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const semKey = createKey('t', 'pool', 'semaphore');
const rwKey = createKey('t', 'catalog', 'readWrite');

const req = (token: string, weight: number) => ({ token: lockTokenSchema.parse(token), limit: 3, weight });

describe('memoryStore semaphore', () => {
  it('counts weights against the limit and frees them on release, so the pool never over-commits', async () => {
    const store = memoryStore();
    const a = orThrow(await store.permits.acquire(semKey, req('a', 2)));
    expect(a).toBeDefined();
    expect(await store.permits.acquire(semKey, req('b', 2))).toBeUndefined();
    const c = orThrow(await store.permits.acquire(semKey, req('c', 1)));
    expect(c).toBeDefined();
    expect(store.peek(semKey)).toMatchObject({ owner: 'a', permits: 3, holders: 2 });
    if (a === undefined || c === undefined) throw new Error('unreachable');
    expect(await store.permits.release({ ...a, token: lockTokenSchema.parse('imposter') })).toBe('not-owner');
    expect(await store.permits.release(a)).toBe('released');
    expect(await store.permits.release(a)).toBe('not-owner');
    expect(store.peek(semKey)).toMatchObject({ owner: 'c', permits: 1, holders: 1 });
    await store.permits.release(c);
    expect(store.peek(semKey)).toBeUndefined();
  });

  it('remembers the limit only while someone holds, so a conflicting limit fails and a drained key takes a new one', async () => {
    const store = memoryStore();
    const first = orThrow(await store.permits.acquire(semKey, { token: lockTokenSchema.parse('a'), limit: 2, weight: 1 }));
    await expect(store.permits.acquire(semKey, { token: lockTokenSchema.parse('b'), limit: 3, weight: 1 })).rejects.toMatchObject({
      code: 'config',
    });
    await expect(store.permits.acquire(semKey, { token: lockTokenSchema.parse('b'), limit: 3, weight: 1 })).rejects.toBeInstanceOf(LockError);
    if (first === undefined) throw new Error('unreachable');
    await store.permits.release(first);
    expect(await store.permits.acquire(semKey, { token: lockTokenSchema.parse('b'), limit: 3, weight: 3 })).toBeDefined();
  });

  it('wakes waiters first come, first served', async () => {
    const locks = createLocks({ store: memoryStore(), namespace: 't' });
    const pool = locks.semaphore('pool', { limit: 1 });
    const holder = await orThrow(pool.acquire());
    const order: string[] = [];
    const waiters = ['a', 'b', 'c'].map(name =>
      orThrow(
        pool.run(
          () => {
            order.push(name);
          },
          { wait: '5s' },
        ),
      ),
    );
    await sleep(20);
    orThrow(await holder.release());
    await Promise.all(waiters);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('lets a light waiter pass a heavy one, because there is no head-of-line reservation', async () => {
    const locks = createLocks({ store: memoryStore(), namespace: 't' });
    const pool = locks.semaphore('pool', { limit: 2 });
    const holder = await orThrow(pool.acquire({ weight: 1 }));
    const ran: string[] = [];
    const heavy = pool.run(() => void ran.push('heavy'), { wait: '5s', weight: 2 });
    await sleep(10);
    await orThrow(pool.run(() => void ran.push('light'), { wait: '5s', weight: 1 }));
    expect(ran).toEqual(['light']);
    orThrow(await holder.release());
    expect(await heavy).toBeUndefined();
    expect(ran).toEqual(['light', 'heavy']);
  });
});

describe('memoryStore read/write', () => {
  it('lets readers overlap and makes a writer exclusive, with fences from one counter', async () => {
    const store = memoryStore();
    const r1 = orThrow(await store.shared.acquire(rwKey, { token: lockTokenSchema.parse('r1'), mode: 'read' }));
    const r2 = orThrow(await store.shared.acquire(rwKey, { token: lockTokenSchema.parse('r2'), mode: 'read' }));
    expect(r1 && r2).toBeTruthy();
    expect(store.peek(rwKey)).toMatchObject({ owner: 'r1', mode: 'read', holders: 2 });
    expect(await store.shared.acquire(rwKey, { token: lockTokenSchema.parse('w'), mode: 'write' })).toBeUndefined();
    if (r1 === undefined || r2 === undefined) throw new Error('unreachable');
    expect(r2.fence).toBeGreaterThan(r1.fence ?? 0n);
    await store.shared.release(r1);
    await store.shared.release(r2);
    const w = orThrow(await store.shared.acquire(rwKey, { token: lockTokenSchema.parse('w'), mode: 'write' }));
    expect(w).toBeDefined();
    expect(store.peek(rwKey)).toMatchObject({ owner: 'w', mode: 'write' });
    expect(await store.shared.acquire(rwKey, { token: lockTokenSchema.parse('r3'), mode: 'read' })).toBeUndefined();
    if (w === undefined) throw new Error('unreachable');
    expect(await store.shared.release({ ...w, token: lockTokenSchema.parse('imposter') })).toBe('not-owner');
    expect(await store.shared.release(w)).toBe('released');
    expect(store.peek(rwKey)).toBeUndefined();
  });

  it('reserves the key for a woken writer, so neither a reader nor another writer can slip in between the wake-up and the retry', async () => {
    const store = memoryStore();
    const reader = orThrow(await store.shared.acquire(rwKey, { token: lockTokenSchema.parse('r1'), mode: 'read' }));
    if (reader === undefined) throw new Error('unreachable');
    const writer = store.shared.waiter(rwKey, 'write');
    const woken = writer.waitFor(new AbortController().signal);
    await store.shared.release(reader);
    orThrow(await woken);
    // The key is free and the writer has been woken but has not retried yet.
    expect(await store.shared.acquire(rwKey, { token: lockTokenSchema.parse('r2'), mode: 'read' })).toBeUndefined();
    expect(await store.shared.acquire(rwKey, { token: lockTokenSchema.parse('w2'), mode: 'write' })).toBeUndefined();
    const grant = orThrow(await store.shared.acquire(rwKey, { token: lockTokenSchema.parse('w'), mode: 'write', waiter: writer }));
    expect(grant).toBeDefined();
    writer.close();
    if (grant === undefined) throw new Error('unreachable');
    await store.shared.release(grant);
    expect(await store.shared.acquire(rwKey, { token: lockTokenSchema.parse('r3'), mode: 'read' })).toBeDefined();
  });

  it('turns readers away while a writer waits, and lets them in again once it stops waiting', async () => {
    const locks = createLocks({ store: memoryStore(), namespace: 't' });
    const { read, write } = locks.readWrite('catalog');
    const first = await orThrow(read.acquire());
    const writing = write.run(() => 'wrote', { wait: '5s' });
    await sleep(10);
    // Without writer preference this reader would get in and could starve the writer forever.
    expect(LockHeld.is(await read.tryAcquire())).toBe(true);
    orThrow(await first.release());
    expect(await writing).toBe('wrote');
    const after = await orThrow(read.tryAcquire());
    orThrow(await after.release());
  });

  it.each(['its wait runs out', 'its caller aborts'] as const)(
    'lets readers back in when the writer stops waiting because %s, so a lost writer cannot block readers for good',
    async how => {
      const locks = createLocks({ store: memoryStore(), namespace: 't' });
      const { read, write } = locks.readWrite('catalog');
      const first = await orThrow(read.acquire());
      const controller = new AbortController();
      const writing = write
        .run(() => 'wrote', how === 'its caller aborts' ? { wait: '5s', signal: controller.signal } : { wait: '40ms' })
        .then(
          outcome => (LockHeld.is(outcome) ? 'held' : isFailure(outcome) ? outcome.code : 'wrote'),
          (error: unknown) => (error instanceof LockError ? error.code : 'other'),
        );
      // A reader that queues behind the waiting writer.
      await sleep(10);
      const queued = read.run(() => 'read', { wait: '5s' });
      await sleep(10);
      if (how === 'its caller aborts') controller.abort();
      expect(await writing).toBe(how === 'its caller aborts' ? 'lock.aborted' : 'held');
      expect(await queued).toBe('read');
      const reader = await orThrow(read.tryAcquire());
      orThrow(await reader.release());
      orThrow(await first.release());
    },
  );

  it('does not let a writer jump a reader that already holds, and runs the writers one at a time', async () => {
    const locks = createLocks({ store: memoryStore(), namespace: 't' });
    const { write } = locks.readWrite('catalog');
    let active = 0;
    let maxActive = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        orThrow(
          write.run(
            async () => {
              active += 1;
              maxActive = Math.max(maxActive, active);
              await sleep(1);
              active -= 1;
            },
            { wait: '10s' },
          ),
        ),
      ),
    );
    expect(maxActive).toBe(1);
  });
});

describe('memoryStore primitives are independent', () => {
  it('lets a mutex, a semaphore and a writer of one name be held together', async () => {
    const locks = createLocks({ store: memoryStore(), namespace: 't' });
    const mutex = await orThrow(locks.mutex('x').tryAcquire());
    const pool = await orThrow(locks.semaphore('x', { limit: 1 }).tryAcquire());
    const writer = await orThrow(locks.readWrite('x').write.tryAcquire());
    orThrow(await mutex.release());
    orThrow(await pool.release());
    orThrow(await writer.release());
  });
});

const flat = (grant: Grant | undefined): Grant | undefined =>
  grant === undefined ? undefined : { ...grant, fence: lockFenceSchema.parse(1n) };

/** A memory store whose semaphore and read/write grants all carry one fence. Breaks "fences grow per grant". */
function constantFenceStore(): Store {
  const inner = memoryStore();
  return {
    ...inner,
    permits: { ...inner.permits, acquire: async (k, req) => flat(await inner.permits.acquire(k, req)) },
    shared: { ...inner.shared, acquire: async (k, req) => flat(await inner.shared.acquire(k, req)) },
  };
}

describe('memoryStore permits and the contract', () => {
  it('wakes a semaphore waiter at once when a permit frees between its refusal and its park, because it must not sleep the 1 s backoff', async () => {
    const locks = createLocks({ store: memoryStore(), namespace: 'r1' });
    const pool = locks.semaphore('p', { limit: 2 });
    const first = await orThrow(pool.acquire());
    const second = await orThrow(pool.acquire());
    const started = performance.now();
    // The refusal is decided synchronously inside this call; the waiter parks a few microtasks later.
    const waiting = pool.acquire({ wait: '5s' });
    // The permit frees before the waiter parks: a wake-all finds nobody, and `second` still holds.
    void orThrow(first.release());
    const third = await orThrow(waiting);
    const took = performance.now() - started;
    orThrow(await third.release());
    orThrow(await second.release());
    expect(took).toBeLessThan(200);
  });

  it('wakes only the waiters whose weight now fits, because the others would only retry and fail', async () => {
    const store = memoryStore();
    const poolKey = createKey('w', 'pool', 'semaphore');
    const hold = async (token: string, weight: number) => {
      const grant = orThrow(await store.permits.acquire(poolKey, { token: lockTokenSchema.parse(token), limit: 3, weight }));
      if (grant === undefined) throw new Error(`expected ${token} to be granted`);
      return grant;
    };
    const big = await hold('big', 2);
    const small = await hold('small', 1);
    const wakes: string[] = [];
    const park = (name: string, weight: number) => {
      const waiter = store.permits.waiter(poolKey, weight);
      void waiter.waitFor(new AbortController().signal).then(() => wakes.push(name));
      return waiter;
    };
    park('needs-3', 3);
    const needsOne = park('needs-1', 1);
    await Promise.resolve();
    await store.permits.release(small); // 2 in use: 1 fits, 3 does not
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(wakes).toEqual(['needs-1']);
    // The permit is reserved for needs-1 until it takes it or stops waiting; it stops.
    needsOne.close();
    await store.permits.release(big);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(wakes).toEqual(['needs-1', 'needs-3']);
  });

  it('refuses a weight that is not a positive integer, as it refuses one above the limit, because PermitOps is public', async () => {
    const store = memoryStore();
    const poolKey = createKey('r3', 'pool', 'semaphore');
    await expect(store.permits.acquire(poolKey, { token: lockTokenSchema.parse('neg'), limit: 1, weight: -1 })).rejects.toMatchObject({
      code: 'config',
    });
    // Had the negative hold been taken, inUse is -1 and two weight-1 holds would now share a limit of 1.
    const first = orThrow(await store.permits.acquire(poolKey, { token: lockTokenSchema.parse('a'), limit: 1, weight: 1 }));
    const second = orThrow(await store.permits.acquire(poolKey, { token: lockTokenSchema.parse('b'), limit: 1, weight: 1 }));
    expect([first, second].filter(grant => grant !== undefined)).toHaveLength(1);
  });

  it('is caught by the contract when every semaphore and read/write grant carries the same fence, because the fence cases must be able to fail', async () => {
    const cases = storeContract(() => constantFenceStore()).filter(
      c => /^(?:permits|shared):/.test(c.name) && c.name.includes('fence'),
    );
    expect(cases).toHaveLength(2);
    for (const contractCase of cases) {
      const outcome = await contractCase.run().then(
        () => 'passed',
        (error: unknown) => (error instanceof ContractSkip ? 'skipped' : 'failed'),
      );
      expect(outcome, contractCase.name).toBe('failed');
    }
  });
});

/** A memory store whose attempts are counted, so a test can see how much work a release causes. */
function countingStore() {
  const inner = memoryStore();
  const attempts = { mutex: 0, permits: 0 };
  const store: Store<MemoryGuarantees> = {
    ...inner,
    acquire: (k, req) => {
      attempts.mutex += 1;
      return inner.acquire(k, req);
    },
    waiter: k => inner.waiter(k),
    permits: {
      ...inner.permits,
      acquire: (k, req) => {
        attempts.permits += 1;
        return inner.permits.acquire(k, req);
      },
    },
  };
  return { store, attempts };
}

const settled = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5));

describe('memoryStore hand-off', () => {
  it('wakes exactly one waiter per mutex release, because waking the whole queue makes a contended run quadratic', async () => {
    const store = memoryStore();
    const holder = await grab(store, 'holder');
    const wakes: string[] = [];
    for (const name of ['a', 'b', 'c']) {
      void store
        .waiter(key)
        .waitFor(new AbortController().signal)
        .then(() => wakes.push(name));
    }
    await store.release(holder);
    await settled();
    expect(wakes).toEqual(['a']);
  });

  it('costs each of 1000 contended callers at most two store attempts, so the work grows linearly with the queue', async () => {
    const { store, attempts } = countingStore();
    const locks = createLocks({ store, namespace: 't' });
    const callers = 1000;
    await Promise.all(
      Array.from({ length: callers }, () =>
        orThrow(
          locks.mutex('job').run(async () => {
            await Promise.resolve();
          }),
        ),
      ),
    );
    // One refused attempt, then the one that takes the handed-over lock. Waking everyone would be ~n²/2.
    expect(attempts.mutex).toBeLessThanOrEqual(2 * callers);
  });

  it('runs 1000 waiters in the order they asked, because the queue is first come, first served', async () => {
    const locks = createLocks({ store: memoryStore(), namespace: 't' });
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 1000 }, (_, index) =>
        orThrow(
          locks.mutex('job').run(async () => {
            order.push(index);
            await Promise.resolve();
          }),
        ),
      ),
    );
    expect(order).toEqual(Array.from({ length: 1000 }, (_, index) => index));
  });

  it('refuses a newcomer while the lock is reserved for a woken waiter, so nobody barges in between the wake-up and the retry', async () => {
    const store = memoryStore();
    const holder = await grab(store, 'holder');
    const waiter = store.waiter(key);
    const woken = waiter.waitFor(new AbortController().signal);
    await store.release(holder);
    orThrow(await woken);
    expect(await store.acquire(key, { token: lockTokenSchema.parse('newcomer') })).toBeUndefined();
    const grant = orThrow(await store.acquire(key, { token: lockTokenSchema.parse('waiter'), waiter }));
    expect(grant?.token).toBe('waiter');
    waiter.close();
  });

  it('passes the lock on when an aborted waiter leaves the middle of the queue, so one quitter cannot stall the rest', async () => {
    const locks = createLocks({ store: memoryStore(), namespace: 't' });
    const holder = await orThrow(locks.mutex('job').acquire());
    const order: string[] = [];
    const controller = new AbortController();
    const run = (name: string, signal?: AbortSignal) =>
      locks
        .mutex('job')
        .run(() => void order.push(name), { wait: '5s', ...(signal === undefined ? {} : { signal }) })
        .then(
          outcome => isFailure(outcome) ? outcome.code : 'ran',
          (error: unknown) => (error instanceof LockError ? error.code : 'other'),
        );
    const first = run('a');
    const middle = run('b', controller.signal);
    const last = run('c');
    await sleep(10);
    controller.abort();
    expect(await middle).toBe('lock.aborted');
    orThrow(await holder.release());
    expect([await first, await last]).toEqual(['ran', 'ran']);
    expect(order).toEqual(['a', 'c']);
  });

  it('passes a reservation on when the woken waiter stops waiting before it takes the lock, so the hand-off is never lost', async () => {
    const store = memoryStore();
    const holder = await grab(store, 'holder');
    const first = store.waiter(key);
    const second = store.waiter(key);
    const secondWoken = second.waitFor(new AbortController().signal);
    await store.release(holder);
    // The lock is reserved for `first`, which gives up instead of taking it.
    first.close();
    orThrow(await secondWoken);
    expect(await store.acquire(key, { token: lockTokenSchema.parse('first'), waiter: first })).toBeUndefined();
    const grant = orThrow(await store.acquire(key, { token: lockTokenSchema.parse('second'), waiter: second }));
    expect(grant?.token).toBe('second');
  });

  it('grants a semaphore release to the waiters that fit, in queue order, and reaches the rest on later releases', async () => {
    const store = memoryStore();
    const poolKey = createKey('t', 'fit', 'semaphore');
    const take = async (token: string, weight: number, waiter?: ReturnType<typeof store.permits.waiter>) => {
      const grant = orThrow(await store.permits.acquire(poolKey, {
        token: lockTokenSchema.parse(token),
        limit: 3,
        weight,
        ...(waiter === undefined ? {} : { waiter }),
      }));
      if (grant === undefined) throw new Error(`expected ${token} to be granted`);
      return grant;
    };
    const full = await take('full', 3);
    const woken: string[] = [];
    const waiters = new Map<string, ReturnType<typeof store.permits.waiter>>();
    for (const [name, weight] of [
      ['a2', 2],
      ['b2', 2],
      ['c1', 1],
      ['d1', 1],
    ] as const) {
      const waiter = store.permits.waiter(poolKey, weight);
      waiters.set(name, waiter);
      void waiter.waitFor(new AbortController().signal).then(() => woken.push(name));
    }
    await store.permits.release(full);
    await settled();
    // 3 free: a2 takes 2, b2 does not fit in the 1 left and keeps its place, c1 takes the last one.
    expect(woken).toEqual(['a2', 'c1']);
    expect(await store.permits.acquire(poolKey, { token: lockTokenSchema.parse('newcomer'), limit: 3, weight: 1 })).toBeUndefined();
    const a2 = await take('a2', 2, waiters.get('a2'));
    const c1 = await take('c1', 1, waiters.get('c1'));
    await store.permits.release(a2);
    await settled();
    // 2 free: b2 is first in line and fits; d1 waits behind it.
    expect(woken).toEqual(['a2', 'c1', 'b2']);
    await store.permits.release(c1);
    await settled();
    expect(woken).toEqual(['a2', 'c1', 'b2', 'd1']);
  });

  it('finishes 1000 tasks on a semaphore of 10 with few attempts each, because a release grants only the waiters that fit', async () => {
    const { store, attempts } = countingStore();
    const locks = createLocks({ store, namespace: 't' });
    const tasks = 1000;
    let inside = 0;
    let most = 0;
    await Promise.all(
      Array.from({ length: tasks }, () =>
        orThrow(
          locks.semaphore('pool', { limit: 10 }).run(async () => {
            inside += 1;
            most = Math.max(most, inside);
            await Promise.resolve();
            inside -= 1;
          }),
        ),
      ),
    );
    expect(most).toBe(10);
    expect(attempts.permits).toBeLessThanOrEqual(2 * tasks);
  });
});

describe('contract per-case hooks', () => {
  it('gives each case the clock its own store came with and silences it once the case is over, because a timed-out case must not move the next case clock', async () => {
    const moved: string[] = [];
    let built = 0;
    const make = () => {
      built += 1;
      const id = `case-${built}`;
      return {
        store: memoryStore(),
        advanceTime: (ms: number): Promise<void> => {
          moved.push(`${id}:${ms}`);
          return Promise.resolve();
        },
      };
    };
    const late: (() => Promise<void>)[] = [];
    for (const name of ['one', 'two']) {
      await defineCase(name, make, {}, ({ options }) => {
        const advance = options.advanceTime;
        if (advance === undefined) throw new Error('the case got no advanceTime');
        late.push(() => advance(7));
        return advance(1);
      }).run();
    }
    await Promise.all(late.map(call => call())); // a pump still running after its case ended
    expect(moved).toEqual(['case-1:1', 'case-2:1']);
  });
});
