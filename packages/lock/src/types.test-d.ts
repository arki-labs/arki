import { describe, expectTypeOf, it } from 'vitest';

import type { FenceOf, Guarantees, Guard, LockContext, LockRun, Locks, Store } from './index.js';
import type { pgSession, pgTransaction } from './pg/index.js';
import { createLocks, LockError } from './index.js';

type Base = {
  readonly kind: 'hold';
  readonly scope: 'process';
  readonly wait: 'wake';
  readonly shared: true;
  readonly permits: true;
  readonly fence: 'process';
  readonly releasedOnCrash: 'immediate';
  readonly clock: 'none';
  readonly poolerSafe: true;
  readonly runtimes: readonly ['node'];
};
type With<P extends Partial<Guarantees>> = Omit<Base, keyof P> & P;

type ProcessHold = Store<With<Record<never, never>>>;
type ClusterHold = Store<With<{ scope: 'cluster'; permits: false; shared: false; fence: false }>>;
type ClusterLease = Store<With<{ kind: 'lease'; scope: 'cluster'; permits: true; shared: false; fence: 'durable' }>>;
type HostLease = Store<With<{ kind: 'lease'; scope: 'host'; permits: false; shared: false; fence: false }>>;

declare const processHold: ProcessHold;
declare const clusterHold: ClusterHold;
declare const clusterLease: ClusterLease;
declare const hostLease: HostLease;
declare const signal: AbortSignal;

const work = (): Promise<number> => Promise.resolve(1);
function noop(): void {
  // Intentionally empty.
}

describe('createLocks', () => {
  it('infers the store type and rejects a clock option', () => {
    const locks = createLocks({ store: processHold, namespace: 'app' });
    expectTypeOf(locks).toEqualTypeOf<Locks<ProcessHold>>();
    expectTypeOf(locks.store).toEqualTypeOf<ProcessHold>();

    // The Scheduler is the one seam for time. There is no `clock` option.
    // @ts-expect-error unknown option
    createLocks({ store: processHold, namespace: 'app', clock: { now: () => new Date() } });

    // @ts-expect-error store and namespace are required
    createLocks({});
  });

  it('accepts every documented option', () => {
    createLocks({
      store: clusterLease,
      namespace: 'app',
      storeTimeout: '10s',
      logKeys: true,
      onReleaseError: error => {
        expectTypeOf(error).toEqualTypeOf<LockError>();
      },
      scheduler: { now: () => 0, setTimeout: () => ({ id: 0 }), clearTimeout: noop },
    });
  });
});

describe('wait bound (Decision 2)', () => {
  it('run(fn) compiles without options on a process-scope store', () => {
    const mutex = createLocks({ store: processHold, namespace: 'a' }).mutex('k');
    expectTypeOf(mutex.run(work)).toEqualTypeOf<Promise<number>>();
    void mutex.run(work, { wait: '1s' });
    void mutex.acquire();
  });

  it('run(fn) needs wait or signal on a cluster store', () => {
    const mutex = createLocks({ store: clusterHold, namespace: 'a' }).mutex('k');
    // @ts-expect-error cluster scope needs a bound
    void mutex.run(work);
    // @ts-expect-error an empty options object is no bound
    void mutex.run(work, {});
    // @ts-expect-error holdAtLeast alone is no bound
    void mutex.run(work, { holdAtLeast: '1s' });
    // @ts-expect-error acquire needs a bound too
    void mutex.acquire();
    void mutex.run(work, { wait: '2s' });
    void mutex.run(work, { signal });
    void mutex.run(work, { wait: 500, signal });
    void mutex.acquire({ wait: '30s' });
  });

  it('host scope needs a bound as well', () => {
    const mutex = createLocks({ store: hostLease, namespace: 'a' }).mutex('k');
    // @ts-expect-error host scope is not process scope
    void mutex.run(work);
    void mutex.run(work, { wait: '1s' });
  });

  it('the try verbs never need a bound, on any store', () => {
    const mutex = createLocks({ store: clusterHold, namespace: 'a' }).mutex('k');
    expectTypeOf(mutex.tryRun(work)).toEqualTypeOf<Promise<LockRun<number>>>();
    expectTypeOf(mutex.tryAcquire()).toEqualTypeOf<Promise<Guard<ClusterHold> | undefined>>();
    // tryRun never waits, so it takes no `wait`.
    // @ts-expect-error no wait on a try verb
    void mutex.tryRun(work, { wait: '1s' });
  });

  it('Duration is a number, or a string with unit ms, s, m or h', () => {
    const mutex = createLocks({ store: clusterHold, namespace: 'a' }).mutex('k');
    void mutex.run(work, { wait: 10 });
    void mutex.run(work, { wait: '10ms' });
    void mutex.run(work, { wait: '1.5s' });
    void mutex.run(work, { wait: '2m' });
    void mutex.run(work, { wait: '1h' });
    // @ts-expect-error no days
    void mutex.run(work, { wait: '1d' });
    // @ts-expect-error no weeks
    void mutex.run(work, { wait: '1w' });
  });
});

