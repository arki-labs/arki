import { sql } from 'drizzle-orm';
import { integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import {
  COLUMN_ZOD_SCHEMA,
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
  jsonColumn,
} from './drizzle.js';
import { defineId } from './ids.js';

const userId = defineId('usr_');
const idColumn = text('id');
const config: unknown = Reflect.get(idColumn, 'config');
if (typeof config === 'object' && config !== null) Object.assign(config, { [COLUMN_ZOD_SCHEMA]: userId.schema });
const users = pgTable('users', { id: idColumn.notNull(), name: text('name').notNull() });
const profileSchema = z.object({
  age: z.number(),
  groups: z.array(z.array(z.object({ label: z.string() }))).optional(),
});
const profiles = pgTable('profiles', {
  profile: jsonColumn('profile', profileSchema).notNull(),
  optional: jsonColumn('optional', profileSchema),
  defaulted: jsonColumn('defaulted', profileSchema).notNull().default({ age: 1 }),
  generated: integer('generated').generatedAlwaysAs(sql`1`),
});
const refinements = { profile: () => profileSchema, optional: () => profileSchema, defaulted: () => profileSchema };

describe('table schema wrappers', () => {
  it('keeps existing column metadata runtime checks and explicit branded inference', () => {
    const schema = createSelectSchema(users, { id: () => userId.schema });
    expectTypeOf<z.output<typeof schema>['id']>().toEqualTypeOf<z.output<typeof userId.schema>>();
    expect(schema.parse({ id: 'usr_1', name: 'a' })).toEqual({ id: 'usr_1', name: 'a' });
    expect(createSelectSchema(users).safeParse({ id: 'org_1', name: 'a' }).success).toBe(false);
    expect(createInsertSchema(users).safeParse({ id: 'org_1', name: 'a' }).success).toBe(false);
    expect(createUpdateSchema(users).safeParse({ id: 'org_1' }).success).toBe(false);
  });

  it('rejects incorrect nested JSON values in select, insert and update schemas', () => {
    for (const schema of [createSelectSchema(profiles), createInsertSchema(profiles), createUpdateSchema(profiles)]) {
      const row = { profile: { age: 'wrong' }, optional: null, defaulted: { age: 1 }, generated: 1 };
      expect(schema.safeParse(row).success).toBe(false);
      expect(schema.safeParse({ ...row, profile: { age: 1, groups: [[{ label: 2 }]] } }).success).toBe(false);
    }
  });

  it('preserves nullable columns, optional object fields, defaults and update omissions', () => {
    const insert = createInsertSchema(profiles, refinements);
    const update = createUpdateSchema(profiles, refinements);
    expect(insert.parse({ profile: { age: 2 } })).toEqual({ profile: { age: 2 } });
    expect(insert.parse({ profile: { age: 2, groups: [[{ label: 'team' }]] }, optional: null })).toEqual({
      profile: { age: 2, groups: [[{ label: 'team' }]] },
      optional: null,
    });
    expect(update.parse({})).toEqual({});
    expect(update.parse({ optional: null })).toEqual({ optional: null });
    expect(insert.safeParse({ profile: null }).success).toBe(false);
    expect(
      createSelectSchema(profiles, refinements).safeParse({
        profile: { age: 1 },
        optional: null,
        defaulted: { age: 1 },
        generated: 1,
      }).success,
    ).toBe(true);
    expect(insert.parse({ profile: { age: 2 }, generated: 9 })).not.toHaveProperty('generated');
  });

  it('uses the explicit refinement when it overrides column metadata', () => {
    const schema = createSelectSchema(users, { id: z.string().startsWith('org_') });
    expect(schema.safeParse({ id: 'org_1', name: 'a' }).success).toBe(true);
  });

  it('preserves codec wire input and parsed application output', () => {
    const count = z.codec(z.string(), z.number(), { decode: Number, encode: String });
    const table = pgTable('counts', { count: jsonColumn('count', z.number()).notNull() });
    const schema = createInsertSchema(table, { count: () => count });
    expectTypeOf<z.input<typeof schema>>().toEqualTypeOf<{ count: string }>();
    expectTypeOf<z.output<typeof schema>>().toEqualTypeOf<{ count: number }>();
    expect(schema.parse({ count: '42' })).toEqual({ count: 42 });
    expect(z.encode(count, 42)).toBe('42');
  });

  it('does not claim an unvalidated $type annotation is a runtime JSON schema', () => {
    const table = pgTable('unvalidated', {
      profile: jsonb('profile').$type<z.output<typeof profileSchema>>().notNull(),
    });
    const schema = createSelectSchema(table);
    expect(schema.parse({ profile: { age: 'wrong' } })).toEqual({ profile: { age: 'wrong' } });
    expectTypeOf<z.output<typeof schema>['profile']>().not.toEqualTypeOf<z.output<typeof profileSchema>>();
  });
});

describe('JSON storage representations', () => {
  it('normalizes phantom JSON arrays while preserving native JSON validation', () => {
    const table = pgTable('phantom_json', { value: jsonb('value').$type<{ age: number }[]>().notNull() });
    for (const schema of [createSelectSchema(table), createInsertSchema(table), createUpdateSchema(table)]) {
      expect(schema.parse({ value: 42 })).toEqual({ value: 42 });
      expect(schema.parse({ value: { nested: 'value' } })).toEqual({ value: { nested: 'value' } });
    }
    const callback = createSelectSchema(table, { value: schema => schema });
    expect(callback.parse({ value: 42 })).toEqual({ value: 42 });
  });

  it('preserves real SQL array dimensions and metadata element validation', () => {
    const table = pgTable('sql_json_arrays', {
      values: jsonb('values').array().notNull(),
      profiles: jsonColumn('profiles', profileSchema).array().notNull(),
    });
    const schema = createSelectSchema(table);
    expect(schema.parse({ values: [42, { key: 'value' }], profiles: [{ age: 2 }] })).toEqual({
      values: [42, { key: 'value' }],
      profiles: [{ age: 2 }],
    });
    expect(schema.safeParse({ values: 42, profiles: [{ age: 2 }] }).success).toBe(false);
    expect(schema.safeParse({ values: [], profiles: [{ age: 'wrong' }] }).success).toBe(false);
    expect(
      createSelectSchema(table, { values: value => value.min(1) }).safeParse({ values: [], profiles: [] }).success,
    ).toBe(false);
  });

  it('preserves branded, optional, nullable and defaulted storage through JSON serialization', () => {
    const stored = z.object({
      id: userId.schema,
      count: z.number().default(1),
      optional: z.string().optional(),
      nullable: z.string().nullable(),
    });
    const table = pgTable('stable_json', { value: jsonColumn('value', stored).notNull() });
    const schema = createSelectSchema(table, { value: () => stored });
    const parsed = schema.parse({ value: { id: 'usr_1', nullable: null } });
    const serialized = JSON.stringify(parsed);
    const decoded: unknown = JSON.parse(serialized);
    expect(schema.parse(decoded)).toEqual(parsed);
    expect(parsed.value).toEqual({ id: 'usr_1', count: 1, nullable: null });
  });

  it('checks finite JSON output without executing the storage schema twice', () => {
    let calls = 0;
    const stable = z.number().transform(value => {
      calls += 1;
      return value;
    });
    const table = pgTable('finite_json', { value: jsonColumn('value', stable).notNull() });
    expect(createSelectSchema(table).parse({ value: 42 })).toEqual({ value: 42 });
    expect(calls).toBe(1);
    const nan = pgTable('nan_json', { value: jsonColumn('value', z.nan()).notNull() });
    expect(createSelectSchema(nan).safeParse({ value: Number.NaN }).success).toBe(false);
  });
});
