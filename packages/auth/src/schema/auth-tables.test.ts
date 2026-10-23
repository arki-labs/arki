import { getTableConfig, pgSchema } from 'drizzle-orm/pg-core';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { pgColumns } from '@arki/db/pg';

import {
  authAccountColumns,
  authSessionColumns,
  authUserColumns,
  authVerificationColumns,
  createAuthTables,
} from './auth-tables.js';

const c = pgColumns(pgSchema('test_app'));

const idSource = (prefix: string) => ({
  primaryColumn: () =>
    c
      .text('id')
      .primaryKey()
      .$defaultFn(() => `${prefix}_x`),
  createForeignKeyFactory: () => ({ marker: prefix }),
});

const ids = { user: idSource('u'), session: idSource('s'), account: idSource('a'), verification: idSource('v') };

const columnNames = (table: Parameters<typeof getTableConfig>[0]) => getTableConfig(table).columns.map(c => c.name);

const column = (table: Parameters<typeof getTableConfig>[0], name: string) => {
  const found = getTableConfig(table).columns.find(c => c.name === name);
  if (!found) throw new Error(`no column ${name}`);
  return { notNull: found.notNull, sqlDefault: found.default !== undefined, jsDefault: found.defaultFn !== undefined };
};

describe('column sets', () => {
  it('spell column names in snake case by default', () => {
    const User = c.table('users', authUserColumns(c, { id: c.text('id').primaryKey(), fill: 'app' }));
    expect(columnNames(User)).toEqual(['id', 'name', 'email', 'email_verified', 'image', 'created_at', 'updated_at']);
  });

  it('keep the key as the column name with naming camel', () => {
    const Verification = c.table(
      'verifications',
      authVerificationColumns(c, { id: c.text('id').primaryKey(), naming: 'camel', fill: 'app' }),
    );
    expect(columnNames(Verification)).toEqual(['id', 'identifier', 'value', 'expiresAt', 'createdAt', 'updatedAt']);
  });

  it('let a later key replace a column and keep its position out of the way', () => {
    const Account = c.table('accounts', {
      ...authAccountColumns(c, {
        id: c.text('id').primaryKey(),
        userId: c.text('userId').notNull(),
        naming: 'camel',
        fill: 'app',
      }),
      accessTokenExpiresAt: c.timestamp('expiresAt'),
    });
    const names = columnNames(Account);
    expect(names).toContain('expiresAt');
    expect(names).not.toContain('accessTokenExpiresAt');
  });

  it('hand out fresh specs on every call', () => {
    const first = authSessionColumns(c, { id: c.text('id'), userId: c.text('user_id'), fill: 'app' });
    const second = authSessionColumns(c, { id: c.text('id'), userId: c.text('user_id'), fill: 'app' });
    expect(first.token).not.toBe(second.token);
  });
});

describe('fill', () => {
  const js = createAuthTables(c, { ids, fill: 'app' });
  const sql = createAuthTables(c, { ids, fill: 'database' });

  it("'app' fills timestamps and emailVerified from code, never from the database", () => {
    expect(column(js.User, 'created_at')).toEqual({ notNull: true, sqlDefault: false, jsDefault: true });
    expect(column(js.User, 'email_verified')).toEqual({ notNull: true, sqlDefault: false, jsDefault: true });
    expect(column(js.Session, 'created_at')).toEqual({ notNull: true, sqlDefault: false, jsDefault: false });
    expect(column(js.Account, 'updated_at')).toEqual({ notNull: true, sqlDefault: false, jsDefault: false });
    expect(column(js.Verification, 'created_at')).toEqual({ notNull: false, sqlDefault: false, jsDefault: true });
  });

  it("'database' gives every timestamp and emailVerified a NOT NULL database default", () => {
    for (const table of [sql.User, sql.Session, sql.Account, sql.Verification]) {
      expect(column(table, 'created_at')).toEqual({ notNull: true, sqlDefault: true, jsDefault: false });
      expect(column(table, 'updated_at')).toEqual({ notNull: true, sqlDefault: true, jsDefault: false });
    }
    expect(column(sql.User, 'email_verified')).toEqual({ notNull: true, sqlDefault: true, jsDefault: false });
  });

  it('shows in the row types: a column with a default is optional on insert', () => {
    expectTypeOf<typeof js.Session.$inferInsert.createdAt>().toEqualTypeOf<Date>();
    expectTypeOf<typeof sql.Session.$inferInsert.createdAt>().toEqualTypeOf<Date | undefined>();
    expectTypeOf<typeof js.Verification.$inferSelect.createdAt>().toEqualTypeOf<Date | null>();
    expectTypeOf<typeof sql.Verification.$inferSelect.createdAt>().toEqualTypeOf<Date>();
  });
});

describe('createAuthTables', () => {
  const tables = createAuthTables(c, {
    ids,
    fill: 'app',
    columns: {
      user: { tweaks: c.json('tweaks').notNull() },
      account: { accessTokenExpiresAt: c.timestamp('expires_at') },
    },
  });

  it('builds the four tables with the standard names', () => {
    expect([tables.User, tables.Session, tables.Account, tables.Verification].map(t => getTableConfig(t).name)).toEqual(
      ['users', 'sessions', 'accounts', 'verifications'],
    );
  });

  it('points sessions and accounts at users', () => {
    expect(getTableConfig(tables.Session).foreignKeys).toHaveLength(1);
    expect(getTableConfig(tables.Account).foreignKeys).toHaveLength(1);
  });

  it('adds nothing on its own: without columns, users has the standard columns only', () => {
    const bare = createAuthTables(c, { ids, fill: 'app' });
    expect(columnNames(bare.User)).toEqual([
      'id',
      'name',
      'email',
      'email_verified',
      'image',
      'created_at',
      'updated_at',
    ]);
  });

  it('merges columns after the standard ones: a new key adds, a standard key replaces', () => {
    expect(columnNames(tables.User)).toContain('tweaks');
    expect(columnNames(tables.Account)).toContain('expires_at');
    expect(columnNames(tables.Account)).not.toContain('access_token_expires_at');
    expectTypeOf<typeof tables.User.$inferSelect.tweaks>().toEqualTypeOf<unknown>();
    expectTypeOf<typeof tables.Account.$inferSelect.accessTokenExpiresAt>().toEqualTypeOf<Date | null>();
  });

  it('returns the foreign key factory of the user id source', () => {
    expect(tables.userForeignKeys).toEqual({ marker: 'u' });
  });
});
