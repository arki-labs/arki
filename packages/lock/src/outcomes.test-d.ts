import { describe, expectTypeOf, it } from 'vitest';

import type { FailureOf } from '@arki/failure';
import { defineFailure } from '@arki/failure';

import type { Grant, LockFence, LockKey, LockRunFailure, LockToken, StoreFailure } from './index.js';
import { LOCK_FAILURES, createLocks } from './index.js';
import { memoryStore } from './memory.js';
import { lockFenceSchema, lockKeySchema, lockTokenSchema } from './zod.js';
import { pgTransaction } from './pg/index.js';
import type { PgExecutor } from './pg/index.js';

const Declined = defineFailure('test.declined', { message: 'declined' });
const Expired = defineFailure('test.expired', { message: 'expired' });
declare const tx: PgExecutor;

describe('canonical lock outcome and identity sources', () => {
  it('preserves heterogeneous callback failures with the exact owned union', () => {
    const locks = createLocks({ store: memoryStore(), namespace: 'types' });
    const result = locks.mutex('key').tryRun(() => Math.random() > 0.5 ? Declined() : Expired());
    expectTypeOf(result).toEqualTypeOf<Promise<ReturnType<typeof Declined> | ReturnType<typeof Expired> | LockRunFailure>>();
    expectTypeOf<LockRunFailure>().toExtend<FailureOf<(typeof LOCK_FAILURES)[number]>>();
  });

  it('keeps memory total while the named provider exposes exactly its store failure', () => {
    expectTypeOf<Awaited<ReturnType<ReturnType<typeof memoryStore>['acquire']>>>().toEqualTypeOf<
      Grant | undefined
    >();
    expectTypeOf<Extract<Awaited<ReturnType<ReturnType<typeof pgTransaction>['acquire']>>, { code: string }>>().toEqualTypeOf<StoreFailure>();
    void tx;
  });

  it('locks nominal schemas to their source types in both directions', () => {
    expectTypeOf<ReturnType<typeof lockKeySchema.parse>>().toEqualTypeOf<LockKey>();
    expectTypeOf<ReturnType<typeof lockTokenSchema.parse>>().toEqualTypeOf<LockToken>();
    expectTypeOf<ReturnType<typeof lockFenceSchema.parse>>().toEqualTypeOf<LockFence>();
    expectTypeOf<LockKey>().not.toEqualTypeOf<LockToken>();
    expectTypeOf<string>().not.toExtend<LockToken>();
    expectTypeOf<bigint>().not.toExtend<LockFence>();
  });
});
