import { describe, expect, it, vi } from 'vitest';

import { LockError } from './errors.js';
import { createLocks, MIN_LEASE_TTL_MS } from './locks.js';
import type { Scheduler } from './scheduler.js';
import type { AcquireRequest, CreateLocks, Duration, Grant, Guarantees, Key, ReleaseOutcome, Store } from './types.js';

// The public type must accept the overloaded implementation.
export const publicSignature: CreateLocks = createLocks;

// ---------------------------------------------------------------------------
// Test doubles: a hand-rolled manual scheduler and a scripted store
// ---------------------------------------------------------------------------

async function flush(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}

function manualScheduler() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; cb: () => unknown }>();
  const scheduler: Scheduler = {
    now: () => now,
    setTimeout(cb, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, cb });
      return { id };
    },
    clearTimeout(handle) {
      timers.delete(handle.id);
    },
  };
  return {
    scheduler,
    pending: () => timers.size,
    /** Move the clock WITHOUT firing timers. */
    jump(ms: number): void {
      now += ms;
    },
    /** Fire every timer due on the way, in order, then settle microtasks. */
    async advance(ms: number): Promise<void> {
      const target = now + ms;
      for (;;) {
        await flush();
        let nextId2: number | undefined;
        let nextAt = Number.POSITIVE_INFINITY;
        for (const [id, timer] of timers) {
          if (timer.at <= target && timer.at < nextAt) {
            nextAt = timer.at;
            nextId2 = id;
          }
        }
        const timer = nextId2 === undefined ? undefined : timers.get(nextId2);
        if (nextId2 === undefined || timer === undefined) break;
        timers.delete(nextId2);
        now = Math.max(now, timer.at);
        await timer.cb();
      }
      now = target;
      await flush();
    },
  };
}

function neverSettles(): Promise<never> {
  return new Promise<never>(() => {
    // Never settles: a store that hangs.
  });
}

/** The store says: held by someone else. */
function busy(): Promise<Grant | undefined> {
  const noGrants = new Map<string, Grant>();
  return Promise.resolve(noGrants.get('held'));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const holdProcess = {
  kind: 'hold',
  scope: 'process',
  wait: 'wake',
  shared: false,
  permits: false,
  fence: 'process',
  releasedOnCrash: 'immediate',
  clock: 'none',
  poolerSafe: true,
  runtimes: ['node'],
} as const satisfies Guarantees;

const leaseCluster = {
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

const holdNative = { ...holdProcess, scope: 'cluster', wait: 'native' } as const satisfies Guarantees;

type ScriptedStore<G extends Guarantees> = {
  store: Store<G>;
  calls: { acquire: AcquireRequest[]; release: Grant[]; extend: Grant[] };
  script: Script;
  maxInFlight: () => number;
};

type Script = {
  acquire: (key: Key, req: AcquireRequest) => Promise<Grant | undefined>;
  release: (grant: Grant) => Promise<ReleaseOutcome>;
  extend: (grant: Grant, ttlMs: number) => Promise<boolean>;
};

/** Lease stores carry their ttl; the overload keeps the gated `Store<G>` type without a cast. */
function scriptedStore<G extends Guarantees>(guarantees: G, ttlMs?: number): ScriptedStore<G>;
function scriptedStore(guarantees: Guarantees, ttlMs = 30_000): ScriptedStore<Guarantees> {
  const calls = { acquire: [] as AcquireRequest[], release: [] as Grant[], extend: [] as Grant[] };
  let inFlight = 0;
  let maxInFlight = 0;
  const script: Script = {
    acquire: (key, req) => Promise.resolve({ key, token: req.token, fence: 7n }),
    release: () => Promise.resolve('released'),
    extend: () => Promise.resolve(true),
  };
  const store = {
    name: 'scripted',
    ttlMs,
    guarantees,
    async acquire(key: Key, req: AcquireRequest) {
      calls.acquire.push(req);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await script.acquire(key, req);
      } finally {
        inFlight -= 1;
      }
    },
    release(grant: Grant) {
      calls.release.push(grant);
      return script.release(grant);
    },
    extend(grant: Grant, ttl: number) {
      calls.extend.push(grant);
      return script.extend(grant, ttl);
    },
  };
  return { store, calls, script, maxInFlight: () => maxInFlight };
}

function setup<G extends Guarantees>(guarantees: G, extra: { ttlMs?: number; storeTimeout?: Duration; onReleaseError?: (e: LockError) => void } = {}) {
  const clock = manualScheduler();
  const fake = scriptedStore(guarantees, extra.ttlMs);
  const locks = createLocks({
    store: fake.store,
    namespace: 'test',
    scheduler: clock.scheduler,
    ...(extra.storeTimeout === undefined ? {} : { storeTimeout: extra.storeTimeout }),
    ...(extra.onReleaseError === undefined ? {} : { onReleaseError: extra.onReleaseError }),
  });
  return { clock, locks, ...fake };
}

async function failure(promise: Promise<unknown>): Promise<LockError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LockError) return error;
    throw error;
  }
  throw new Error('expected the call to reject with a LockError');
}

