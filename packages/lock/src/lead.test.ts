import { describe, expect, it } from 'vitest';

import type { AcquireRequest, Grant, Guarantees, Key, ReleaseOutcome, Store } from './types.js';
import { createKey } from './key.js';
import { createLocks } from './locks.js';
import { manualScheduler } from './testing/manual-scheduler.js';

const TTL_MS = 3000;
const BEAT = '1s';

const leaseGuarantees = {
  kind: 'lease',
  scope: 'cluster',
  wait: 'poll',
  shared: false,
  permits: false,
  fence: 'durable',
  releasedOnCrash: 'after-ttl',
  clock: 'store',
  poolerSafe: true,
  runtimes: ['node'],
} as const satisfies Guarantees;

/** One lease table shared by every campaigner, driven by the test's clock. */
function leaseTable(now: () => number, withWake = false) {
  const holders = new Map<string, { token: string; expiresAt: number }>();
  const wakers = new Set<() => void>();
  let fence = 0n;
  const stats = { acquires: 0, releases: 0 };
  const wakeAll = (): void => {
    for (const wake of wakers) wake();
  };
  const store: Store<typeof leaseGuarantees> = {
    name: 'fake-lease',
    ttlMs: TTL_MS,
    guarantees: leaseGuarantees,
    // eslint-disable-next-line @typescript-eslint/require-await -- the store protocol is async
    async acquire(key: Key, req: AcquireRequest): Promise<Grant | undefined> {
      stats.acquires += 1;
      const current = holders.get(key.full);
      if (current !== undefined && current.expiresAt > now()) return undefined;
      fence += 1n;
      holders.set(key.full, { token: req.token, expiresAt: now() + TTL_MS });
      const grant: Grant = { key, token: req.token, fence, expiresAt: now() + TTL_MS };
      return grant;
    },
    release(grant: Grant) {
      stats.releases += 1;
      const current = holders.get(grant.key.full);
      let outcome: ReleaseOutcome = 'not-owner';
      if (current?.token === grant.token) {
        holders.delete(grant.key.full);
        outcome = 'released';
      }
      wakeAll();
      return Promise.resolve(outcome);
    },
    extend(grant: Grant) {
      const current = holders.get(grant.key.full);
      if (current?.token !== grant.token || current.expiresAt <= now()) return Promise.resolve(false);
      current.expiresAt = now() + TTL_MS;
      return Promise.resolve(true);
    },
    ...(withWake
      ? {
          waitFor(_key: Key, signal: AbortSignal) {
            return new Promise<void>(resolve => {
              const done = (): void => {
                wakers.delete(done);
                resolve();
              };
              wakers.add(done);
              signal.addEventListener('abort', done, { once: true });
            });
          },
        }
      : {}),
  };
  return {
    store,
    stats,
    /** Take the lease away from whoever holds it, as a store-side expiry would. */
    revoke(): void {
      holders.clear();
    },
    /** Someone outside the test holds the lease for good. */
    occupy(key: Key): void {
      holders.set(key.full, { token: 'outsider', expiresAt: Number.POSITIVE_INFINITY });
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise<void>(resolve => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function setup(count: number, withWake = false) {
  const clock = manualScheduler();
  const table = leaseTable(() => clock.now(), withWake);
  const campaigners = Array.from({ length: count }, () =>
    createLocks({ store: table.store, namespace: 'test', scheduler: clock }),
  );
  return { clock, table, campaigners };
}

/** Runs `lead` on every campaigner; each `fn` holds leadership until its signal aborts. */
function campaign(
  campaigners: ReturnType<typeof setup>['campaigners'],
  shutdown: AbortSignal,
  behaviour: (index: number) => (signal: AbortSignal) => Promise<void> = () => untilAborted,
) {
  const state = {
    active: 0,
    maxActive: 0,
    leading: campaigners.map(() => false),
    signals: campaigners.map((): AbortSignal[] => []),
  };
  const done = campaigners.map((locks, index) =>
    locks.mutex('feed').lead(
      async ({ signal }) => {
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        state.leading[index] = true;
        state.signals[index]?.push(signal);
        try {
          await behaviour(index)(signal);
        } finally {
          state.active -= 1;
          state.leading[index] = false;
        }
      },
      { signal: shutdown },
    ),
  );
  return { state, done: Promise.all(done) };
}

describe('lead', () => {
  it('keeps exactly one leader at any instant across 1000 beats', async () => {
    const { clock, campaigners } = setup(3);
    const stop = new AbortController();
    const { state, done } = campaign(campaigners, stop.signal);
    for (let beat = 0; beat < 1000; beat++) {
      await clock.advance(BEAT);
      expect(state.active, `beat ${beat}`).toBe(1);
    }
    expect(state.maxActive).toBe(1);
    stop.abort();
    await done;
    expect(state.active).toBe(0);
    expect(clock.pendingTimers).toBe(0);
  });

  it('hands leadership to another campaigner after a loss and aborts the old fn signal', async () => {
    const { clock, table, campaigners } = setup(3);
    const stop = new AbortController();
    const { state, done } = campaign(campaigners, stop.signal);
    await clock.advance(BEAT);
    const old = state.leading.indexOf(true);
    const oldSignal = state.signals[old]?.[0];
    expect(old).toBeGreaterThanOrEqual(0);
    expect(oldSignal?.aborted).toBe(false);

    table.revoke();
    await clock.advance(BEAT);
    expect(oldSignal?.aborted).toBe(true);
    expect(campaigners[old]?.counters.leadLost).toBe(1);
    await clock.advance(BEAT);
    const next = state.leading.findIndex((leading, index) => leading && index !== old);
    expect(next).toBeGreaterThanOrEqual(0);
    expect(state.active).toBeLessThanOrEqual(1);

    stop.abort();
    await done;
    expect(clock.pendingTimers).toBe(0);
  });

  it('steps down when fn throws, lets another campaigner lead, and retries after a beat', async () => {
    const { clock, table, campaigners } = setup(3);
    const stop = new AbortController();
    let throwerCalls = 0;
    const { state, done } = campaign(campaigners, stop.signal, index =>
      index === 0
        ? () => {
            throwerCalls += 1;
            return Promise.reject(new Error('boom'));
          }
        : untilAborted,
    );
    for (let beat = 0; beat < 10; beat++) await clock.advance(BEAT);
    expect(state.leading[0]).toBe(false);
    expect(state.leading[1] || state.leading[2]).toBe(true);
    expect(state.maxActive).toBeLessThanOrEqual(2); // the thrower is briefly active while it throws
    expect(throwerCalls).toBeGreaterThan(0);
    expect(table.stats.releases).toBeGreaterThanOrEqual(throwerCalls);
    expect(campaigners[0]?.counters.leadLost).toBe(0);

    stop.abort();
    await done;
    expect(clock.pendingTimers).toBe(0);
  });

  it('never starts a second fn while the first is still running after a loss', async () => {
    const { clock, table, campaigners } = setup(1);
    const stop = new AbortController();
    const slow = deferred();
    let calls = 0;
    const done = campaigners[0]?.mutex('feed').lead(
      () => {
        calls += 1;
        return calls === 1 ? slow.promise : untilAborted(stop.signal);
      },
      { signal: stop.signal },
    );
    await clock.advance(BEAT);
    expect(calls).toBe(1);
    table.revoke();
    for (let beat = 0; beat < 5; beat++) await clock.advance(BEAT);
    expect(calls).toBe(1);
    slow.resolve();
    await clock.advance(BEAT);
    await clock.advance(BEAT);
    expect(calls).toBe(2);
    stop.abort();
    await done;
    expect(clock.pendingTimers).toBe(0);
  });

  it('settles cleanly when the signal aborts during the campaign wait', async () => {
    const { clock, table, campaigners } = setup(1);
    table.occupy(createKey('test', 'feed'));
    const stop = new AbortController();
    let calls = 0;
    const done = campaigners[0]?.mutex('feed').lead(
      () => {
        calls += 1;
      },
      { signal: stop.signal },
    );
    await clock.advance(BEAT);
    await clock.advance(BEAT);
    expect(clock.pendingTimers).toBe(1);
    stop.abort();
    await done;
    expect(calls).toBe(0);
    expect(clock.pendingTimers).toBe(0);
  });

  it('resolves without acquiring when the signal is already aborted', async () => {
    const { clock, table, campaigners } = setup(1);
    await campaigners[0]?.mutex('feed').lead(() => 0, { signal: AbortSignal.abort() });
    expect(table.stats.acquires).toBe(0);
    expect(clock.pendingTimers).toBe(0);
  });

  it('releases and campaigns again after a beat when fn returns while still leader', async () => {
    const { clock, table, campaigners } = setup(1);
    const stop = new AbortController();
    let calls = 0;
    const done = campaigners[0]?.mutex('feed').lead(
      () => {
        calls += 1;
      },
      { signal: stop.signal },
    );
    await clock.advance('10ms');
    expect(calls).toBe(1);
    expect(table.stats.releases).toBe(1);
    await clock.advance(BEAT);
    expect(calls).toBe(2);
    expect(campaigners[0]?.counters.leadAcquired).toBe(2);
    stop.abort();
    await done;
    expect(clock.pendingTimers).toBe(0);
  });

  it('wakes a follower through the store waitFor without waiting for the beat', async () => {
    const { clock, campaigners } = setup(2, true);
    const stop = new AbortController();
    const gate = deferred();
    let calls = 0;
    const { state, done } = campaign(campaigners, stop.signal, () => {
      calls += 1;
      return calls === 1 ? () => gate.promise : untilAborted;
    });
    await clock.advance('10ms');
    const first = state.leading.indexOf(true);
    const other = first === 0 ? 1 : 0;
    expect(first).toBeGreaterThanOrEqual(0);
    expect(state.leading[other]).toBe(false);
    gate.resolve();
    await clock.advance('10ms'); // far less than one beat
    expect(state.leading[other]).toBe(true);
    stop.abort();
    await done;
    expect(clock.pendingTimers).toBe(0);
  });

  it('settles cleanly when the signal aborts during fn', async () => {
    const { clock, table, campaigners } = setup(1);
    const stop = new AbortController();
    const { state, done } = campaign(campaigners, stop.signal);
    await clock.advance(BEAT);
    expect(state.active).toBe(1);
    stop.abort();
    await done;
    expect(state.active).toBe(0);
    expect(campaigners[0]?.counters.leadLost).toBe(0);
    expect(table.stats.releases).toBe(1);
    expect(clock.pendingTimers).toBe(0);
  });
});

type WakeMode = 'none' | 'free-immediate' | 'sync-throw';

type TableOptions = {
  readonly wake?: WakeMode;
  readonly extendFails?: boolean;
  /** When set, acquire waits for the test to settle it. */
  readonly holdAcquire?: () => Promise<void>;
};

/** A cap so a spinning loop ends instead of hanging the test runner. */
const SPIN_CAP = 200;

function optionLeaseTable(now: () => number, options: TableOptions = {}) {
  const holders = new Map<string, { token: string; expiresAt: number }>();
  let fence = 0n;
  const stats = { acquires: 0, releases: 0, waitForCalls: 0 };
  const free = (key: Key): boolean => {
    const current = holders.get(key.full);
    return current === undefined || current.expiresAt <= now();
  };
  const grantIfFree = (key: Key, req: AcquireRequest): Grant | undefined => {
    if (!free(key)) return undefined;
    fence += 1n;
    holders.set(key.full, { token: req.token, expiresAt: now() + TTL_MS });
    return { key, token: req.token, fence, expiresAt: now() + TTL_MS };
  };
  const wake = options.wake ?? 'none';
  const store: Store<typeof leaseGuarantees> = {
    name: 'fake-lease',
    ttlMs: TTL_MS,
    guarantees: leaseGuarantees,
    async acquire(key: Key, req: AcquireRequest): Promise<Grant | undefined> {
      stats.acquires += 1;
      if (options.holdAcquire !== undefined) await options.holdAcquire();
      return grantIfFree(key, req);
    },
    release(grant: Grant) {
      stats.releases += 1;
      const current = holders.get(grant.key.full);
      let outcome: ReleaseOutcome = 'not-owner';
      if (current?.token === grant.token) {
        holders.delete(grant.key.full);
        outcome = 'released';
      }
      return Promise.resolve(outcome);
    },
    extend(grant: Grant) {
      if (options.extendFails === true) return Promise.reject(new Error('store unreachable for renewals'));
      const current = holders.get(grant.key.full);
      if (current?.token !== grant.token || current.expiresAt <= now()) return Promise.resolve(false);
      current.expiresAt = now() + TTL_MS;
      return Promise.resolve(true);
    },
    ...(wake === 'none'
      ? {}
      : {
          waitFor(key: Key, signal: AbortSignal): Promise<void> {
            stats.waitForCalls += 1;
            if (wake === 'sync-throw') throw new Error('waitFor: connection closed');
            // Like the redis store: join, then return at once when the key is already free.
            if (free(key) && stats.waitForCalls < SPIN_CAP) return Promise.resolve();
            return new Promise<void>(resolve => {
              signal.addEventListener('abort', () => resolve(), { once: true });
            });
          },
        }),
  };
  return {
    store,
    stats,
    occupy(key: Key): void {
      holders.set(key.full, { token: 'outsider', expiresAt: Number.POSITIVE_INFINITY });
    },
  };
}

/** An AbortController whose signal counts the abort listeners still attached. */
function countingController() {
  const controller = new AbortController();
  const { signal } = controller;
  const live = new Set<unknown>();
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (type: string, listener: EventListenerOrEventListenerObject, opts?: unknown) => {
    if (type === 'abort') live.add(listener);
    add(type, listener, opts as AddEventListenerOptions);
  };
  signal.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject, opts?: unknown) => {
    if (type === 'abort') live.delete(listener);
    remove(type, listener, opts as EventListenerOptions);
  };
  return { controller, live };
}

describe('lead: review regressions', () => {
  it('R1: does not pile up abort listeners on a long-lived shutdown signal across many terms', async () => {
    const clock = manualScheduler();
    const table = optionLeaseTable(() => clock.now());
    const locks = createLocks({ store: table.store, namespace: 'test', scheduler: clock });
    const { controller, live } = countingController();
    let terms = 0;
    const done = locks.mutex('feed').lead(
      () => {
        terms += 1; // a periodic job: do the work and return
      },
      { signal: controller.signal },
    );
    for (let beat = 0; beat < 100; beat++) await clock.advance(BEAT);
    expect(terms).toBeGreaterThanOrEqual(100);
    // Only the current beat's wait may hold a listener.
    expect(live.size).toBeLessThanOrEqual(1);
    controller.abort();
    await done;
  });

  it('R2: a throwing fn is retried after a beat, not in a hot loop, when waitFor sees the key free', async () => {
    const clock = manualScheduler();
    const table = optionLeaseTable(() => clock.now(), { wake: 'free-immediate' });
    const locks = createLocks({ store: table.store, namespace: 'test', scheduler: clock });
    const stop = new AbortController();
    let calls = 0;
    const done = locks.mutex('feed').lead(
      () => {
        calls += 1;
        throw new Error('boom');
      },
      { signal: stop.signal },
    );
    await clock.advance('10ms'); // far less than one beat (1000 ms)
    expect(calls).toBeLessThanOrEqual(1);
    stop.abort();
    await done;
  });

  it('R3: lead resolves (never rejects) and leaves no timer when the store waitFor throws synchronously', async () => {
    const clock = manualScheduler();
    const table = optionLeaseTable(() => clock.now(), { wake: 'sync-throw' });
    table.occupy(createKey('test', 'feed'));
    const locks = createLocks({ store: table.store, namespace: 'test', scheduler: clock });
    const stop = new AbortController();
    const outcome = locks
      .mutex('feed')
      .lead(() => 0, { signal: stop.signal })
      .then(
        () => 'resolved',
        (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
      );
    await clock.advance(BEAT);
    stop.abort();
    expect(await outcome).toBe('resolved');
    expect(clock.pendingTimers).toBe(0);
  });

  it('R4: with renewals failing, the old fn signal aborts before another campaigner leads', async () => {
    const clock = manualScheduler();
    const table = optionLeaseTable(() => clock.now(), { extendFails: true });
    const campaigners = [0, 1, 2].map(() => createLocks({ store: table.store, namespace: 'test', scheduler: clock }));
    const stop = new AbortController();
    const live: AbortSignal[] = [];
    let overlaps = 0;
    let terms = 0;
    const done = Promise.all(
      campaigners.map(locks =>
        locks.mutex('feed').lead(
          async ({ signal }) => {
            terms += 1;
            if (live.some(other => !other.aborted)) overlaps += 1;
            live.push(signal);
            await untilAborted(signal);
          },
          { signal: stop.signal },
        ),
      ),
    );
    for (let step = 0; step < 300; step++) await clock.advance('100ms');
    expect(terms).toBeGreaterThan(5);
    expect(overlaps).toBe(0);
    stop.abort();
    await done;
    expect(clock.pendingTimers).toBe(0);
  });

  it('R5: an abort during an in-flight attempt resolves lead and gives the late grant back', async () => {
    const clock = manualScheduler();
    let open!: () => void;
    const gate = new Promise<void>(resolve => {
      open = resolve;
    });
    const table = optionLeaseTable(() => clock.now(), { holdAcquire: () => gate });
    const locks = createLocks({ store: table.store, namespace: 'test', scheduler: clock });
    const stop = new AbortController();
    let calls = 0;
    const done = locks.mutex('feed').lead(
      () => {
        calls += 1;
      },
      { signal: stop.signal },
    );
    await clock.advance('10ms');
    expect(table.stats.acquires).toBe(1);
    stop.abort();
    await done;
    open();
    await clock.advance('10ms');
    expect(calls).toBe(0);
    expect(table.stats.releases).toBe(1);
    expect(locks.counters.leadAcquired).toBe(0);
  });

  it('F4: a grant that lands with the signal already aborted is released and fn never runs', async () => {
    const clock = manualScheduler();
    const table = optionLeaseTable(() => clock.now());
    const stop = new AbortController();
    const inner = table.store.acquire.bind(table.store);
    table.store.acquire = async (key, req) => {
      const grant = await inner(key, req);
      stop.abort();
      return grant;
    };
    const locks = createLocks({ store: table.store, namespace: 'test', scheduler: clock });
    let calls = 0;
    await locks.mutex('feed').lead(
      () => {
        calls += 1;
      },
      { signal: stop.signal },
    );
    expect(calls).toBe(0);
    expect(locks.counters.leadAcquired).toBe(0);
    expect(table.stats.releases).toBe(1);
    expect(clock.pendingTimers).toBe(0);
  });
});
