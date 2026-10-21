/**
 * The point of `testStore`: an app test provides the production `locks` service on an
 * in-memory store with no cast. The `locks()` plugin types its service by the store's
 * guarantees, so a manager on `testStore(sameGuarantees)` has exactly that type.
 */
import { describe, expectTypeOf, it } from 'vitest';

import type { Provided } from '@arki/dot/unit';
import { fake } from '@arki/dot';
import { service } from '@arki/dot/unit';

import type { MemoryGuarantees, MemoryStore } from '../memory.js';
import type { LockableDb, PgSessionGuarantees } from '../pg/index.js';
import type { LeaseDb, PgLeasePollGuarantees } from '../pg/lease.js';
import type { Locks, LocksFor } from '../types.js';
import { describeLocks, locks } from '../dot/index.js';
import { createLocks } from '../locks.js';
import { pgSession, pgSessionGuarantees } from '../pg/index.js';
import { pgLease, pgLeasePollGuarantees } from '../pg/lease.js';
import { manualScheduler } from './manual-scheduler.js';
import { testStore } from './test-store.js';

const sessionLocking = locks({
  namespace: 'app',
  needs: { db: service<LockableDb>() },
  store: ({ db }) => pgSession(db),
});

const leaseLocking = locks({
  namespace: 'app',
  needs: { db: service<LeaseDb>() },
  store: ({ db }) => pgLease(db, { ttl: '30s' }),
});

describe('the locks() service is typed by guarantees, so a test store fits it', () => {
  it('publishes LocksFor<G>, and the manager of the real store is assignable to it', () => {
    expectTypeOf<Provided<typeof sessionLocking.provides.locks>>().toEqualTypeOf<LocksFor<PgSessionGuarantees>>();
    expectTypeOf<Locks<ReturnType<typeof pgSession>>>().toExtend<LocksFor<PgSessionGuarantees>>();
    expectTypeOf<Locks<MemoryStore>>().toExtend<LocksFor<MemoryGuarantees>>();
  });

  it('fakes a pgSession service with testStore(pgSessionGuarantees), no cast', () => {
    const clock = manualScheduler();
    const handle = createLocks({
      store: testStore(pgSessionGuarantees, { scheduler: clock }),
      namespace: 'app',
      scheduler: clock,
    });
    expectTypeOf(handle).toExtend<Provided<typeof sessionLocking.provides.locks>>();
    fake(sessionLocking.provides.locks, handle);
    // pgSession has read/write locks, no semaphore and no leader election; neither has the fake.
    expectTypeOf(handle).toHaveProperty('readWrite');
    expectTypeOf(handle).not.toHaveProperty('semaphore');
    expectTypeOf(handle.mutex('k')).not.toHaveProperty('lead');
    expectTypeOf(describeLocks(handle).kind).toEqualTypeOf<'hold' | 'lease'>();
  });

  it('fakes a pgLease service with testStore(pgLeasePollGuarantees): a lease, so lead exists', () => {
    const clock = manualScheduler();
    const handle = createLocks({
      store: testStore(pgLeasePollGuarantees, { scheduler: clock, ttl: '30s' }),
      namespace: 'app',
      scheduler: clock,
    });
    expectTypeOf(handle).toExtend<LocksFor<PgLeasePollGuarantees>>();
    fake(leaseLocking.provides.locks, handle);
    expectTypeOf(handle.mutex('k')).toHaveProperty('lead');
    expectTypeOf(handle).toHaveProperty('semaphore');
    expectTypeOf(handle).not.toHaveProperty('readWrite');
  });

  it('refuses a test store whose guarantees differ from the service, so a fake cannot promise less', () => {
    const clock = manualScheduler();
    const handle = createLocks({
      store: testStore(pgSessionGuarantees, { scheduler: clock }),
      namespace: 'app',
      scheduler: clock,
    });
    expectTypeOf(handle).not.toExtend<Provided<typeof leaseLocking.provides.locks>>();
  });
});