// ---------------------------------------------------------------------------
// Every verb, same scenarios
// ---------------------------------------------------------------------------

type Mutex = ReturnType<ReturnType<typeof setup<typeof holdProcess>>['locks']['mutex']>;
type Outcome = 'ran' | 'busy';
type Call = (mutex: Mutex, opts: { wait?: Duration; signal?: AbortSignal }) => Promise<Outcome>;

async function viaGuard(guard: Awaited<ReturnType<Mutex['tryAcquire']>>): Promise<Outcome> {
  if (guard === undefined) return 'busy';
  await guard.release();
  return 'ran';
}

const verbs: readonly { name: string; waits: boolean; call: Call }[] = [
  {
    name: 'tryRun',
    waits: false,
    call: async (mutex, opts) => {
      const result = await mutex.tryRun(() => 1, opts.signal ? { signal: opts.signal } : {});
      return result.ran ? 'ran' : 'busy';
    },
  },
  {
    name: 'run',
    waits: true,
    call: async (mutex, opts) => {
      try {
        await mutex.run(() => 1, opts);
        return 'ran';
      } catch (error) {
        if (error instanceof LockError && error.code === 'held') return 'busy';
        throw error;
      }
    },
  },
  {
    name: 'acquire',
    waits: true,
    call: async (mutex, opts) => {
      try {
        return await viaGuard(await mutex.acquire(opts));
      } catch (error) {
        if (error instanceof LockError && error.code === 'held') return 'busy';
        throw error;
      }
    },
  },
  {
    name: 'tryAcquire',
    waits: false,
    call: async (mutex, opts) => viaGuard(await mutex.tryAcquire(opts.signal ? { signal: opts.signal } : {})),
  },
];