describe('capability gating', () => {
  it('semaphore is absent when permits is false', () => {
    const locks = createLocks({ store: clusterHold, namespace: 'a' });
    expectTypeOf(locks).not.toHaveProperty('semaphore');
    // @ts-expect-error no permits on this store
    locks.semaphore('pdf', { limit: 3 });
  });

  it('semaphore exists when permits is true and needs a limit', () => {
    const locks = createLocks({ store: processHold, namespace: 'a' });
    expectTypeOf(locks).toHaveProperty('semaphore');
    void locks.semaphore('pdf', { limit: 3 }).run(work, { weight: 1 });
    // @ts-expect-error limit is required
    locks.semaphore('pdf', {});
  });

  it('readWrite exists only when shared is true', () => {
    expectTypeOf(createLocks({ store: processHold, namespace: 'a' })).toHaveProperty('readWrite');
    expectTypeOf(createLocks({ store: clusterHold, namespace: 'a' })).not.toHaveProperty('readWrite');
  });

  it('extend is never on a hold store and a function on a lease store', () => {
    expectTypeOf<Guard<ClusterHold>['extend']>().toBeNever();
    expectTypeOf<Guard<ProcessHold>['extend']>().toBeNever();
    expectTypeOf<Guard<ClusterLease>['extend']>().toEqualTypeOf<() => Promise<void>>();
    expectTypeOf<Guard<ClusterHold>['expiresAt']>().toBeUndefined();
    expectTypeOf<Guard<ClusterLease>['expiresAt']>().toBeNumber();
  });

  it('lead is absent on hold stores and present on lease stores', () => {
    const hold = createLocks({ store: clusterHold, namespace: 'a' }).mutex('k');
    expectTypeOf(hold).not.toHaveProperty('lead');
    // @ts-expect-error leader election needs a lease store
    void hold.lead(work);

    const lease = createLocks({ store: clusterLease, namespace: 'a' }).mutex('k');
    expectTypeOf(lease).toHaveProperty('lead');
    expectTypeOf(lease.lead(noop, { signal })).toEqualTypeOf<Promise<void>>();
    // @ts-expect-error lead takes only a signal
    void lease.lead(noop, { wait: '1s' });
  });

  it('a store typed with the wide Guarantees exposes no optional capability', () => {
    const wide = createLocks({ store: {} as Store, namespace: 'a' });
    expectTypeOf(wide).not.toHaveProperty('semaphore');
    expectTypeOf(wide.mutex('k')).not.toHaveProperty('lead');
  });
});

describe('holdAtLeast', () => {
  it('compiles on both store kinds, in every verb', () => {
    const hold = createLocks({ store: clusterHold, namespace: 'a' }).mutex('k');
    const lease = createLocks({ store: clusterLease, namespace: 'a' }).mutex('k');
    void hold.run(work, { wait: '1s', holdAtLeast: '1s' });
    void lease.run(work, { wait: '1s', holdAtLeast: 1000 });
    void hold.tryRun(work, { holdAtLeast: '500ms' });
    void lease.tryRun(work, { holdAtLeast: '500ms' });
    void hold.acquire({ signal, holdAtLeast: '1s' });
    void lease.tryAcquire({ holdAtLeast: '1s' });
    // @ts-expect-error not a Duration
    void lease.tryRun(work, { holdAtLeast: '1 day' });
  });
});

