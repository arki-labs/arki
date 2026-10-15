/**
 * The store conformance suite. `storeContract` returns plain `{ name, run }`
 * cases that any runner (or none) can execute: it never imports a test
 * framework. A case that does not apply to the store under test throws
 * {@link ContractSkip} with the reason; the runner reports it as skipped.
 */
import type { Scheduler } from '../scheduler.js';
import type { Grant, Key, Locks, ReadWriteHandle, SemaphoreConfig, SemaphoreHandle, Store } from '../types.js';
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

/**
 * A store built for one case, with the hooks that belong to that store alone: its own clock, its
 * own scheduler. A store whose clock is per case (an isolated table, a fresh manual scheduler)
 * must return this form, so a case that timed out and keeps running never moves the next case's clock.
 * Any field left out falls back to the fixed {@link ContractOptions}.
 */
export type CaseStore = {
  readonly store: Store;
  readonly advanceTime?: ContractOptions['advanceTime'];
  readonly ttl?: number;
  readonly scheduler?: Scheduler;
};

/** Builds a fresh store per case. Returns the bare store (fixed options) or a {@link CaseStore} (per-case hooks). */
export type MakeStore = () => Store | CaseStore | Promise<Store | CaseStore>;

function isCaseStore(made: Store | CaseStore): made is CaseStore {
  return !('guarantees' in made);
}

/** Split what `makeStore` returned into the store and the options for this case alone. */
export function resolveMade(
  made: Store | CaseStore,
  fixed: ContractOptions,
): { store: Store; options: ContractOptions } {
  if (!isCaseStore(made)) return { store: made, options: fixed };
  return {
    store: made.store,
    options: {
      ...fixed,
      ...(made.advanceTime === undefined ? {} : { advanceTime: made.advanceTime }),
      ...(made.ttl === undefined ? {} : { ttl: made.ttl }),
      ...(made.scheduler === undefined ? {} : { scheduler: made.scheduler }),
    },
  };
}

const DEFAULT_CALLERS = 16;
const MUTEX_CALLERS = 100;
/** One beat of `idle`: real time slept, then the injected clock catches up. */
const KEEPALIVE_BEAT_MS = 10;
/** The largest single move of an injected clock in `idle` when the store has no ttl. */
const KEEPALIVE_CAP_MS = 100;
/** One move of an injected clock while `pump` waits for work that needs timers to fire. */
const PUMP_STEP_MS = 50;
/** The most real time `pump` keeps a clock moving; the runner's own timeout comes first. */
const PUMP_REAL_CAP_MS = 120_000;
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
      const made = resolveMade(await makeStore(), options);
      const { store } = made;
      // Once the case is over (or timed out) its clock hook goes quiet: a pump left running in the
      // background must not move a clock that the next case may share.
      const state = { over: false };
      const inner = made.options.advanceTime;
      const caseOptions: ContractOptions =
        inner === undefined
          ? made.options
          : {
              ...made.options,
              advanceTime: async ms => {
                if (!state.over) await inner(ms);
              },
            };
      try {
        const locks = createLocks({
          store,
          namespace: 'contract',
          ...(caseOptions.scheduler === undefined ? {} : { scheduler: caseOptions.scheduler }),
        });
        await body({ store, locks, options: caseOptions });
      } finally {
        state.over = true;
        await store.dispose?.();
      }
    },
  };
}

/**
 * Wait one beat of real time. When the store runs on an injected clock, move that clock forward
 * by the real time that passed since `since` (in steps of at most ttl/6), so injected time keeps
 * pace with real time, even when store calls are slow. A lease store renews on the manager's
 * timers every ttl/3: a holder that waits on real time alone never renews under a manual clock,
 * and one whose clock lags behind real time renews too late. Returns the new `since`.
 */
