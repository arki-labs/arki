import { orThrow } from '@arki/failure';
import { lockTokenSchema } from './../identity-schemas.js';
/**
 * `testStore` keeps the promises of the store it stands in for: the shared contract suite runs
 * against it with the guarantees of each production store. A case is skipped only for a
 * capability that set of guarantees does not claim.
 */
import { describe, expect, it } from 'vitest';

import type { Guarantees } from '../types.js';
import { createKey } from '../key.js';
import { memoryGuarantees } from '../memory.js';
import { pgSessionGuarantees, pgTransactionGuarantees } from '../pg/index.js';
import { pgLeasePollGuarantees, pgLeaseWakeGuarantees } from '../pg/lease.js';
import { redisGuarantees } from '../redis/index.js';
import { describeStoreContract } from './index.js';
import { manualScheduler } from './manual-scheduler.js';
import { testStore } from './test-store.js';

const TTL_MS = 3000;

/** A fresh store per case, each with its own manual clock. */
function makeStore(guarantees: Guarantees) {
  return () => {
    const scheduler = manualScheduler();
    return {
      store: testStore(guarantees, { scheduler, ttl: TTL_MS }),
      scheduler,
      advanceTime: (ms: number) => scheduler.advance(ms),
    };
  };
}

describeStoreContract('testStore(memoryGuarantees)', makeStore(memoryGuarantees));
describeStoreContract('testStore(pgSessionGuarantees)', makeStore(pgSessionGuarantees));
describeStoreContract('testStore(pgTransactionGuarantees)', makeStore(pgTransactionGuarantees));
describeStoreContract('testStore(pgLeasePollGuarantees)', makeStore(pgLeasePollGuarantees));
describeStoreContract('testStore(pgLeaseWakeGuarantees)', makeStore(pgLeaseWakeGuarantees));
describeStoreContract('testStore(redisGuarantees)', makeStore(redisGuarantees));

describe('testStore', () => {
  it('hands out no fence when the guarantees say fence: false, so code that needs one fails in tests too', async () => {
    const store = testStore(pgSessionGuarantees);
    const grant = orThrow(await store.acquire(createKey('t', 'k'), { token: lockTokenSchema.parse('a') }));
    expect(grant).toBeDefined();
    expect(grant?.fence).toBeUndefined();
  });

  it('has no semaphore ops when permits is false, and no read/write ops when shared is false', () => {
    expect(testStore(pgSessionGuarantees).permits).toBeUndefined();
    expect(testStore(pgLeasePollGuarantees).shared).toBeUndefined();
  });

  it('resolves grant.lost when a lease runs out on the test clock, so the holder learns it lost the key', async () => {
    const scheduler = manualScheduler();
    const store = testStore(pgLeasePollGuarantees, { scheduler, ttl: TTL_MS });
    const key = createKey('t', 'lease');
    const grant = orThrow(await store.acquire(key, { token: lockTokenSchema.parse('a'), ttlMs: TTL_MS }));
    expect(grant?.expiresAt).toBe(TTL_MS);
    let lost: unknown;
    void grant?.lost?.then(error => {
      lost = error;
    });
    await scheduler.advance(TTL_MS - 1);
    expect(lost).toBeUndefined();
    await scheduler.advance(1);
    expect(lost).toMatchObject({ code: 'lost', detectedBy: 'deadline' });
    expect(await store.acquire(key, { token: lockTokenSchema.parse('b'), ttlMs: TTL_MS })).toBeDefined();
  });

  it('keeps a lease that is extended before it runs out', async () => {
    const scheduler = manualScheduler();
    const store = testStore(pgLeasePollGuarantees, { scheduler, ttl: TTL_MS });
    const key = createKey('t', 'extend');
    const grant = orThrow(await store.acquire(key, { token: lockTokenSchema.parse('a'), ttlMs: TTL_MS }));
    if (grant === undefined) throw new Error('expected a grant');
    await scheduler.advance(TTL_MS - 1);
    expect(await store.extend?.(grant, TTL_MS)).toBe(true);
    await scheduler.advance(TTL_MS - 1);
    expect(await store.acquire(key, { token: lockTokenSchema.parse('b'), ttlMs: TTL_MS })).toBeUndefined();
    expect(await store.release(grant)).toBe('released');
  });
});
