import { pgTable } from 'drizzle-orm/pg-core';
import { expectTypeOf, test } from 'vitest';

import type { z } from '@arki/contracts';
import { defineId } from '@arki/contracts';
import { createInsertSchema } from '@arki/contracts/drizzle';

import { createIdFactory, idColumns } from './id-factory.js';

test('legacy factories derive the id solely from the stored prefix', () => {
  const _factory = createIdFactory('pt_');
  expectTypeOf<ReturnType<typeof _factory.create>>().toEqualTypeOf<`pt_${string}`>();
  expectTypeOf<z.input<typeof _factory.schema>>().toEqualTypeOf<string>();
  expectTypeOf<z.output<typeof _factory.schema>>().toEqualTypeOf<ReturnType<typeof _factory.create>>();
  // @ts-expect-error A prefix cannot prove an arbitrarily narrower caller-supplied id type.
  createIdFactory<'pt_', 'pt_fixed'>('pt_');
});

test('ID defaults and foreign-key nullability agree with parsed output', () => {
  const id = defineId('row_');
  const columns = idColumns(id);
  const table = pgTable('rows', { id: columns.primaryColumn(), parentId: columns.optionalReference('parent_id') });
  const _insert = createInsertSchema(table, { id: () => id.schema, parentId: () => id.schema });
  expectTypeOf<z.output<typeof _insert>['id']>().toEqualTypeOf<z.output<typeof id.schema> | undefined>();
  expectTypeOf<z.output<typeof _insert>['parentId']>().toEqualTypeOf<z.output<typeof id.schema> | null | undefined>();
  // @ts-expect-error A generator must produce the declared schema's ID type.
  idColumns({ schema: id.schema, create: () => 42 });
  // @ts-expect-error Prefix mismatches cannot widen the schema's inferred ID type.
  idColumns({ schema: id.schema, create: () => 'wrong_1' });
});
