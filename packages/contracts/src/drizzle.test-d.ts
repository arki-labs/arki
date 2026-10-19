import type { jsonSchema as nativeJsonSchema } from 'drizzle-orm/zod';
import { sql } from 'drizzle-orm';
import { json as mysqlJson, mysqlTable } from 'drizzle-orm/mysql-core';
import { integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { sqliteTable, text as sqliteText } from 'drizzle-orm/sqlite-core';
import { expectTypeOf, test } from 'vitest';
import { z } from 'zod';

import { createInsertSchema, createSelectSchema, createUpdateSchema, jsonColumn } from './drizzle.js';
import { defineId } from './ids.js';

const profileSchema = z.object({ age: z.number(), tags: z.array(z.array(z.string())).optional() });
const table = pgTable('profiles', {
  profile: jsonColumn('profile', profileSchema).notNull(),
  nullable: jsonColumn('nullable', profileSchema),
  defaulted: jsonColumn('defaulted', profileSchema).notNull().default({ age: 1 }),
  generated: integer('generated').generatedAlwaysAs(sql`1`),
  raw: jsonb('raw').$type<z.output<typeof profileSchema>>().notNull(),
});
const refine = { profile: () => profileSchema, nullable: () => profileSchema, defaulted: () => profileSchema };
const _select = createSelectSchema(table, refine);
const _insert = createInsertSchema(table, refine);
const _update = createUpdateSchema(table, refine);

test('explicit runtime schemas are the single source of nested JSON types', () => {
  const _implicit = createSelectSchema(table);
  expectTypeOf<z.output<typeof _implicit>['raw']>().toEqualTypeOf<z.output<typeof nativeJsonSchema>>();
  // @ts-expect-error A refinement cannot name a column absent from the table.
  createSelectSchema(table, { absent: z.string() });
  // @ts-expect-error Unknown keys remain rejected when mixed with valid callback refinements.
  createSelectSchema(table, { profile: () => profileSchema, absent: z.string() });
  expectTypeOf<z.output<typeof _select>['profile']>().toEqualTypeOf<z.output<typeof profileSchema>>();
  expectTypeOf<z.output<typeof _select>['nullable']>().toEqualTypeOf<z.output<typeof profileSchema> | null>();
  expectTypeOf<z.output<typeof _insert>['defaulted']>().toEqualTypeOf<z.output<typeof profileSchema> | undefined>();
  expectTypeOf<z.output<typeof _insert>['nullable']>().toEqualTypeOf<
    z.output<typeof profileSchema> | null | undefined
  >();
  expectTypeOf<z.output<typeof _update>['profile']>().toEqualTypeOf<z.output<typeof profileSchema> | undefined>();
  expectTypeOf<typeof table.$inferSelect.profile>().toEqualTypeOf<z.output<typeof profileSchema>>();
  expectTypeOf<'generated'>().not.toExtend<keyof z.output<typeof _insert>>();
  // @ts-expect-error Nested JSON must satisfy the runtime schema.
  const wrong: z.output<typeof _select>['profile'] = { age: 'wrong' };
  // @ts-expect-error Nested arrays retain their leaf type.
  const wrongArray: z.output<typeof _select>['profile'] = { age: 1, tags: [[1]] };
  void wrong;
  void wrongArray;
});

test('brands and wire codecs retain distinct inputs and outputs', () => {
  const id = defineId('usr_');
  const wire = z.codec(z.string(), z.number(), { decode: Number, encode: String });
  const values = pgTable('values', { id: text('id').notNull(), count: integer('count').notNull().default(0) });
  const _schema = createInsertSchema(values, { id: () => id.schema, count: () => wire });
  expectTypeOf<z.input<typeof _schema>['count']>().toEqualTypeOf<string | undefined>();
  expectTypeOf<z.output<typeof _schema>['count']>().toEqualTypeOf<number | undefined>();
  expectTypeOf<z.output<typeof _schema>['id']>().toEqualTypeOf<z.output<typeof id.schema>>();
  // @ts-expect-error A wire codec is not a stable storage schema: give jsonColumn its output schema.
  jsonColumn('count', wire);
});

test('JSON storage excludes values the native JSONB codec cannot preserve', () => {
  // @ts-expect-error Bigint is not a JSON value.
  jsonColumn('bigint', z.bigint());
  // @ts-expect-error Dates serialize to strings, not Date values.
  jsonColumn('date', z.date());
  // @ts-expect-error JSON compatibility applies recursively to object properties.
  jsonColumn('nested_date', z.object({ value: z.date() }));
  // @ts-expect-error JSON compatibility applies recursively to nested arrays.
  jsonColumn('nested_bigint', z.object({ values: z.array(z.array(z.bigint())) }));
  // @ts-expect-error Maps lose their values when serialized as JSON.
  jsonColumn('map', z.map(z.string(), z.string()));
  // @ts-expect-error Sets lose their values when serialized as JSON.
  jsonColumn('set', z.set(z.string()));
  // @ts-expect-error Functions are not JSON values.
  jsonColumn('function', z.function());
  // @ts-expect-error Root undefined is not a JSON value.
  jsonColumn('undefined', z.undefined());
  // @ts-expect-error Required properties containing undefined cannot be preserved as JSON.
  jsonColumn('required_undefined', z.custom<{ value: string | undefined }>());

  const narrowed = z.string().brand<'StorageId'>();
  jsonColumn('brand', narrowed);
  jsonColumn('declared_id', defineId('stored_').schema);
  jsonColumn('default', z.object({ count: z.number().default(1) }));
  jsonColumn('optional_nullable', z.object({ nested: z.object({ count: z.number() }).nullable().optional() }));
});

test('native column refinement callbacks receive their contextual schema types', () => {
  const values = pgTable('callbacks', { name: text('name').notNull(), count: integer('count').notNull().default(0) });
  const _select = createSelectSchema(values, { name: schema => schema.min(3), count: schema => schema.min(0) });
  const _insert = createInsertSchema(values, { name: schema => schema.min(3), count: schema => schema.min(0) });
  const _update = createUpdateSchema(values, { name: schema => schema.min(3), count: schema => schema.min(0) });
  expectTypeOf<z.output<typeof _select>>().toEqualTypeOf<{ name: string; count: number }>();
  expectTypeOf<z.output<typeof _insert>>().toEqualTypeOf<{ name: string; count?: number }>();
  expectTypeOf<z.output<typeof _update>>().toEqualTypeOf<{ name?: string; count?: number }>();
});

test('JSON schema types ignore phantom arrays and retain real PostgreSQL arrays', () => {
  const values = pgTable('json_array_types', {
    phantom: jsonb('phantom').$type<{ age: number }[]>().notNull(),
    real: jsonb('real').array().notNull(),
    matrix: jsonb('matrix').array('[][]').notNull(),
  });
  const _select = createSelectSchema(values, {
    phantom: schema => {
      expectTypeOf(schema).toEqualTypeOf<typeof nativeJsonSchema>();
      return schema;
    },
    real: schema => schema.min(1),
  });
  expectTypeOf<z.output<typeof _select>['phantom']>().toEqualTypeOf<z.output<typeof nativeJsonSchema>>();
  expectTypeOf<z.output<typeof _select>['real']>().toEqualTypeOf<z.output<typeof nativeJsonSchema>[]>();
  expectTypeOf<z.output<typeof _select>['matrix']>().toEqualTypeOf<z.output<typeof nativeJsonSchema>[][]>();
});

const _nameRefinement = { name: z.number() };
declare const optionalNameRefinement: typeof _nameRefinement | undefined;
const _unknownRefinement = { name: z.number(), absent: z.string() };
declare const optionalUnknownRefinement: typeof _unknownRefinement | undefined;

test('optional refinement variables preserve both runtime branches', () => {
  const values = pgTable('optional_callbacks', { name: text('name').notNull() });
  const _select = createSelectSchema(values, optionalNameRefinement);
  const _insert = createInsertSchema(values, optionalNameRefinement);
  const _update = createUpdateSchema(values, optionalNameRefinement);
  expectTypeOf<z.output<typeof _select>['name']>().toEqualTypeOf<string | number>();
  expectTypeOf<z.output<typeof _insert>['name']>().toEqualTypeOf<string | number>();
  expectTypeOf<z.output<typeof _update>['name']>().toEqualTypeOf<string | number | undefined>();
  // @ts-expect-error Optional maps must still reject unknown column keys.
  createSelectSchema(values, optionalUnknownRefinement);
});

test('serialized JSON driver parameters do not imply SQL arrays', () => {
  const mysql = mysqlTable('mysql_json', { value: mysqlJson('value').$type<{ age: number }[]>().notNull() });
  const sqlite = sqliteTable('sqlite_json', {
    value: sqliteText('value', { mode: 'json' }).$type<{ age: number }[]>().notNull(),
  });
  const _mysqlSelect = createSelectSchema(mysql, {
    value: schema => {
      expectTypeOf(schema).toEqualTypeOf<typeof nativeJsonSchema>();
      return schema;
    },
  });
  const _sqliteSelect = createSelectSchema(sqlite, {
    value: schema => {
      expectTypeOf(schema).toEqualTypeOf<typeof nativeJsonSchema>();
      return schema;
    },
  });
  expectTypeOf<z.output<typeof _mysqlSelect>['value']>().toEqualTypeOf<z.output<typeof nativeJsonSchema>>();
  expectTypeOf<z.output<typeof _sqliteSelect>['value']>().toEqualTypeOf<z.output<typeof nativeJsonSchema>>();
});