describe('callback context and guard', () => {
  it('fence is bigint when the store has fences and undefined when it has none', () => {
    expectTypeOf<FenceOf<ClusterLease>>().toEqualTypeOf<bigint>();
    expectTypeOf<FenceOf<ProcessHold>>().toEqualTypeOf<bigint>();
    expectTypeOf<FenceOf<ClusterHold>>().toEqualTypeOf<undefined>();
    expectTypeOf<LockContext<ClusterLease>['fence']>().toEqualTypeOf<bigint>();
    expectTypeOf<LockContext<ClusterHold>['signal']>().toEqualTypeOf<AbortSignal>();
  });

  it('the callback gets signal, fence and key, and its result type flows out', () => {
    const mutex = createLocks({ store: clusterLease, namespace: 'a' }).mutex('k');
    const run = mutex.run(
      ({ signal: lost, fence, key }) => {
        expectTypeOf(lost).toEqualTypeOf<AbortSignal>();
        expectTypeOf(fence).toEqualTypeOf<bigint>();
        expectTypeOf(key.full).toBeString();
        return 'done' as const;
      },
      { wait: '1s' },
    );
    expectTypeOf(run).toEqualTypeOf<Promise<'done'>>();
  });

  it('a guard has a boolean held flag and a signal', () => {
    expectTypeOf<Guard<ClusterHold>['held']>().toEqualTypeOf<boolean>();
    expectTypeOf<Guard<ClusterHold>['signal']>().toEqualTypeOf<AbortSignal>();
    expectTypeOf<Guard<ClusterHold>['release']>().toEqualTypeOf<() => Promise<void>>();
  });
});

describe('LockError', () => {
  it('carries the review fields', () => {
    const error = new LockError({ code: 'lost', message: 'x', remediation: 'y', detectedBy: 'deadline' });
    expectTypeOf(error.code).toEqualTypeOf<
      'held' | 'aborted' | 'lost' | 'store' | 'release' | 'config' | 'unsupported'
    >();
    expectTypeOf(error.detectedBy).toEqualTypeOf<'renewal' | 'deadline' | 'connection' | undefined>();
    expectTypeOf(error.method).toEqualTypeOf<
      'acquire' | 'release' | 'extend' | 'waitFor' | 'permits' | 'shared' | undefined
    >();
    expectTypeOf(error.timeoutMs).toEqualTypeOf<number | undefined>();
    expectTypeOf(error.outcome).toEqualTypeOf<'not-acquired' | 'unknown' | undefined>();
    expectTypeOf(error.suppressed).toEqualTypeOf<readonly Error[] | undefined>();
  });
});

describe('lease stores carry their ttl', () => {
  it('requires ttlMs on a lease store and not on a hold store', () => {
    expectTypeOf<ClusterLease['ttlMs']>().toBeNumber();
    expectTypeOf<HostLease['ttlMs']>().toBeNumber();
    expectTypeOf<ClusterHold>().not.toHaveProperty('ttlMs');
    // A lease store without a ttl is not a lease store: the manager could not know how long its lease lasts.
    expectTypeOf<Omit<ClusterLease, 'ttlMs'>>().not.toExtend<ClusterLease>();
  });
});

describe('guards of transaction-owned locks', () => {
  type TxStore = ReturnType<typeof pgTransaction>;
  type SessionStore = ReturnType<typeof pgSession>;

  it("pgTransaction guards have no release or asyncDispose, because the caller's transaction ends the lock", () => {
    expectTypeOf<Guard<TxStore>>().not.toHaveProperty('release');
    expectTypeOf<Guard<TxStore>>().not.toHaveProperty(Symbol.asyncDispose);
    expectTypeOf<Guard<TxStore>>().toHaveProperty('signal');
  });

  it('pgSession guards keep release and asyncDispose', () => {
    expectTypeOf<Guard<SessionStore>>().toHaveProperty('release');
    expectTypeOf<Guard<SessionStore>['release']>().toEqualTypeOf<() => Promise<void>>();
    expectTypeOf<Guard<SessionStore>>().toHaveProperty(Symbol.asyncDispose);
  });
});