async function idle(options: ContractOptions, ttl: number | undefined, since: number): Promise<number> {
  await new Promise(resolve => setTimeout(resolve, KEEPALIVE_BEAT_MS));
  const now = Date.now();
  if (options.advanceTime === undefined) return now;
  const cap = ttl === undefined ? KEEPALIVE_CAP_MS : Math.max(1, Math.floor(ttl / 6));
  for (let owed = now - since; owed > 0; owed -= cap) await options.advanceTime(Math.min(owed, cap));
  return now;
}

/** Wait until `predicate` holds or `timeoutMs` of real time passed, keeping lease renewals alive meanwhile. */
async function until(
  predicate: () => boolean,
  timeoutMs: number,
  options: ContractOptions,
  store: Store,
): Promise<void> {
  const ttl = store.guarantees.kind === 'lease' ? leaseTtl(store, options) : undefined;
  const deadline = Date.now() + timeoutMs;
  let since = Date.now();
  while (!predicate() && Date.now() < deadline) since = await idle(options, ttl, since);
}

/**
 * Await `promise`; when the store runs on a manual clock, keep moving it until the promise
 * settles so waits and polls can finish. Bounded by real time, and it yields a macrotask per
 * step so timers and I/O of the awaited work can run.
 */
async function pump<T>(promise: Promise<T>, advanceTime: ContractOptions['advanceTime']): Promise<T> {
  if (advanceTime === undefined) return promise;
  const state = { settled: false };
  const markSettled = (): void => {
    state.settled = true;
  };
  void promise.then(markSettled, markSettled);
  const deadline = Date.now() + PUMP_REAL_CAP_MS;
  while (!state.settled && Date.now() < deadline) {
    await advanceTime(PUMP_STEP_MS);
    await new Promise(resolve => setTimeout(resolve, 0));
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

/** The `semaphore` factory, when the manager exposes it. A type guard, because `Locks<Store>` gates it on a literal `true`. */
export function hasSemaphore(
  locks: object,
): locks is { semaphore(key: string, config: SemaphoreConfig): SemaphoreHandle<Store> } {
  return 'semaphore' in locks && typeof locks.semaphore === 'function';
}

/** The `readWrite` factory, when the manager exposes it. */
export function hasReadWrite(locks: object): locks is { readWrite(key: string): ReadWriteHandle<Store> } {
  return 'readWrite' in locks && typeof locks.readWrite === 'function';
}

function needSemaphore({ store, locks }: CaseContext) {
  if (!store.guarantees.permits || store.permits === undefined) return skip('this store has no permits');
  if (!hasSemaphore(locks)) return skip('the manager exposes no semaphore for this store');
  return { semaphore: (name: string, limit: number) => locks.semaphore(name, { limit }), ops: store.permits };
}

function needReadWrite({ store, locks }: CaseContext) {
  if (!store.guarantees.shared || store.shared === undefined) return skip('this store has no shared locks');
  if (!hasReadWrite(locks)) return skip('the manager exposes no readWrite for this store');
  return { readWrite: (name: string) => locks.readWrite(name), ops: store.shared };
}

async function expectConfig(promise: Promise<unknown>, what: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    check(
      error instanceof LockError && error.code === 'config',
      `${what}: expected LockError{code:"config"}, got ${String(error)}`,
    );
    return;
  }
  check(false, `${what}: expected a config error, but the call succeeded`);
}

/** Tasks in the permits race: the full count on a process-scope store, fewer where every attempt is a round trip. */
const POOL_TASKS = 1000;
const REMOTE_POOL_TASKS = 100;
const POOL_LIMIT = 5;
const POOL_WEIGHTS = [1, 2, 3, 1, 2] as const;

/** The runner-agnostic cases. Run each `run()` yourself, or use `describeStoreContract`. */
export function storeContract(makeStore: MakeStore, options: ContractOptions = {}): ContractCase[] {
  const define = (name: string, body: (context: CaseContext) => Promise<void>): ContractCase =>
    defineCase(name, makeStore, options, body);

  return [
    define(
      `mutual exclusion: ${MUTEX_CALLERS} concurrent tryRun, exactly one runs`,
      async ({ locks, store, options: o }) => {
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
              // On an injected clock the wait moves that clock, so the holder's renewals fire.
              await until(() => lost >= MUTEX_CALLERS - 1, 20_000, o, store);
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
      },
    ),

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

    // ---- permits (only stores with guarantees.permits) ----

    define('permits: never exceed the limit under many concurrent tasks with mixed weights', async context => {
      const { semaphore } = needSemaphore(context);
      // Remote stores send one attempt per key per process at a time, so waking every waiter is quadratic there.
      const taskCount =
        context.store.guarantees.scope === 'process'
          ? POOL_TASKS
          : Math.min(REMOTE_POOL_TASKS, callersOf(context.options) * 6);
      const pool = semaphore(uniqueKey('pool').name, POOL_LIMIT);
      let inUse = 0;
      let maxInUse = 0;
      let finished = 0;
      // Remote stores send one attempt per key per process at a time, so a slow host needs a wide wait.
      const tasks = Array.from({ length: taskCount }, (_, index) => {
        const weight = POOL_WEIGHTS[index % POOL_WEIGHTS.length] ?? 1;
        return pool.run(
          async () => {
            inUse += weight;
            maxInUse = Math.max(maxInUse, inUse);
            await new Promise(resolve => setTimeout(resolve, 0));
            inUse -= weight;
            finished += 1;
          },
          { wait: '5m', weight },
        );
      });
      await pump(Promise.all(tasks), context.options.advanceTime);
      check(finished === taskCount, `only ${finished} of ${taskCount} tasks ran`);
      check(maxInUse <= POOL_LIMIT, `${maxInUse} permits were in use at once, the limit is ${POOL_LIMIT}`);
      check(maxInUse >= 2, 'the tasks never overlapped, so the test proved nothing');
    }),

    define('permits: a hold takes its weight and the rest still fits', async context => {
      const { semaphore } = needSemaphore(context);
      const pool = semaphore(uniqueKey('weights').name, 3);
      const heavy = await pool.tryAcquire({ weight: 2 });
      check(heavy !== undefined, 'weight 2 of 3 should fit');
      check((await pool.tryAcquire({ weight: 2 })) === undefined, 'a second weight 2 should not fit');
      const light = await pool.tryAcquire({ weight: 1 });
      check(light !== undefined, 'weight 1 should fit beside weight 2');
      check((await pool.tryAcquire()) === undefined, 'the pool should be full');
      await heavy.release();
      const again = await pool.tryAcquire({ weight: 2 });
      check(again !== undefined, 'weight 2 should fit after the heavy hold left');
      await again.release();
      await light.release();
    }),

    // `PermitOps` is public, so the contract requires the store to refuse a bad request itself, not only the manager.
    define(
      'permits: the store refuses a weight above the limit, or a bad weight or limit, with config',
      async context => {
        const { ops } = needSemaphore(context);
        const { store, options: o } = context;
        const key = createKey('contract', uniqueKey('weight-config').name, 'semaphore');
        const bad = [
          { limit: 2, weight: 3, what: 'weight 3 of limit 2' },
          { limit: 2, weight: 0, what: 'weight 0' },
          { limit: 2, weight: -1, what: 'weight -1' },
          { limit: 2, weight: 1.5, what: 'weight 1.5' },
          { limit: 0, weight: 1, what: 'limit 0' },
          { limit: 1.5, weight: 1, what: 'limit 1.5' },
        ];
        for (const { limit, weight, what } of bad)
          await expectConfig(ops.acquire(key, { ...requestFor(store, o), limit, weight }), what);
        // Nothing was taken: the whole pool is still free.
        const full = await ops.acquire(key, { ...requestFor(store, o), limit: 2, weight: 2 });
        check(full !== undefined, 'a refused request must not leave a hold behind');
        await ops.release(full);
      },
    ),

    define(
      'permits: a conflicting limit while held is a config error; once drained a new limit is accepted',
      async context => {
        const { semaphore } = needSemaphore(context);
        const name = uniqueKey('limit').name;
        const first = await semaphore(name, 2).tryAcquire();
        check(first !== undefined, 'limit 2 should acquire');
        await expectConfig(semaphore(name, 3).tryAcquire(), 'limit 3 while held with limit 2');
        await first.release();
        const second = await semaphore(name, 3).tryAcquire();
        check(second !== undefined, 'a new limit should be accepted once no hold is left');
        await second.release();
      },
    ),

    define('permits: release is owner-checked', async context => {
      const { ops } = needSemaphore(context);
      const { store, options: o } = context;
      const key = createKey('contract', `${uniqueKey('permit-owner').name}`, 'semaphore');
      const grant = await ops.acquire(key, { ...requestFor(store, o), limit: 2, weight: 1 });
      check(grant !== undefined, 'the first permit should be granted');
      check(
        (await ops.release({ ...grant, token: newToken() })) === 'not-owner',
        'a foreign release should be not-owner',
      );
      const heavy = await ops.acquire(key, { ...requestFor(store, o), limit: 2, weight: 2 });
      check(heavy === undefined, 'the owner still holds one permit, so weight 2 of 2 should not fit');
      check((await ops.release(grant)) === 'released', 'the owner release should work');
      check((await ops.release(grant)) === 'not-owner', 'a second release should be not-owner');
    }),

    define('permits: fence strictly increases across grants', async context => {
      const { ops } = needSemaphore(context);
      const { store, options: o } = context;
      if (store.guarantees.fence === false) skip('this store hands out no fences');
      const key = createKey('contract', uniqueKey('permit-fence').name, 'semaphore');
      let previous = -1n;
      const next = async (): Promise<Grant> => {
        const grant = await ops.acquire(key, { ...requestFor(store, o), limit: 3, weight: 1 });
        check(grant !== undefined, 'a permit should be granted');
        check(
          grant.fence !== undefined && grant.fence > previous,
          `fence ${String(grant.fence)} did not grow past ${previous}`,
        );
        previous = grant.fence;
        return grant;
      };
      // Overlapping holds, then release and grant again.
      const overlapping = [await next(), await next(), await next()];
      for (const grant of overlapping) await ops.release(grant);
      for (let round = 0; round < 3; round++) await ops.release(await next());
    }),

    define("permits: a crashed holder's permit frees after the ttl", async context => {
      const { ops } = needSemaphore(context);
      const { store, options: o } = context;
      const { ttl, advance } = needLeaseClock(store, o);
      const key = createKey('contract', uniqueKey('permit-crash').name, 'semaphore');
      const request = (): { token: string; ttlMs?: number; limit: number; weight: number } => ({
        ...requestFor(store, o),
        limit: 1,
        weight: 1,
      });
      check((await ops.acquire(key, request())) !== undefined, 'the first permit should be granted'); // never released
      check((await ops.acquire(key, request())) === undefined, 'the permit should be held before the ttl');
      await advance(ttl + 1);
      const after = await ops.acquire(key, request());
      check(after !== undefined, 'the permit of a crashed holder should free after the ttl');
      await ops.release(after);
    }),

    define('permits: extend keeps a permit held past the ttl', async context => {
      const { ops } = needSemaphore(context);
      const { store, options: o } = context;
      const { ttl, advance } = needLeaseClock(store, o);
      const key = createKey('contract', uniqueKey('permit-extend').name, 'semaphore');
      const request = (): { token: string; ttlMs?: number; limit: number; weight: number } => ({
        ...requestFor(store, o),
        limit: 1,
        weight: 1,
      });
      const grant = await ops.acquire(key, request());
      check(grant !== undefined, 'the permit should be granted');
      if (ops.extend === undefined) skip('this store has no permit extend');
      // 1.5 ttl in total, extended every half ttl: only a real extend survives it.
      for (let beat = 0; beat < 3; beat++) {
        await advance(Math.ceil(ttl / 2));
        check((await ops.extend(grant, ttl)) === true, 'extend of a live permit should be true');
      }
      check((await ops.acquire(key, request())) === undefined, 'an extended permit should still be held past the ttl');
      await advance(ttl + 1);
      const after = await ops.acquire(key, request());
      check(after !== undefined, 'the permit should free once it stops being extended');
      await ops.release(after);
    }),

    // ---- shared (only stores with guarantees.shared) ----

    define('shared: readers overlap', async context => {
      const { readWrite } = needReadWrite(context);
      const { read } = readWrite(uniqueKey('readers').name);
      const first = await read.tryAcquire();
      const second = await read.tryAcquire();
      check(first !== undefined && second !== undefined, 'two readers should hold at once');
      await first.release();
      await second.release();
    }),

    define('shared: a writer excludes readers and writers, and readers exclude a writer', async context => {
      const { readWrite } = needReadWrite(context);
      const { read, write } = readWrite(uniqueKey('writer').name);
      const writer = await write.tryAcquire();
      check(writer !== undefined, 'the first writer should win');
      check((await read.tryAcquire()) === undefined, 'a reader should lose to a writer');
      check((await write.tryAcquire()) === undefined, 'a second writer should lose to a writer');
      await writer.release();
      const reader = await read.tryAcquire();
      check(reader !== undefined, 'a reader should win once the writer left');
      check((await write.tryAcquire()) === undefined, 'a writer should lose to a reader');
      await reader.release();
      const again = await write.tryAcquire();
      check(again !== undefined, 'a writer should win once the reader left');
      await again.release();
    }),

    define('shared: a waiting writer runs after the readers leave', async context => {
      const { readWrite } = needReadWrite(context);
      const { read, write } = readWrite(uniqueKey('writer-waits').name);
      const reader = await read.tryAcquire();
      check(reader !== undefined, 'the reader should win');
      const waiting = write.run(() => 'wrote', { wait: '30s' });
      await new Promise(resolve => setTimeout(resolve, 5));
      await reader.release();
      check((await pump(waiting, context.options.advanceTime)) === 'wrote', 'the writer should run after the reader');
    }),

    define('shared: release is owner-checked', async context => {
      const { ops } = needReadWrite(context);
      const { store, options: o } = context;
      const key = createKey('contract', uniqueKey('shared-owner').name, 'readWrite');
      const grant = await ops.acquire(key, { ...requestFor(store, o), mode: 'write' });
      check(grant !== undefined, 'the writer should be granted');
      check(
        (await ops.release({ ...grant, token: newToken() })) === 'not-owner',
        'a foreign release should be not-owner',
      );
      check(
        (await ops.acquire(key, { ...requestFor(store, o), mode: 'read' })) === undefined,
        'the writer should still hold the key',
      );
      check((await ops.release(grant)) === 'released', 'the owner release should work');
    }),

    define('shared: a waiting writer stops new readers (writer preference)', async context => {
      const { readWrite } = needReadWrite(context);
      if (context.store.guarantees.writerPreference !== true) skip('this store does not claim writerPreference');
      const { read, write } = readWrite(uniqueKey('preference').name);
      const first = await read.tryAcquire();
      check(first !== undefined, 'the first reader should win');
      const writing = write.run(() => 'wrote', { wait: '30s' });
      // The writer registers after its first refused attempt: poll until a new reader is turned away.
      const deadline = Date.now() + 10_000;
      let refused = false;
      let since = Date.now();
      while (!refused && Date.now() < deadline) {
        const slipped = await read.tryAcquire();
        if (slipped === undefined) refused = true;
        else {
          await slipped.release();
          since = await idle(context.options, leaseTtl(context.store, context.options), since);
        }
      }
      check(refused, 'a new reader got in beside a waiting writer');
      await first.release();
      check(
        (await pump(writing, context.options.advanceTime)) === 'wrote',
        'the writer should run once the reader left',
      );
      const after = await read.tryAcquire();
      check(after !== undefined, 'readers should be let in again once the writer is done');
      await after.release();
    }),

    define('shared: fence strictly increases across grants', async context => {
      const { ops } = needReadWrite(context);
      const { store, options: o } = context;
      if (store.guarantees.fence === false) skip('this store hands out no fences');
      const key = createKey('contract', uniqueKey('shared-fence').name, 'readWrite');
      let previous = -1n;
      const take = async (mode: 'read' | 'write'): Promise<Grant> => {
        const grant = await ops.acquire(key, { ...requestFor(store, o), mode });
        check(grant !== undefined, `a ${mode} hold should be granted`);
        check(
          grant.fence !== undefined && grant.fence > previous,
          `${mode} fence ${String(grant.fence)} did not grow past ${previous}`,
        );
        previous = grant.fence;
        return grant;
      };
      const first = await take('read');
      const second = await take('read');
      await ops.release(first);
      await ops.release(second);
      await ops.release(await take('write'));
      await ops.release(await take('read'));
      await ops.release(await take('write'));
    }),

    ...(['read', 'write'] as const).flatMap(mode => [
      define(`shared: a crashed ${mode} holder frees the key after the ttl`, async context => {
        const { ops } = needReadWrite(context);
        const { store, options: o } = context;
        const { ttl, advance } = needLeaseClock(store, o);
        const key = createKey('contract', uniqueKey(`shared-crash-${mode}`).name, 'readWrite');
        check((await ops.acquire(key, { ...requestFor(store, o), mode })) !== undefined, `the ${mode} hold should win`); // never released
        // A writer is refused by either hold; the crashed holder is what keeps it out.
        check(
          (await ops.acquire(key, { ...requestFor(store, o), mode: 'write' })) === undefined,
          `a writer should be refused beside the ${mode} hold`,
        );
        await advance(ttl + 1);
        const after = await ops.acquire(key, { ...requestFor(store, o), mode: 'write' });
        check(after !== undefined, `the ${mode} hold of a crashed holder should free after the ttl`);
        await ops.release(after);
      }),

      define(`shared: extend keeps a ${mode} hold past the ttl`, async context => {
        const { ops } = needReadWrite(context);
        const { store, options: o } = context;
        const { ttl, advance } = needLeaseClock(store, o);
        const key = createKey('contract', uniqueKey(`shared-extend-${mode}`).name, 'readWrite');
        const grant = await ops.acquire(key, { ...requestFor(store, o), mode });
        check(grant !== undefined, `the ${mode} hold should win`);
        if (ops.extend === undefined) skip('this store has no shared extend');
        for (let beat = 0; beat < 3; beat++) {
          await advance(Math.ceil(ttl / 2));
          check((await ops.extend(grant, ttl)) === true, `extend of a live ${mode} hold should be true`);
        }
        check(
          (await ops.acquire(key, { ...requestFor(store, o), mode: 'write' })) === undefined,
          `an extended ${mode} hold should still be held past the ttl`,
        );
        await advance(ttl + 1);
        const after = await ops.acquire(key, { ...requestFor(store, o), mode: 'write' });
        check(after !== undefined, `the ${mode} hold should free once it stops being extended`);
        await ops.release(after);
      }),
    ]),

    // ---- primitives are independent ----

    define('a mutex, a semaphore and a readWrite with the same name do not block each other', async context => {
      const { locks, store } = context;
      const name = uniqueKey('same-name').name;
      const guards = [];
      const mutex = await locks.mutex(name).tryAcquire();
      check(mutex !== undefined, 'the mutex should win');
      guards.push(mutex);
      if (store.guarantees.permits && hasSemaphore(locks)) {
        const semaphore = await locks.semaphore(name, { limit: 1 }).tryAcquire();
        check(semaphore !== undefined, 'the semaphore should not be blocked by the mutex');
        guards.push(semaphore);
      }
      if (store.guarantees.shared && hasReadWrite(locks)) {
        const writer = await locks.readWrite(name).write.tryAcquire();
        check(writer !== undefined, 'the writer should not be blocked by the mutex or the semaphore');
        guards.push(writer);
      }
      if (guards.length === 1) skip('this store has neither permits nor shared locks');
      check((await locks.mutex(name).tryAcquire()) === undefined, 'the mutex should still be held');
      for (const guard of guards) await guard.release();
    }),
  ];
}
