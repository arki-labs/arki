/**
 * SQLite errors read as SQL-standard SQLSTATEs, so `isUniqueViolation`, the
 * transaction retry and the failure classes work on SQLite unchanged. A miss
 * here turns a duplicate key into an opaque defect, or a busy lock into a
 * failure that is never retried.
 */
import { createClient } from '@libsql/client';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isUniqueViolation } from './errors.js';
import { findDatabaseError } from './sql-state.js';
import { retryableSqlState } from './transaction.js';

const client = createClient({ url: ':memory:' });
const db = drizzle({ client });

async function errorOf(statement: ReturnType<typeof sql>): Promise<unknown> {
  return db.run(statement).then(
    () => {
      throw new Error('the statement should have failed');
    },
    (error_: unknown) => error_,
  );
}

describe('SQLite errors at the SQLSTATE seam (real libSQL errors)', () => {
  beforeAll(async () => {
    await db.run(sql`PRAGMA foreign_keys = ON`);
    await db.run(sql`create table parent (id text primary key, name text not null unique)`);
    await db.run(sql`create table child (id text primary key, parent_id text not null references parent(id))`);
    await db.run(sql`create table checked (n integer check (n > 0))`);
    await db.run(sql`insert into parent values ('p1', 'ada')`);
  });

  afterAll(() => {
    client.close();
  });

  it('reads a duplicate key as 23505, so isUniqueViolation works on SQLite', async () => {
    const error = await errorOf(sql`insert into parent values ('p2', 'ada')`);
    expect(findDatabaseError(error)).toEqual({ sqlState: '23505', constraint: undefined });
    expect(isUniqueViolation(error)).toBe(true);
  });

  it('reads a duplicate primary key as 23505 too', async () => {
    const error = await errorOf(sql`insert into parent values ('p1', 'grace')`);
    expect(findDatabaseError(error)?.sqlState).toBe('23505');
  });

  it('reads a broken foreign key as 23503 and a missing value as 23502', async () => {
    expect(findDatabaseError(await errorOf(sql`insert into child values ('c1', 'nope')`))?.sqlState).toBe('23503');
    expect(findDatabaseError(await errorOf(sql`insert into parent (id) values ('p3')`))?.sqlState).toBe('23502');
  });

  it('reads a failed check as 23514', async () => {
    expect(findDatabaseError(await errorOf(sql`insert into checked values (0)`))?.sqlState).toBe('23514');
  });

  it('never matches a named constraint: SQLite names columns, not constraints', async () => {
    const error = await errorOf(sql`insert into parent values ('p4', 'ada')`);
    expect(isUniqueViolation(error, 'parent_name_unique')).toBe(false);
  });
});

/** Drizzle's wrapper: no `code` of its own, the driver error as `cause`. */
const drizzleWrapped = (cause: object) => Object.assign(new Error('Failed query: insert ...'), { cause });

// Vitest runs on Node 22 here, which cannot load bun:sqlite or this repo's node:sqlite driver.
// These shapes are copied field for field from docs/arki/research/17-multi-database/spike/results.md.
describe('SQLite error shapes from the other drivers', () => {
  it('reads bun:sqlite (errno) and node:sqlite (errcode) unique violations as 23505', () => {
    const bun = Object.assign(new Error('UNIQUE constraint failed: t.k'), { code: 'SQLITE_CONSTRAINT_UNIQUE', errno: 2067 });
    const node = Object.assign(new Error('UNIQUE constraint failed: t.k'), { code: 'ERR_SQLITE_ERROR', errcode: 2067 });
    expect(isUniqueViolation(drizzleWrapped(bun))).toBe(true);
    expect(isUniqueViolation(drizzleWrapped(node))).toBe(true);
  });

  it('reads SQLITE_BUSY as the retryable 40001: another process holds the write lock', () => {
    const busy = Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'SQLITE_BUSY', rawCode: 5 });
    expect(retryableSqlState(drizzleWrapped(busy))).toBe('40001');
  });

  it('gives no answer for a SQLite code it does not know, so nothing retries on a guess', () => {
    const corrupt = Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT', rawCode: 11 });
    expect(findDatabaseError(drizzleWrapped(corrupt))).toBeUndefined();
  });
});
