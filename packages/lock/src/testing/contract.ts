/**
 * The store conformance suite. `storeContract` returns plain `{ name, run }`
 * cases that any runner (or none) can execute: it never imports a test
 * framework. A case that does not apply to the store under test throws
 * {@link ContractSkip} with the reason; the runner reports it as skipped.
 */
import type { Scheduler } from '../scheduler.js';
import type { Grant, Key, Locks, Store } from '../types.js';
import { LockError } from '../errors.js';
import { createKey } from '../key.js';
import { createLocks } from '../locks.js';

/** Thrown by a case that does not apply to this store. `message` is the reason. */
export class ContractSkip extends Error {
  override readonly name = 'ContractSkip';
}

export type ContractCase = {
  readonly name: string;
  run(): Promise<void>;
};

export type ContractOptions = {
  /** Moves the store's clock (and the scheduler it shares) forward. Needed for lease expiry cases. */
  readonly advanceTime?: (ms: number) => Promise<void>;
  /** The lease length to test with. Default: the store's own `ttlMs`. */
  readonly ttl?: number;
  /** Callers in the race cases. `true` (default) = 16, `false` = skip the race cases. */
  readonly concurrent?: boolean | { readonly callers: number };
  /** The scheduler the store was built with, handed to `createLocks`. */
  readonly scheduler?: Scheduler;
};

export type MakeStore = () => Store | Promise<Store>;

const DEFAULT_CALLERS = 16;
const MUTEX_CALLERS = 100;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const runId = Math.random().toString(36).slice(2);
let counter = 0;

/** Throw when a contract expectation fails. Runner-agnostic `assert`. */
export function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`contract: ${message}`);
}

export function skip(reason: string): never {
  throw new ContractSkip(reason);
}

/** A key no other case, run or process shares. */
export function uniqueKey(label: string): Key {
  counter += 1;
  return createKey('contract', `${label}:${runId}:${counter}`);
}

export function newToken(): string {
  counter += 1;
  return `tok-${runId}-${counter}`;
}

export function leaseTtl(store: Store, options: ContractOptions): number | undefined {
  if (options.ttl !== undefined) return options.ttl;
  return 'ttlMs' in store && typeof store.ttlMs === 'number' ? store.ttlMs : undefined;
}

/** `ttlMs` for lease stores; nothing for hold stores. */
export function requestFor(
  store: Store,
  options: ContractOptions,
  overrides: { ttlMs?: number } = {},
): { token: string; ttlMs?: number } {
  const ttlMs = overrides.ttlMs ?? (store.guarantees.kind === 'lease' ? leaseTtl(store, options) : undefined);
  return ttlMs === undefined ? { token: newToken() } : { token: newToken(), ttlMs };
}

export async function grab(store: Store, key: Key, options: ContractOptions): Promise<Grant> {
  const grant = await store.acquire(key, requestFor(store, options));
  check(grant !== undefined, `expected to acquire ${key.name}`);
  return grant;
}

export type CaseContext = {
  readonly store: Store;
  readonly locks: Locks<Store>;
  readonly options: ContractOptions;
};

/** Build one case: fresh store per run, disposed afterwards. */
export function defineCase(
  name: string,
  makeStore: MakeStore,
  options: ContractOptions,
  body: (context: CaseContext) => Promise<void>,
): ContractCase {
  return {
    name,
    async run() {
      const store = await makeStore();
      try {
        const locks = createLocks({
          store,
          namespace: 'contract',
          ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
        });
        await body({ store, locks, options });
      } finally {
        await store.dispose?.();
      }
    },
  };
}

