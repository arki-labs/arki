import { describe, expect, it } from 'vitest';

import { defineFailure, isFailure, UnexpectedDefect } from '@arki/failure';

import { LockAborted, LockStoreFailure, createLocks } from './index.js';
import { memoryStore } from './memory.js';

describe('owned lock outcomes', () => {
  it('returns cancellation before work starts', async () => {
    const locks = createLocks({ store: memoryStore(), namespace: 'outcomes' });
    let calls = 0;
    const result = await locks.mutex('cancel').tryRun(() => ++calls, { signal: AbortSignal.abort() });
    expect(LockAborted.is(result)).toBe(true);
    expect(calls).toBe(0);
  });

  it('supervises a callback defect once and keeps its cause private', async () => {
    const locks = createLocks({ store: memoryStore(), namespace: 'outcomes' });
    let calls = 0;
    const result = await locks.mutex('defect').tryRun(() => {
      calls++;
      throw new Error('private credential');
    });
    expect(UnexpectedDefect.is(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private credential');
    expect(calls).toBe(1);
    expect(isFailure(await locks.mutex('defect').tryAcquire())).toBe(false);
  });

  it('preserves a callback failure by identity, including cleanup failure', async () => {
    const Declined = defineFailure('test.declined', { message: 'declined' });
    const declined = Declined();
    const store = memoryStore();
    const locks = createLocks({
      store: { ...store, release: () => Promise.reject(new Error('provider unavailable')) },
      namespace: 'outcomes',
    });
    expect(await locks.mutex('identity').tryRun(() => declined)).toBe(declined);
  });

  it('keeps provider failure distinct from contention and explicit about unknown ownership', async () => {
    const store = memoryStore();
    const locks = createLocks({
      store: { ...store, acquire: () => Promise.reject(new Error('provider unavailable')) },
      namespace: 'outcomes',
    });
    const result = await locks.mutex('provider').tryAcquire();
    expect(LockStoreFailure.is(result)).toBe(true);
    if (LockStoreFailure.is(result)) expect(result.data.outcome).toBe('unknown');
  });

  it('does not replay successful work when the asynchronous release observer rejects', async () => {
    let calls = 0;
    const store = memoryStore();
    const locks = createLocks({
      store: { ...store, release: () => Promise.reject(new Error('provider unavailable')) },
      namespace: 'outcomes',
      onReleaseError: async () => { throw new Error('observer rejected'); },
    });
    expect(await locks.mutex('observer').tryRun(() => ++calls)).toBe(1);
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(locks.counters.releaseErrors).toBe(1);
  });
});

it('round-trips version 1 canonical outcomes without leaking private causes', async () => {
  const { serialize, revive } = await import('@arki/failure');
  const { LOCK_FAILURES, LockAborted, LockLost, LockStoreFailure, LockReleaseFailed } = await import('./index.js');
  const outcomes = [
    LockAborted({ cause: new Error('private cancellation') }),
    LockLost({ detectedBy: 'connection' }, { cause: new Error('private provider') }),
    LockStoreFailure({ method: 'ddl', outcome: 'unknown' }, { cause: new Error('private DDL') }),
    LockReleaseFailed({ outcome: 'unknown' }),
  ];
  for (const outcome of outcomes) {
    const envelope = serialize(outcome, LOCK_FAILURES);
    expect(isFailure(envelope)).toBe(false);
    expect(envelope).toHaveProperty('version', 1);
    expect(JSON.stringify(envelope)).not.toContain('private');
    const revived = revive(envelope, LOCK_FAILURES);
    expect(revived).toMatchObject({ code: outcome.code, data: outcome.data });
    // `cause` is a prototype getter on every failure, so check its value.
    expect(revived?.cause).toBeUndefined();
  }
});
