import { orThrow } from '@arki/failure';
/**
 * `testStore(guarantees)`: an in-memory store that makes the promises of another store, so a
 * test can hand a feature a real lock manager typed exactly like production (`LocksFor<G>`),
 * with no cast.
 *
 * It is `memoryStore` (FIFO hand-off, semaphores, writer-preferring read/write) behind a thin
 * layer that keeps what `guarantees` says:
 *
 * - Fences are handed out iff `fence !== false` (memory's strictly increasing bigint).
 * - `semaphore` and `readWrite` exist iff `permits` and `shared` are set.
 * - `kind: 'lease'`: every hold expires `ttl` after it was granted, on the scheduler's clock,
 *   unless extended. Expiry frees the key (the next waiter gets it) and resolves `grant.lost`.
 *   `extend` never revives an expired lease. The permits and shared ops have `extend` too.
 * - `wait: 'native'`: a native store may block inside one attempt; the manager does not need it
 *   to. This store answers at once and the manager waits on the store's waiter instead, which
 *   it already does after a refusal. `'poll'` and `'none'` get the same waiters: waking a caller
 *   early breaks no promise a polling store makes.
 * - `releasedBy: 'transaction'`: there is no transaction, so a release frees the key, as if
 *   each `run` were its own transaction. A guard from `acquire()` has no `release` in its type
 *   and keeps the key until the store is dropped.
 *
 * Scope, crash release, clock and runtimes are labels here: one process, nothing crashes.
 */
import type { Scheduler, SchedulerHandle } from '../scheduler.js';
import type {
  AcquireRequest,
  Duration,
  Grant,
  Guarantees,
  Key,
  PermitOps,
  ReleaseOutcome,
  SharedOps,
  Store,
  Waiter,
} from '../types.js';
import { LockError } from '../errors.js';
import { memoryStore } from '../memory.js';
import { defaultScheduler } from '../scheduler.js';
import { parseDuration } from '../wait.js';

export type TestStoreOptions = {
  /** The clock and timers a lease expires on. Give the manager the same one. Default: the global timers. */
  readonly scheduler?: Scheduler;
  /** Lease guarantees only: how long a lease lasts without renewal. Default `'30s'`. */
  readonly ttl?: Duration;
};

/** What `testStore(guarantees)` returns: a `Store<G, never>`, with the permits and shared ops when `G` claims them. */
export type TestStore<G extends Guarantees> = Store<G, never> & {
  waitFor(key: Key, signal: AbortSignal): Promise<void>;
  waiter(key: Key): Waiter<never>;
  /** Stops the lease timers. */
  dispose(): Promise<void>;
} & (G['permits'] extends true ? { readonly permits: PermitOps<never> } : unknown) &
  (G['shared'] extends true ? { readonly shared: SharedOps<never> } : unknown);

const DEFAULT_TTL: Duration = '30s';

/** The acquire and release of one primitive. */
type Ops<R extends AcquireRequest> = {
  acquire(key: Key, req: R): Promise<Grant | undefined>;
  release(grant: Grant): Promise<ReleaseOutcome>;
};

type Kept<R extends AcquireRequest> = Ops<R> & { extend?(grant: Grant, ttlMs: number): Promise<boolean> };

/** A live lease: the memory grant it frees on expiry, its expiry timer, and how to tell the holder. */
type Lease = {
  readonly grant: Grant;
  timer: SchedulerHandle;
  readonly lose: (error: LockError) => void;
};

const notOwner: Promise<ReleaseOutcome> = Promise.resolve('not-owner');
const gone: Promise<boolean> = Promise.resolve(false);
const kept: Promise<boolean> = Promise.resolve(true);

/**
 * An in-memory store that keeps every promise `guarantees` makes. Pass the guarantees of the
 * production store (`pgSessionGuarantees`, `pgLeasePollGuarantees`, ...) and the manager built
 * on it has the production handle's type.
 *
 * @example
 * ```ts
 * const clock = manualScheduler();
 * const store = testStore(pgSessionGuarantees, { scheduler: clock });
 * const locks = createLocks({ store, namespace: 'app', scheduler: clock }); // fits LocksFor<PgSessionGuarantees>
 * ```
 */
