import { pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { COLUMN_ZOD_SCHEMA, createInsertSchema, createSelectSchema, createUpdateSchema } from './drizzle.js';

const idColumn = text('id');
// Same side-channel @arki/db's id factories use: the builder's `config` object.
Object.assign(Reflect.get(idColumn, 'config') as object, { [COLUMN_ZOD_SCHEMA]: z.string().startsWith('usr_') });
const users = pgTable('users', { id: idColumn.notNull(), name: text('name').notNull() });

describe('table schema wrappers', () => {
  it('apply the schema a column stashed under COLUMN_ZOD_SCHEMA, so wrong id prefixes are rejected', () => {
    const schema = createSelectSchema(users);
    expect(schema.safeParse({ id: 'usr_1', name: 'a' }).success).toBe(true);
    expect(schema.safeParse({ id: 'org_1', name: 'a' }).success).toBe(false);
  });

  it('insert and update schemas apply it too; update makes every column optional', () => {
    expect(createInsertSchema(users).safeParse({ id: 'org_1', name: 'a' }).success).toBe(false);
    expect(createUpdateSchema(users).safeParse({}).success).toBe(true);
  });
});
