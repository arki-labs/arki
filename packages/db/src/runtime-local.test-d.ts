import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { expectTypeOf, test } from 'vitest';

import type { IdGenerationFailure, IdOf, z } from '@arki/contracts';
import type { FailureOf, SuccessOf } from '@arki/failure';
import { defineId } from '@arki/contracts';

import type { acquireOwnerLock, ownerId } from './owner-lock.js';
import type {
  initDbRuntimeLocal,
  LOCAL_RUNTIME_CLOSE_FAILURES,
  LOCAL_RUNTIME_FAILURES,
  OWNER_LOCK_FAILURES,
} from './runtime-local.js';

test('owner identity derives from the declaration and never accepts another UUID kind', () => {
  const _other = defineId('', { kind: 'db.other', format: 'uuid' });
  expectTypeOf<IdOf<typeof ownerId>>().toEqualTypeOf<z.output<typeof ownerId.schema>>();
  expectTypeOf<IdOf<typeof ownerId>>().not.toExtend<IdOf<typeof _other>>();
  expectTypeOf<string>().not.toExtend<IdOf<typeof ownerId>>();
  expectTypeOf<FailureOf<typeof ownerId.create>>().toEqualTypeOf<IdGenerationFailure>();
});

test('owned boundaries expose only their canonical exact failure definitions', () => {
  expectTypeOf<FailureOf<typeof acquireOwnerLock>>().toEqualTypeOf<FailureOf<(typeof OWNER_LOCK_FAILURES)[number]>>();
  expectTypeOf<FailureOf<typeof initDbRuntimeLocal>>().toEqualTypeOf<
    FailureOf<(typeof LOCAL_RUNTIME_FAILURES)[number]>
  >();
  const _relations = {};
  type Local = SuccessOf<typeof initDbRuntimeLocal<typeof _relations>>;
  expectTypeOf<Local['db']>().toEqualTypeOf<PgliteDatabase<typeof _relations>>();
  expectTypeOf<Local['pglite']>().toEqualTypeOf<PGlite>();
  expectTypeOf<ReturnType<Local['pglite']['close']>>().toEqualTypeOf<Promise<void>>();
  expectTypeOf<FailureOf<Local['close']>>().toEqualTypeOf<FailureOf<(typeof LOCAL_RUNTIME_CLOSE_FAILURES)[number]>>();
  expectTypeOf<SuccessOf<Local['close']>>().toEqualTypeOf<void>();
});
