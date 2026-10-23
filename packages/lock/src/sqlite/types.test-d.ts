import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { describe, expectTypeOf, it } from 'vitest';

import { createLocks } from '../index.js';
import { sqliteLease } from './index.js';

declare const db: LibSQLDatabase;

describe('sqliteLease', () => {
  it('takes a Drizzle libSQL database as it is: no cast, no type argument', () => {
    const store = sqliteLease(db, { ttl: '10s' });
    expectTypeOf(store.guarantees.fence).toEqualTypeOf<'durable'>();
  });

  it('has a semaphore and no readWrite', () => {
    const locks = createLocks({ store: sqliteLease(db, { ttl: '10s' }), namespace: 'a' });
    expectTypeOf(locks).toHaveProperty('semaphore');
    expectTypeOf(locks).not.toHaveProperty('readWrite');
  });

  it('refuses a handle without raw SQL', () => {
    // @ts-expect-error a client with only `execute` is not a Drizzle SQLite database
    sqliteLease({ execute: () => Promise.resolve() }, { ttl: '10s' });
  });
});