describe.each(verbs)('$name', ({ call, waits }) => {
  it('runs and releases when the key is free, because that is the whole point of a lock', async () => {
    const t = setup(holdProcess);
    expect(await call(t.locks.mutex('k'), { wait: '1s' })).toBe('ran');
    expect(t.calls.acquire).toHaveLength(1);
    expect(t.calls.release).toHaveLength(1);
  });

  it('reports busy and does not release when someone else holds the key, because releasing would free their lock', async () => {
    const t = setup(holdProcess);
    t.script.acquire = busy;
    expect(await call(t.locks.mutex('k'), { wait: 0 })).toBe('busy');
    expect(t.calls.release).toHaveLength(0);
  });

  it('never calls the store when the signal is already aborted, because the caller has given up', async () => {
    const t = setup(holdProcess);
    const controller = new AbortController();
    controller.abort();
    const error = await failure(call(t.locks.mutex('k'), { signal: controller.signal }));
    expect(error.code).toBe('aborted');
    expect(t.calls.acquire).toHaveLength(0);
  });

  it('hands back a grant that lands after the caller aborted, because nobody is left to use or release it', async () => {
    const t = setup(holdProcess);
    const slow = deferred<Grant | undefined>();
    t.script.acquire = () => slow.promise;
    const controller = new AbortController();
    const pending = failure(call(t.locks.mutex('k'), { signal: controller.signal }));
    await flush();
    controller.abort();
    const aborted = await pending;
    expect(aborted.code).toBe('aborted');
    const sent = t.calls.acquire[0];
    if (sent === undefined) throw new Error('the attempt was never sent');
    slow.resolve({ key: { namespace: 'test', name: 'k', full: 'x' }, token: sent.token, fence: 1n });
    await flush();
    expect(t.calls.release.map((grant) => grant.token)).toEqual([sent.token]);
  });

  it('hands back a grant that lands in the same instant the caller aborts, because a grant nobody owns blocks every other replica', async () => {
    // Abort at every microtask offset after the grant lands: one of them falls
    // between the store answering and the manager noticing the abort.
    for (let ticks = 0; ticks < 12; ticks++) {
      const t = setup(holdProcess);
      const slow = deferred<Grant | undefined>();
      t.script.acquire = () => slow.promise;
      const controller = new AbortController();
      const pending = call(t.locks.mutex('k'), { signal: controller.signal }).catch((error: unknown) => error);
      await flush();
      const sent = t.calls.acquire[0];
      if (sent === undefined) throw new Error('the attempt was never sent');
      slow.resolve({ key: { namespace: 'test', name: 'k', full: 'x' }, token: sent.token, fence: 1n });
      for (let i = 0; i < ticks; i++) await Promise.resolve();
      controller.abort();
      await pending;
      await flush();
      // Ran or aborted, the store must end with this token released.
      expect({ ticks, released: t.calls.release.map((grant) => grant.token) }).toEqual({ ticks, released: [sent.token] });
    }
  });

  it('rejects with a store error and never pretends the lock was free or held when the store throws', async () => {
    const t = setup(holdProcess);
    t.script.acquire = () => Promise.reject(new Error('connection reset'));
    const error = await failure(call(t.locks.mutex('k'), { wait: '1s' }));
    expect(error).toMatchObject({ code: 'store', method: 'acquire', outcome: 'unknown' });
    expect(t.calls.release).toHaveLength(0);
  });

  it('gives up on a hanging store after storeTimeout with outcome unknown, because ownership may exist remotely', async () => {
    const t = setup(holdProcess, { storeTimeout: '1s' });
    t.script.acquire = () => neverSettles();
    const pending = failure(call(t.locks.mutex('k'), { wait: '1s' }));
    await t.clock.advance(1000);
    expect(await pending).toMatchObject({ code: 'store', method: 'acquire', outcome: 'unknown', timeoutMs: 1000 });
  });

  if (waits) {
    it('stops waiting when the signal aborts mid-wait, so a shutdown does not hang on a busy key', async () => {
      const t = setup(holdProcess);
      t.script.acquire = busy;
      const controller = new AbortController();
      const pending = failure(call(t.locks.mutex('k'), { wait: '10s', signal: controller.signal }));
      await t.clock.advance(30);
      controller.abort();
      const error = await pending;
      expect(error.code).toBe('aborted');
    });

    it('retries within the wait and takes the key once it frees, so short contention does not fail callers', async () => {
      const t = setup(holdProcess);
      let attempts = 0;
      const free = t.script.acquire;
      t.script.acquire = (key, req) => (++attempts < 3 ? busy() : free(key, req));
      const pending = call(t.locks.mutex('k'), { wait: '10s' });
      await t.clock.advance(2000);
      expect(await pending).toBe('ran');
      expect(new Set(t.calls.acquire.map((req) => req.token)).size).toBe(3);
    });
  }
});

// ---------------------------------------------------------------------------
// Lost locks, deadlines, renewal (lease store)
// ---------------------------------------------------------------------------