async function until(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

/** Await `promise`; when the store runs on a manual clock, keep moving it so waits and polls can finish. */
async function pump<T>(promise: Promise<T>, advanceTime: ContractOptions['advanceTime']): Promise<T> {
  if (advanceTime === undefined) return promise;
  const state = { settled: false };
  const markSettled = (): void => {
    state.settled = true;
  };
  void promise.then(markSettled, markSettled);
  for (let step = 0; step < 400 && !state.settled; step++) {
    await advanceTime(50);
    await Promise.resolve();
  }
  return promise;
}

function callersOf(options: ContractOptions): number {
  const { concurrent } = options;
  if (concurrent === false) return skip('concurrent cases are switched off for this store');
  if (concurrent === undefined || concurrent === true) return DEFAULT_CALLERS;
  return concurrent.callers;
}

function needLeaseClock(
  store: Store,
  options: ContractOptions,
): { ttl: number; advance: (ms: number) => Promise<void> } {
  if (store.guarantees.kind !== 'lease' || store.extend === undefined)
    return skip('hold store: there is no lease to expire or extend');
  const ttl = leaseTtl(store, options);
  if (ttl === undefined) return skip('no lease length: pass `ttl` or give the store `ttlMs`');
  if (options.advanceTime === undefined) return skip('pass `advanceTime` to move the store clock');
  return { ttl, advance: options.advanceTime };
}

const notYet = (what: string) => (): Promise<void> => {
  throw new ContractSkip(`${what} lands with Phase 2`);
};

/** The runner-agnostic cases. Run each `run()` yourself, or use `describeStoreContract`. */
export function storeContract(makeStore: MakeStore, options: ContractOptions = {}): ContractCase[] {
  const define = (name: string, body: (context: CaseContext) => Promise<void>): ContractCase =>
    defineCase(name, makeStore, options, body);

  return [
    define(`mutual exclusion: ${MUTEX_CALLERS} concurrent tryRun, exactly one runs`, async ({ locks }) => {
      const mutex = locks.mutex(uniqueKey('mutex').name);
      let lost = 0;
      let active = 0;
      let maxActive = 0;
      let ran = 0;
      const results = await Promise.all(
        Array.from({ length: MUTEX_CALLERS }, async () => {
          const result = await mutex.tryRun(async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            ran += 1;
            // Hold until every other caller has given up. Remote stores send one attempt per key
            // per process at a time, so 99 losers are 99 round trips: a short cap let a slow host
            // release early and a late attempt win legitimately (two runs, never overlapping).
            await until(() => lost >= MUTEX_CALLERS - 1, 20_000);
            active -= 1;
          });
          if (!result.ran) lost += 1;
          return result;
        }),
      );
      check(ran === 1 && maxActive === 1, `expected one runner, saw ${ran} (max overlap ${maxActive})`);
      check(
        results.filter(result => !result.ran).length === MUTEX_CALLERS - 1,
        `expected ${MUTEX_CALLERS - 1} { ran: false }`,
      );
    }),

    define('a held key blocks a second tryAcquire', async ({ locks }) => {
      const mutex = locks.mutex(uniqueKey('held').name);
      const guard = await mutex.tryAcquire();
      check(guard !== undefined, 'first tryAcquire should win');
      check((await mutex.tryAcquire()) === undefined, 'second tryAcquire should lose');
      await guard.release();
    }),

    define('release frees the key', async ({ locks }) => {
      const mutex = locks.mutex(uniqueKey('free').name);
      const guard = await mutex.tryAcquire();
      check(guard !== undefined, 'first tryAcquire should win');
      await guard.release();
      const again = await mutex.tryAcquire();
      check(again !== undefined, 'tryAcquire after release should win');
      await again.release();
    }),

    define('run with wait acquires after the holder releases, within the bound', async ({ locks, options: o }) => {
      const mutex = locks.mutex(uniqueKey('wait').name);
      const holder = await mutex.tryAcquire();
      check(holder !== undefined, 'holder should win');
      const waiting = mutex.run(() => 'got-it', { wait: '30s' });
      await new Promise(resolve => setTimeout(resolve, 5));
      await holder.release();
      check((await pump(waiting, o.advanceTime)) === 'got-it', 'waiter should run after release');
    }),

    define('a crashed holder frees the key within the declared bound', async ({ store, options: o }) => {
      if (store.guarantees.releasedOnCrash === 'immediate')
        skip('releases on crash immediately; killing a holder needs a chaos hook');
      const ttl = leaseTtl(store, o);
      if (ttl === undefined) return skip('no lease length: pass `ttl` or give the store `ttlMs`');
      if (o.advanceTime === undefined) return skip('pass `advanceTime` to move the store clock');
      const key = uniqueKey('crash');
      await grab(store, key, o); // never released: the holder "crashed"
      check((await store.acquire(key, requestFor(store, o))) === undefined, 'key should be held before the bound');
      await o.advanceTime(ttl + 1);
      await grab(store, key, o);
    }),

    define('fence strictly increases across release and re-acquire', async ({ store, options: o }) => {
      if (store.guarantees.fence === false) skip('this store hands out no fences');
      const key = uniqueKey('fence');
      let previous = -1n;
      for (let round = 0; round < 5; round++) {
        const grant = await grab(store, key, o);
        check(
          grant.fence !== undefined && grant.fence > previous,
          `fence ${String(grant.fence)} did not grow past ${previous}`,
        );
        previous = grant.fence;
        check((await store.release(grant)) === 'released', 'owner release should report released');
      }
    }),

    define('outage surfaces as LockError{code:"store"}, never ran or not-ran', async ({ store, options: o }) => {
      const broken: Store = {
        ...store,
        acquire: () => Promise.reject(new Error('simulated outage')),
      };
      const locks = createLocks({
        store: broken,
        namespace: 'contract',
        ...(o.scheduler === undefined ? {} : { scheduler: o.scheduler }),
      });
      let outcome: unknown;
      try {
        outcome = await locks.mutex(uniqueKey('outage').name).tryRun(() => 'ran');
      } catch (error) {
        check(error instanceof LockError && error.code === 'store', 'outage should throw LockError{code:"store"}');
        return;
      }
      check(false, `outage must not produce a result, got ${JSON.stringify(outcome)}`);
    }),

    define('release by another owner reports not-owner and keeps the lock', async ({ store, options: o }) => {
      const key = uniqueKey('not-owner');
      const grant = await grab(store, key, o);
      check(
        (await store.release({ ...grant, token: newToken() })) === 'not-owner',
        'foreign release should be not-owner',
      );
      check((await store.acquire(key, requestFor(store, o))) === undefined, 'owner should still hold the key');
      check((await store.release(grant)) === 'released', 'owner release should work');
    }),

    define('extend of an expired lease never revives it', async ({ store, options: o }) => {
      const { ttl, advance } = needLeaseClock(store, o);
      const key = uniqueKey('revive');
      const grant = await grab(store, key, o);
      await advance(ttl + 1);
      check((await store.extend?.(grant, ttl)) === false, 'extend after expiry should be false');
      const next = await grab(store, key, o);
      check((await store.extend?.(grant, ttl)) === false, 'extend by the old owner should stay false');
      await store.release(next);
    }),

    define('a stale owner after takeover can neither extend nor release', async ({ store, options: o }) => {
      const { ttl, advance } = needLeaseClock(store, o);
      const key = uniqueKey('stale');
      const stale = await grab(store, key, o);
      await advance(ttl + 1);
      const fresh = await grab(store, key, o);
      check((await store.extend?.(stale, ttl)) === false, 'stale extend should be false');
      check((await store.release(stale)) === 'not-owner', 'stale release should be not-owner');
      check((await store.acquire(key, requestFor(store, o))) === undefined, 'new owner should still hold the key');
      await store.release(fresh);
    }),

    define('acquire racing release and extend never gives two holders', async ({ store, options: o }) => {
      const callers = callersOf(o);
      for (let round = 0; round < 10; round++) {
        const key = uniqueKey('race-rel');
        const holder = await grab(store, key, o);
        const ttl = leaseTtl(store, o);
        const [released, extended, ...grants] = await Promise.all([
          store.release(holder),
          store.extend !== undefined && ttl !== undefined ? store.extend(holder, ttl) : Promise.resolve(null),
          ...Array.from({ length: callers }, () => store.acquire(key, requestFor(store, o))),
        ]);
        check(released === 'released', 'holder release should win its own race');
        check(extended === null || typeof extended === 'boolean', 'extend should answer a boolean');
        const winners = grants.filter(grant => grant !== undefined);
        check(winners.length <= 1, `${winners.length} callers won the key at once`);
        for (const winner of winners) await store.release(winner);
      }
    }),

    define('rounds of races give exactly one winner and strictly growing fences', async ({ store, options: o }) => {
      // One key for every round: a fence only has to grow per resource (that is
      // what the resource compares), so a per-key counter is a valid fence.
      const callers = callersOf(o);
      const key = uniqueKey('race-round');
      let previous = -1n;
      for (let round = 0; round < 10; round++) {
        const grants = await Promise.all(
          Array.from({ length: callers }, () => store.acquire(key, requestFor(store, o))),
        );
        const winners = grants.filter(grant => grant !== undefined);
        check(winners.length === 1, `expected one winner, got ${winners.length}`);
        const [winner] = winners;
        if (winner?.fence !== undefined) {
          check(winner.fence > previous, `fence ${winner.fence} did not grow past ${previous}`);
          previous = winner.fence;
        }
        if (winner !== undefined) await store.release(winner);
      }
    }),

    define('a 30-day ttl is accepted by a lease store', async ({ store, options: o }) => {
      if (store.guarantees.kind !== 'lease') skip('hold store: no ttl');
      const grant = await store.acquire(uniqueKey('ttl30'), requestFor(store, o, { ttlMs: THIRTY_DAYS_MS }));
      check(grant !== undefined, '30-day acquire should succeed');
      if (store.extend !== undefined)
        check((await store.extend(grant, THIRTY_DAYS_MS)) === true, '30-day extend should succeed');
      await store.release(grant);
    }),

    define('keys are case-sensitive, Unicode-exact and up to 512 bytes', async ({ store, options: o }) => {
      const base = `keys:${runId}:${++counter}`;
      const names = [
        `${base}:abc`,
        `${base}:ABC`,
        `${base}:é`, // composed
        `${base}:é`, // decomposed
        `${base}:\u{1F512}`,
        `${base}:${'a'.repeat(512 - base.length - 1)}`,
        `${base}:${'a'.repeat(512 - base.length - 2)}b`,
      ];
      const grants: Grant[] = [];
      for (const name of names) {
        const key = createKey('contract', name);
        const grant = await store.acquire(key, requestFor(store, o));
        check(grant !== undefined, `key ${name.slice(0, 40)} collided with an earlier one`);
        grants.push(grant);
      }
      for (const grant of grants) await store.release(grant);
    }),

    { name: 'readers overlap and a writer excludes (shared)', run: notYet('read/write locks') },
    { name: 'permits never exceed the limit (permits)', run: notYet('semaphores') },
  ];
}
