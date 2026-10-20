import { expectTypeOf, it } from 'vitest';
import { pgSchema } from 'drizzle-orm/pg-core';
import type { z } from 'zod';

import { defineId } from '@arki/contracts';
import type { IdOf } from '@arki/contracts';
import type { FailureOf } from '@arki/failure';

import type { idempotencyKeyId } from '../../src/orpc/idempotency-id';
import type { IdempotencyKeyId } from '../../src/orpc/idempotency-id';
import type { IDEMPOTENCY_STORE_FAILURES, IdempotencyStoreFailure } from '../../src/orpc/idempotency-failures';
import type { IdempotencyRepository } from '../../src/orpc/idempotency-repository';
import { createIdempotencyTable } from '../../src/orpc/idempotency-table';
import type { idempotencyKeys } from '../../src/orpc/idempotency-table';

it('infers the exact canonical record brand and write failures without restating them', () => {
  const _otherId = defineId('idk_', { kind: 'offline.other' });
  const _namespaced = createIdempotencyTable(pgSchema('app'));
  expectTypeOf<IdempotencyKeyId>().toEqualTypeOf<IdOf<typeof idempotencyKeyId>>();
  expectTypeOf<IdempotencyKeyId>().toEqualTypeOf<z.output<typeof idempotencyKeyId.schema>>();
  expectTypeOf<IdempotencyKeyId>().not.toExtend<IdOf<typeof _otherId>>();
  expectTypeOf<string>().not.toExtend<IdempotencyKeyId>();
  expectTypeOf<`idk_${string}`>().not.toExtend<IdempotencyKeyId>();
  expectTypeOf<typeof idempotencyKeys.$inferSelect.id>().toEqualTypeOf<IdempotencyKeyId>();
  expectTypeOf<typeof _namespaced.$inferSelect.id>().toEqualTypeOf<IdempotencyKeyId>();
  expectTypeOf<typeof idempotencyKeys.$inferInsert.id>().toEqualTypeOf<IdempotencyKeyId>();
  expectTypeOf<FailureOf<IdempotencyRepository['store']>>().toEqualTypeOf<IdempotencyStoreFailure>();
  expectTypeOf<IdempotencyStoreFailure>().toEqualTypeOf<FailureOf<(typeof IDEMPOTENCY_STORE_FAILURES)[number]>>();
  expectTypeOf<Awaited<ReturnType<IdempotencyRepository['store']>>>().toEqualTypeOf<void | IdempotencyStoreFailure>();
});