describe.each(['tryRun', 'run'] as const)('%s on a lease store', (verb) => {
  const start = <T>(t: ReturnType<typeof setup<typeof leaseCluster>>, fn: (ctx: { signal: AbortSignal }) => Promise<T>, onLost?: 'abort' | 'ignore') =>
    verb === 'tryRun'
      ? t.locks.mutex('k').tryRun(fn, onLost ? { onLost } : {})
      : t.locks.mutex('k').run(fn, { wait: '1s', ...(onLost ? { onLost } : {}) });

  it('aborts the callback signal when a renewal proves the lock is gone, so the work stops before it corrupts anything', async () => {
    const t = setup(leaseCluster);
    t.script.extend = () => Promise.resolve(false);
    const work = deferred<string>();
    const seen = deferred<AbortSignal>();
    const pending = failure(
      Promise.resolve(
        start(t, (ctx) => {
          seen.resolve(ctx.signal);
          return work.promise;
        }),
      ),
    );
    const signal = await seen.promise;
    expect(signal.aborted).toBe(false);
    await t.clock.advance(10_000);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toMatchObject({ code: 'lost', detectedBy: 'renewal' });
    work.resolve('done');
    await pending;
  });

  it("rejects with lost even though the callback succeeded when onLost is 'abort', because its side effects are unprotected", async () => {
    const t = setup(leaseCluster);
    t.script.extend = () => Promise.resolve(false);
    const work = deferred<string>();
    const pending = failure(Promise.resolve(start(t, () => work.promise)));
    await flush();
    await t.clock.advance(10_000);
    work.resolve('done');
    expect(await pending).toMatchObject({ code: 'lost', detectedBy: 'renewal' });
    expect(t.calls.release).toHaveLength(0);
  });

  it("returns the value when onLost is 'ignore', because the caller chose to accept a lost lock", async () => {
    const t = setup(leaseCluster);
    t.script.extend = () => Promise.resolve(false);
    const work = deferred<string>();
    const pending = start(t, () => work.promise, 'ignore');
    await flush();
    await t.clock.advance(10_000);
    work.resolve('done');
    const result = await pending;
    expect(verb === 'tryRun' ? result : { ran: true, value: result }).toEqual({ ran: true, value: 'done' });
  });

  it('keeps retrying a failing renewal every beat while the deadline has not passed, because one network blip must not drop the lock', async () => {
    const t = setup(leaseCluster);
    t.script.extend = () => Promise.reject(new Error('network down'));
    const work = deferred<string>();
    const pending = failure(Promise.resolve(start(t, () => work.promise)));
    await t.clock.advance(29_000);
    expect(t.calls.extend.length).toBeGreaterThanOrEqual(2);
    work.resolve('done');
    // Still inside the deadline, so the call completes normally and releases.
    await expect(Promise.race([pending, Promise.resolve('pending')])).resolves.toBe('pending');
    await t.clock.advance(1001);
  });

  it('falls back to a lost error from the deadline after repeated renewal errors, because the lease has expired by then', async () => {
    const t = setup(leaseCluster);
    t.script.extend = () => Promise.reject(new Error('network down'));
    const work = deferred<string>();
    const pending = failure(Promise.resolve(start(t, () => work.promise)));
    await t.clock.advance(30_000);
    work.resolve('done');
    expect(await pending).toMatchObject({ code: 'lost', detectedBy: 'deadline' });
  });

  it('lets a callback error win over a lock-side error and carries the lost error on suppressed, so the real failure is not hidden', async () => {
    const t = setup(leaseCluster);
    t.script.extend = () => Promise.resolve(false);
    const work = deferred<string>();
    const pending = failure(Promise.resolve(start(t, () => work.promise)));
    await flush();
    await t.clock.advance(10_000);
    work.reject(new LockError({ code: 'config', message: 'boom', remediation: 'none' }));
    const error = await pending;
    expect(error.code).toBe('config');
    expect(error.suppressed?.map((e) => (e instanceof LockError ? e.code : e.message))).toEqual(['lost']);
  });
});

