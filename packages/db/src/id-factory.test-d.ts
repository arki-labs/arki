import { pgTable } from 'drizzle-orm/pg-core';
import { expectTypeOf, test } from 'vitest';

import type { IdGenerationFailure, IdOf, z } from '@arki/contracts';
import type { FailureOf } from '@arki/failure';
import { defineId, RandomSourceUnavailable } from '@arki/contracts';
import { createInsertSchema } from '@arki/contracts/drizzle';
import { defineFailure } from '@arki/failure';

import type { IdColumnSource } from './id-factory.js';
import { createIdFactory, idColumns } from './id-factory.js';

test('legacy factories derive the id solely from the stored prefix', () => {
  const _factory = createIdFactory('pt_');
  expectTypeOf<ReturnType<typeof _factory.create>>().toEqualTypeOf<`pt_${string}` | IdGenerationFailure>();
  expectTypeOf<typeof _factory.make>().toEqualTypeOf<typeof _factory.create>();
  expectTypeOf<typeof _factory.new>().toEqualTypeOf<typeof _factory.create>();
  expectTypeOf<z.input<typeof _factory.schema>>().toEqualTypeOf<string>();
  expectTypeOf<z.output<typeof _factory.schema>>().toEqualTypeOf<`pt_${string}`>();
  expectTypeOf<IdOf<typeof _factory>>().toEqualTypeOf<`pt_${string}`>();
  // @ts-expect-error A prefix cannot prove an arbitrarily narrower caller-supplied id type.
  createIdFactory<'pt_', 'pt_fixed'>('pt_');
});

test('ID defaults and foreign-key nullability agree with parsed output', () => {
  const id = defineId('row_');
  const columns = idColumns(id);
  const table = pgTable('rows', { id: columns.primaryColumn(), parentId: columns.optionalReference('parent_id') });
  expectTypeOf<typeof table.$inferSelect.id>().toEqualTypeOf<`row_${string}`>();
  expectTypeOf<FailureOf<IdColumnSource<`row_${string}`>['create']>>().toEqualTypeOf<IdGenerationFailure>();
  const _insert = createInsertSchema(table, { id: () => id.schema, parentId: () => id.schema });
  expectTypeOf<z.output<typeof _insert>['id']>().toEqualTypeOf<z.output<typeof id.schema> | undefined>();
  expectTypeOf<z.output<typeof _insert>['parentId']>().toEqualTypeOf<z.output<typeof id.schema> | null | undefined>();
  // @ts-expect-error A generator must produce the declared schema's ID type.
  idColumns({ schema: id.schema, create: () => 42 });
  // @ts-expect-error Prefix mismatches cannot widen the schema's inferred ID type.
  idColumns({ schema: id.schema, create: () => 'wrong_1' });
  idColumns({ schema: id.schema, create: () => RandomSourceUnavailable() });
  const Unrelated = defineFailure('test.unrelated_generation_failure');
  // @ts-expect-error Only the canonical ID generation failures belong in an ID column source.
  idColumns({ schema: id.schema, create: () => Unrelated() });
});

test('nominal IDs survive inferred columns and canonical storage reconstruction', () => {
  const refundId = defineId('id_', { kind: 'billing.refund' });
  const paymentId = defineId('id_', { kind: 'billing.payment' });
  const refunds = pgTable('nominal_refunds', {
    id: idColumns(refundId).primaryColumn(),
    paymentId: idColumns(paymentId).reference('payment_id'),
  });
  expectTypeOf<typeof refunds.$inferSelect.id>().toEqualTypeOf<IdOf<typeof refundId>>();
  expectTypeOf<typeof refunds.$inferSelect.paymentId>().toEqualTypeOf<IdOf<typeof paymentId>>();
  const source: IdColumnSource<IdOf<typeof refundId>> = refundId;
  const _fromSource = pgTable('source_refunds', { id: idColumns(source).primaryColumn() });
  expectTypeOf<typeof _fromSource.$inferSelect.id>().toEqualTypeOf<IdOf<typeof refundId>>();
  const _schema = createInsertSchema(refunds, { id: () => refundId.schema, paymentId: () => paymentId.schema });
  expectTypeOf<z.output<typeof _schema>['id']>().toEqualTypeOf<IdOf<typeof refundId> | undefined>();
  expectTypeOf<z.output<typeof _schema>['paymentId']>().toEqualTypeOf<IdOf<typeof paymentId>>();
  expectTypeOf<IdOf<typeof paymentId>>().not.toExtend<(typeof refunds.$inferInsert)['id']>();
  // @ts-expect-error A typed column cannot accept a generator for another nominal kind.
  idColumns({ schema: refundId.schema, create: paymentId.create });
});
