/**
 * Dialect detection decides which migrator runs, which isolation config is
 * passed, and which SQLite driver is refused. A wrong answer is silent: the
 * wrong SQL, or an async transaction that loses its rollback.
 */
import { PGlite } from '@electric-sql/pglite';
import { createClient } from '@libsql/client';
import { drizzle as drizzleLibsql } from 'drizzle-orm/libsql';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { drizzle as drizzleProxy } from 'drizzle-orm/sqlite-proxy';
import { describe, expect, it } from 'vitest';

import { dialectOf, isLibsql, isTransaction } from './dialect.js';

describe('dialectOf / isTransaction / isLibsql', () => {
  it('reads pg from a PGlite database and its transaction', async () => {
    const db = drizzlePglite({ client: new PGlite() });
    try {
      expect(dialectOf(db)).toBe('pg');
      expect(isTransaction(db)).toBe(false);
      await db.transaction(tx => {
        expect(dialectOf(tx)).toBe('pg');
        expect(isTransaction(tx)).toBe(true);
        expect(isLibsql(tx)).toBe(false);
        return Promise.resolve();
      });
    } finally {
      await db.$client.close();
    }
  });

  it('reads sqlite and libSQL from a libSQL database and its transaction', async () => {
    const client = createClient({ url: ':memory:' });
    const db = drizzleLibsql({ client });
    try {
      expect(dialectOf(db)).toBe('sqlite');
      expect(isLibsql(db)).toBe(true);
      expect(isTransaction(db)).toBe(false);
      await db.transaction(tx => {
        expect(dialectOf(tx)).toBe('sqlite');
        expect(isLibsql(tx)).toBe(true);
        expect(isTransaction(tx)).toBe(true);
        return Promise.resolve();
      });
    } finally {
      client.close();
    }
  });

  it('tells a SQLite database that is not libSQL apart, so its transactions can be refused', () => {
    const db = drizzleProxy(() => Promise.resolve({ rows: [] }));
    expect(dialectOf(db)).toBe('sqlite');
    expect(isLibsql(db)).toBe(false);
  });

  it('answers undefined for an object that is not a Drizzle database', () => {
    expect(dialectOf({ transaction: () => Promise.resolve() })).toBeUndefined();
    expect(isTransaction({})).toBe(false);
  });
});
