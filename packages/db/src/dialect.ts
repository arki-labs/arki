/**
 * Which SQL dialect a Drizzle database speaks, read from the database object
 * itself. A string flag can disagree with the real database; the class cannot.
 * A transaction is a subclass of its database, so it answers the same way.
 */
import { is } from 'drizzle-orm';
// Drizzle's own files: neither loads `@libsql/client` or `pg`.
import { LibSQLDatabase } from 'drizzle-orm/libsql/driver-core';
import { LibSQLTransaction } from 'drizzle-orm/libsql/session';
import { PgAsyncDatabase, PgAsyncTransaction } from 'drizzle-orm/pg-core';
import { SQLiteAsyncDatabase, SQLiteAsyncTransaction } from 'drizzle-orm/sqlite-core';

/** The dialects `@arki/db` runs on. */
export const DIALECTS = ['pg', 'sqlite'] as const;

export type Dialect = (typeof DIALECTS)[number];

/** The dialect of `db` (a database or a transaction), or `undefined` for anything else. */
export function dialectOf(db: object): Dialect | undefined {
  if (is(db, PgAsyncDatabase)) return 'pg';
  if (is(db, SQLiteAsyncDatabase)) return 'sqlite';
  return undefined;
}

/** Whether `db` is an open transaction rather than a root database. */
export function isTransaction(db: object): boolean {
  return is(db, PgAsyncTransaction) || is(db, SQLiteAsyncTransaction);
}

/**
 * Whether `db` runs on libSQL. Of the SQLite drivers, only libSQL keeps an async
 * transaction callback correct (docs/arki/research/17-multi-database/spike/results.md).
 */
export function isLibsql(db: object): boolean {
  return is(db, LibSQLDatabase) || is(db, LibSQLTransaction);
}
