import { describe, expectTypeOf, it } from 'vitest';

import type { PgExecutor } from './index.js';
import type { LeaseDb } from './lease.js';
import { createLocks } from '../index.js';
import { pgSession, pgTransaction } from './index.js';
import { pgLease } from './lease.js';

declare const db: { transaction<T>(run: (tx: PgExecutor) => Promise<T>): Promise<T> };
declare const tx: PgExecutor;
declare const leaseDb: LeaseDb;

describe('Postgres stores offer exactly the primitives they implement', () => {
  it('pgSession and pgTransaction have readWrite and no semaphore', () => {
    for (const locks of [
      createLocks({ store: pgSession(db), namespace: 'a' }),
      createLocks({ store: pgTransaction(tx), namespace: 'a' }),
    ]) {
      expectTypeOf(locks).toHaveProperty('readWrite');
      expectTypeOf(locks).not.toHaveProperty('semaphore');
    }
  });

  it('pgLease has a semaphore and no readWrite', () => {
    const locks = createLocks({ store: pgLease(leaseDb, { ttl: '10s' }), namespace: 'a' });
    expectTypeOf(locks).toHaveProperty('semaphore');
    expectTypeOf(locks).not.toHaveProperty('readWrite');
  });
});