describe('lease guard', () => {
  it('exposes the abort signal to the callback and flips held when the lock is lost', async () => {
    const t = setup(leaseCluster);
    t.script.extend = () => Promise.resolve(false);
    const guard = await t.locks.mutex('k').acquire({ wait: '1s' });
    expect(guard.held).toBe(true);
    await t.clock.advance(10_000);
    expect(guard.signal.aborted).toBe(true);
    expect(guard.signal.reason).toMatchObject({ code: 'lost', detectedBy: 'renewal' });
    expect(guard.held).toBe(false);
    await guard.release();
    expect(t.calls.release).toHaveLength(0);
  });

  it('reports held false as soon as the local deadline passes, even if no timer has fired, because a frozen process must not trust its lease', async () => {
    const t = setup(leaseCluster);
    const guard = await t.locks.mutex('k').acquire({ wait: '1s' });
    t.clock.jump(30_000);
    expect(t.clock.pending()).toBeGreaterThan(0);
    expect(guard.held).toBe(false);
  });

  it('renews on the ttl/3 beat and moves the deadline, so a healthy holder keeps the lock', async () => {
    const t = setup(leaseCluster);
    const guard = await t.locks.mutex('k').acquire({ wait: '1s' });
    await t.clock.advance(35_000);
    expect(t.calls.extend.length).toBeGreaterThanOrEqual(3);
    expect(guard.held).toBe(true);
    await guard.release();
  });

  it('renews at once when the grant arrives with less than ttl/3 left, because waiting a beat would let it lapse', async () => {
    const t = setup(leaseCluster);
    const free = t.script.acquire;
    t.script.acquire = async (key, req) => {
      t.clock.jump(25_000);
      return free(key, req);
    };
    const guard = await t.locks.mutex('k').acquire({ wait: '1s' });
    expect(t.calls.extend).toHaveLength(1);
    expect(guard.held).toBe(true);
  });

  it('does not start the callback when the renew-now proves the lock is gone, because another replica may already be inside it', async () => {
    const t = setup(leaseCluster);
    const free = t.script.acquire;
    t.script.acquire = async (key, req) => {
      t.clock.jump(25_000);
      return free(key, req);
    };
    t.script.extend = () => Promise.resolve(false);
    const fn = vi.fn(() => 'ran');
    expect(await t.locks.mutex('k').tryRun(fn, { onLost: 'ignore' })).toEqual({ ran: false });
    expect(fn).not.toHaveBeenCalled();
  });

  it('does not start the callback when the lease deadline passes during the renew-now, because the store may have handed the key on', async () => {
    const t = setup(leaseCluster);
    const free = t.script.acquire;
    t.script.acquire = async (key, req) => {
      t.clock.jump(25_000);
      return free(key, req);
    };
    t.script.extend = () => neverSettles();
    const fn = vi.fn(() => 'ran');
    const pending = t.locks.mutex('k').tryRun(fn, { onLost: 'ignore' });
    await flush();
    // The deadline (30 s) passes before the 10 s store timeout ends the renewal.
    await t.clock.advance(10_000);
    expect(await pending).toEqual({ ran: false });
    expect(fn).not.toHaveBeenCalled();
  });

  it('retries within the wait when the renew-now proves the lock is gone, so acquire never hands out a guard that is already lost', async () => {
    const t = setup(leaseCluster);
    const free = t.script.acquire;
    let first = true;
    t.script.acquire = async (key, req) => {
      if (first) t.clock.jump(25_000);
      return free(key, req);
    };
    t.script.extend = () => {
      const ok = !first;
      first = false;
      return Promise.resolve(ok);
    };
    const pending = t.locks.mutex('k').acquire({ wait: '1m' });
    await flush();
    await t.clock.advance(2000);
    const guard = await pending;
    expect(guard.held).toBe(true);
    expect(t.calls.acquire).toHaveLength(2);
  });

  it('refuses a grant that arrives a full ttl after it was sent and gives it back with its own token, because it may already be expired', async () => {
    const t = setup(leaseCluster);
    const free = t.script.acquire;
    t.script.acquire = async (key, req) => {
      t.clock.jump(30_000);
      return free(key, req);
    };
    expect(await t.locks.mutex('k').tryAcquire()).toBeUndefined();
    const sent = t.calls.acquire[0];
    expect(t.calls.release.map((grant) => grant.token)).toEqual([sent?.token]);
  });

  it('retries a refused late grant within the wait, so one slow round trip does not fail the caller', async () => {
    const t = setup(leaseCluster);
    const free = t.script.acquire;
    let first = true;
    t.script.acquire = async (key, req) => {
      if (first) {
        first = false;
        t.clock.jump(30_000);
      }
      return free(key, req);
    };
    const pending = t.locks.mutex('k').run(() => 'ok', { wait: '2m' });
    // The slow attempt moves the clock by a whole ttl, so advance past it.
    await t.clock.advance(60_000);
    expect(await pending).toBe('ok');
    expect(t.calls.acquire).toHaveLength(2);
  });

  it('hands back a renewal that lands after the lock was released, because keeping it would block the next holder', async () => {
    const t = setup(leaseCluster);
    const slow = deferred<boolean>();
    t.script.extend = () => slow.promise;
    const guard = await t.locks.mutex('k').acquire({ wait: '1s' });
    // advance() waits for the renewal in flight, so let it run in the background.
    const advancing = t.clock.advance(10_000);
    await flush();
    expect(t.calls.extend).toHaveLength(1);
    await guard.release();
    slow.resolve(true);
    await advancing;
    expect(t.calls.release).toHaveLength(2);
  });

  it('keeps one renewal beat after extend() runs mid-beat, because a second renewal chain doubles store load and outlives stopTimers', async () => {
    const t = setup(leaseCluster);
    const guard = await t.locks.mutex('k').acquire({ wait: '1s' });
    await t.clock.advance(5000);
    await guard.extend();
    // One chain: the extend at 5 s, then beats at 15 s and 25 s.
    await t.clock.advance(20_000);
    expect(t.calls.extend).toHaveLength(3);
    await guard.release();
    expect(t.clock.pending()).toBe(0);
  });

  it('extend() renews on demand and rejects with lost once the store refuses', async () => {
    const t = setup(leaseCluster);
    const guard = await t.locks.mutex('k').acquire({ wait: '1s' });
    await guard.extend();
    expect(t.calls.extend).toHaveLength(1);
    t.script.extend = () => Promise.resolve(false);
    expect(await failure(guard.extend())).toMatchObject({ code: 'lost', detectedBy: 'renewal' });
  });

  it('allows one in-flight remote attempt per key per process, so a burst of callers cannot stampede the store', async () => {
    const t = setup(leaseCluster);
    const first = deferred<Grant | undefined>();
    const free = t.script.acquire;
    let n = 0;
    t.script.acquire = (key, req) => (n++ === 0 ? first.promise : free(key, req));
    const a = t.locks.mutex('k').tryAcquire();
    const b = t.locks.mutex('k').tryAcquire();
    await flush();
    expect(t.calls.acquire).toHaveLength(1);
    first.resolve(await busy());
    await a;
    await b;
    expect(t.calls.acquire).toHaveLength(2);
    expect(t.maxInFlight()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Release rules (hold store)
// ---------------------------------------------------------------------------

describe('release', () => {
  it.each(['tryRun', 'run'] as const)(
    '%s returns the value and calls onReleaseError when release reports unknown, because the work already happened',
    async (verb) => {
      const seen: LockError[] = [];
      const t = setup(holdProcess, { onReleaseError: (e) => seen.push(e) });
      t.script.release = () => Promise.resolve('unknown');
      const result = verb === 'tryRun' ? await t.locks.mutex('k').tryRun(() => 42) : await t.locks.mutex('k').run(() => 42);
      expect(verb === 'tryRun' ? result : { ran: true, value: result }).toEqual({ ran: true, value: 42 });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ code: 'release', method: 'release' });
      expect(t.locks.counters.releaseErrors).toBe(1);
    },
  );

  it('also returns the value when release throws, with the same reporting', async () => {
    const seen: LockError[] = [];
    const t = setup(holdProcess, { onReleaseError: (e) => seen.push(e) });
    t.script.release = () => Promise.reject(new Error('gone'));
    expect(await t.locks.mutex('k').run(() => 'v')).toBe('v');
    expect(seen.map((e) => e.code)).toEqual(['release']);
  });

  it('keeps going if onReleaseError itself throws, because a faulty hook must not turn success into failure', async () => {
    const t = setup(holdProcess, {
      onReleaseError: () => {
        throw new Error('hook bug');
      },
    });
    t.script.release = () => Promise.resolve('unknown');
    expect(await t.locks.mutex('k').run(() => 'v')).toBe('v');
  });

  it('makes guard.release() reject with release on unknown, because explicit callers need to know', async () => {
    const t = setup(holdProcess);
    t.script.release = () => Promise.resolve('unknown');
    const guard = await t.locks.mutex('k').acquire();
    expect(await failure(guard.release())).toMatchObject({ code: 'release', outcome: 'unknown' });
  });

  it('is idempotent, so disposing twice never frees a lock someone else now holds', async () => {
    const t = setup(holdProcess);
    const guard = await t.locks.mutex('k').acquire();
    await guard.release();
    await guard.release();
    await guard[Symbol.asyncDispose]();
    expect(t.calls.release).toHaveLength(1);
    expect(guard.held).toBe(false);
  });

  it('treats not-owner as already released, because the lock has moved on and there is nothing to free', async () => {
    const t = setup(holdProcess);
    t.script.release = () => Promise.resolve('not-owner');
    const guard = await t.locks.mutex('k').acquire();
    await expect(guard.release()).resolves.toBeUndefined();
  });

  it('rethrows the callback error and keeps a release failure on suppressed, so the cause is not masked', async () => {
    const t = setup(holdProcess);
    t.script.release = () => Promise.resolve('unknown');
    const boom = new Error('callback failed');
    const error = await t.locks
      .mutex('k')
      .run(() => {
        throw boom;
      })
      .catch((error_: unknown) => error_);
    expect(error).toBe(boom);
    expect(Object.getOwnPropertyDescriptor(boom, 'suppressed')?.value).toHaveLength(1);
  });

  it.each(['tryRun', 'run'] as const)('%s delays the release by holdAtLeast, so a fast job on a skewed clock cannot run twice', async (verb) => {
    const t = setup(holdProcess);
    const opts = { holdAtLeast: '5s' } as const;
    const pending = verb === 'tryRun' ? t.locks.mutex('k').tryRun(() => 1, opts) : t.locks.mutex('k').run(() => 1, opts);
    await t.clock.advance(4999);
    expect(t.calls.release).toHaveLength(0);
    await t.clock.advance(1);
    await pending;
    expect(t.calls.release).toHaveLength(1);
  });
});

describe('native waits', () => {
  it('bounds a store that blocks natively by wait plus storeTimeout, so the store gets its full wait before being called dead', async () => {
    const t = setup(holdNative, { storeTimeout: '1s' });
    t.script.acquire = () => neverSettles();
    const pending = failure(t.locks.mutex('k').run(() => 1, { wait: '5s' }));
    await t.clock.advance(5999);
    await expect(Promise.race([pending, Promise.resolve('pending')])).resolves.toBe('pending');
    await t.clock.advance(1);
    expect(await pending).toMatchObject({ code: 'store', timeoutMs: 6000 });
    expect(t.calls.acquire[0]?.waitMs).toBe(5000);
  });
});

describe('lease ttl', () => {
  it("uses the store's own ttl for the beat and the deadline, so a store set to 5 minutes is never cut to a shorter lease", async () => {
    const t = setup(leaseCluster, { ttlMs: 300_000 });
    const guard = await t.locks.mutex('k').acquire({ wait: '1s' });
    expect(t.calls.acquire[0]?.ttlMs).toBe(300_000);
    await t.clock.advance(99_000);
    expect(t.calls.extend).toHaveLength(0);
    await t.clock.advance(1000);
    expect(t.calls.extend).toHaveLength(1);
    t.clock.jump(150_000);
    expect(guard.held).toBe(true);
    await guard.release();
  });

  it('refuses a lease store whose ttl is below the renewal floor, because it would renew faster than a round trip can be trusted', () => {
    const fake = scriptedStore(leaseCluster, MIN_LEASE_TTL_MS - 1);
    const attempt = (): unknown => createLocks({ store: fake.store, namespace: 't' });
    expect(attempt).toThrowError(expect.objectContaining({ code: 'config' }));
  });

  it('accepts a lease store exactly at the floor', () => {
    const fake = scriptedStore(leaseCluster, MIN_LEASE_TTL_MS);
    expect(() => createLocks({ store: fake.store, namespace: 't' })).not.toThrow();
  });

  it('does not ask a hold store for a ttl, because holds end with the connection or process', async () => {
    const t = setup(holdProcess);
    await t.locks.mutex('k').run(() => 1);
    expect(t.calls.acquire[0]?.ttlMs).toBeUndefined();
  });
});

describe('createLocks', () => {
  it('rejects a bad storeTimeout up front, because a zero timeout would fail every call', () => {
    const fake = scriptedStore(holdProcess);
    expect(() => createLocks({ store: fake.store, namespace: 't', storeTimeout: 0 })).toThrow(/storeTimeout/);
  });

  it('rejects an empty key name with a config error, because it would collide with every other empty name', () => {
    const fake = scriptedStore(holdProcess);
    const locks = createLocks({ store: fake.store, namespace: 't' });
    expect(() => locks.mutex('')).toThrowError(LockError);
  });
});