export function testStore<G extends Guarantees>(guarantees: G, options?: TestStoreOptions): TestStore<G>;
export function testStore(
  guarantees: Guarantees,
  options: TestStoreOptions = {},
): Store & {
  waitFor(key: Key, signal: AbortSignal): Promise<void>;
  waiter(key: Key): Waiter<never>;
  dispose(): Promise<void>;
} {
  const scheduler = options.scheduler ?? defaultScheduler;
  const leased = guarantees.kind === 'lease';
  const ttlMs = parseDuration(options.ttl ?? DEFAULT_TTL);
  const base = memoryStore();
  const leaseTables: Map<string, Lease>[] = [];

  /** Wrap one primitive of the memory store so its grants keep `guarantees`. */
  function keep<R extends AcquireRequest>(ops: Ops<R>): Kept<R> {
    /** Live leases of this primitive, by token. */
    const leases = new Map<string, Lease>();
    leaseTables.push(leases);

    const live = (grant: Grant): Lease | undefined => {
      const lease = leases.get(grant.token);
      return lease?.grant.key.full === grant.key.full ? lease : undefined;
    };

    const expireLater = (token: string, ms: number): SchedulerHandle =>
      scheduler.setTimeout(async () => {
        const lease = leases.get(token);
        if (lease === undefined) return;
        leases.delete(token);
        // Free the key first, as a real store does; the holder learns of it after.
        orThrow(await ops.release(lease.grant));
        lease.lose(
          new LockError({
            code: 'lost',
            message: 'the lease ran out on the test store clock',
            remediation: 'Renew the lease (the manager does every ttl/3) or move the clock less far.',
            detectedBy: 'deadline',
          }),
        );
      }, ms);

    const acquire = async (key: Key, req: R): Promise<Grant | undefined> => {
      const granted = await ops.acquire(key, req);
      if (granted === undefined) return granted;
      const fence = guarantees.fence === false || granted.fence === undefined ? {} : { fence: granted.fence };
      if (!leased) return { key: granted.key, token: granted.token, ...fence };
      const leaseMs = req.ttlMs ?? ttlMs;
      const settlers: { resolve?: (error: LockError) => void } = {};
      const lost = new Promise<LockError>(resolve => {
        settlers.resolve = resolve;
      });
      const lose = (error: LockError): void => settlers.resolve?.(error);
      leases.set(granted.token, { grant: granted, timer: expireLater(granted.token, leaseMs), lose });
      return { key: granted.key, token: granted.token, ...fence, expiresAt: scheduler.now() + leaseMs, lost };
    };

    const release = (grant: Grant): Promise<ReleaseOutcome> => {
      if (!leased) return ops.release(grant);
      const lease = live(grant);
      // Expired, or never ours: the lease is gone.
      if (lease === undefined) return notOwner;
      scheduler.clearTimeout(lease.timer);
      leases.delete(grant.token);
      return ops.release(lease.grant);
    };

    const extend = (grant: Grant, leaseMs: number): Promise<boolean> => {
      const lease = live(grant);
      if (lease === undefined) return gone;
      scheduler.clearTimeout(lease.timer);
      lease.timer = expireLater(grant.token, leaseMs);
      return kept;
    };

    return leased ? { acquire, release, extend } : { acquire, release };
  }

  const mutex = keep(base);
  const permits = guarantees.permits
    ? { ...keep(base.permits), waiter: (key: Key, weight: number) => base.permits.waiter(key, weight) }
    : undefined;
  const shared = guarantees.shared
    ? { ...keep(base.shared), waiter: (key: Key, mode: 'read' | 'write') => base.shared.waiter(key, mode) }
    : undefined;

  return {
    name: 'test',
    guarantees,
    ...(leased ? { ttlMs } : {}),
    ...mutex,
    waitFor: (key: Key, signal: AbortSignal) => base.waitFor(key, signal),
    waiter: (key: Key) => base.waiter(key),
    ...(permits === undefined ? {} : { permits }),
    ...(shared === undefined ? {} : { shared }),
    dispose() {
      for (const leases of leaseTables) {
        for (const lease of leases.values()) scheduler.clearTimeout(lease.timer);
        leases.clear();
      }
      return Promise.resolve();
    },
  };
}
