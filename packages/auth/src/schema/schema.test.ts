import { getTableConfig, pgSchema, text, timestamp } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { authAccountColumns, authSessionColumns, authUserColumns, authVerificationColumns, createAuthTables } from '.';

const schema = pgSchema('test_app');

const idSource = (prefix: string) => ({
  primaryColumn: () =>
    text('id')
      .primaryKey()
      .$defaultFn(() => `${prefix}_x`),
  createForeignKeyFactory: () => ({ marker: prefix }),
});

const columnNames = (table: Parameters<typeof getTableConfig>[0]) => getTableConfig(table).columns.map(c => c.name);

describe('column sets', () => {
  it('spell column names in snake case by default', () => {
    const User = schema.table('users', authUserColumns({ id: text('id').primaryKey() }));
    expect(columnNames(User)).toEqual(['id', 'name', 'email', 'email_verified', 'image', 'created_at', 'updated_at']);
  });

  it('keep the key as the column name with naming camel', () => {
    const Verification = schema.table(
      'verifications',
      authVerificationColumns({ id: text('id').primaryKey(), naming: 'camel' }),
    );
    expect(columnNames(Verification)).toEqual(['id', 'identifier', 'value', 'expiresAt', 'createdAt', 'updatedAt']);
  });

  it('let a later key replace a column and keep its position out of the way', () => {
    const Account = schema.table('accounts', {
      ...authAccountColumns({ id: text('id').primaryKey(), userId: text('userId').notNull(), naming: 'camel' }),
      accessTokenExpiresAt: timestamp('expiresAt'),
    });
    const names = columnNames(Account);
    expect(names).toContain('expiresAt');
    expect(names).not.toContain('accessTokenExpiresAt');
  });

  it('hand out fresh builders on every call', () => {
    const first = authSessionColumns({ id: text('id'), userId: text('user_id') });
    const second = authSessionColumns({ id: text('id'), userId: text('user_id') });
    expect(first.token).not.toBe(second.token);
  });
});

describe('createAuthTables', () => {
  const tables = createAuthTables(schema, {
    ids: { user: idSource('u'), session: idSource('s'), account: idSource('a'), verification: idSource('v') },
  });

  it('builds the four tables with the standard names', () => {
    expect([tables.User, tables.Session, tables.Account, tables.Verification].map(t => getTableConfig(t).name)).toEqual(
      ['users', 'sessions', 'accounts', 'verifications'],
    );
  });

  it('adds the tweaks column to the user table and points sessions and accounts at users', () => {
    expect(columnNames(tables.User)).toContain('tweaks');
    expect(getTableConfig(tables.Session).foreignKeys).toHaveLength(1);
    expect(getTableConfig(tables.Account).foreignKeys).toHaveLength(1);
  });

  it('returns the foreign key factory of the user id source', () => {
    expect(tables.userForeignKeys).toEqual({ marker: 'u' });
  });
});
