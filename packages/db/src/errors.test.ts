/**
 * WHY: "insert, and answer CONFLICT on a duplicate" only works if the check
 * recognises the duplicate the way the driver in production reports it.
 * Drizzle 1.0 wraps every driver error in `DrizzleQueryError` (the Postgres
 * error is its `cause`), and Bun SQL puts the SQLSTATE in `errno`, with its own
 * name in `code`. A check that reads `error.code` passes a unit test built from
 * `{ code: '23505' }` and still turns every real duplicate into a 500.
 */
import { PGlite } from '@electric-sql/pglite';
import { ORPCError } from '@orpc/server';
import { DrizzleQueryError, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { describe, expect, it } from 'vitest';

import { isUniqueViolation } from './errors.js';

/** What Bun 1.4.2 SQL threw for a duplicate primary key, recorded against Postgres 15. */
const bunDuplicate = () =>
  Object.assign(new Error('duplicate key value violates unique constraint "t_pkey"'), {
    name: 'PostgresError',
    code: 'ERR_POSTGRES_SERVER_ERROR',
    errno: '23505',
    constraint: 't_pkey',
  });

/** What node-postgres and PGlite throw: the SQLSTATE in `code`. */
const pgDuplicate = (constraint: string) => Object.assign(new Error('duplicate key'), { code: '23505', constraint });

describe('isUniqueViolation', () => {
  it('recognises a real duplicate insert through Drizzle (PGlite)', async () => {
    const client = new PGlite();
    const db = drizzle({ client });
    await db.execute(sql`create table t (id int constraint t_pkey primary key)`);
    await db.execute(sql`insert into t values (1)`);
    const error: unknown = await db.execute(sql`insert into t values (1)`).catch((error_: unknown) => error_);
    await client.close();

    expect(error).toBeInstanceOf(DrizzleQueryError);
    expect(isUniqueViolation(error)).toBe(true);
    expect(isUniqueViolation(error, 't_pkey')).toBe(true);
    expect(isUniqueViolation(error, 'another_index')).toBe(false);
  });

  it('recognises Bun SQL, where the SQLSTATE is in errno and code is the driver name', () => {
    expect(isUniqueViolation(bunDuplicate())).toBe(true);
    expect(isUniqueViolation(new DrizzleQueryError('insert into t', [], bunDuplicate()), 't_pkey')).toBe(true);
    expect(isUniqueViolation(new DrizzleQueryError('insert into t', [], bunDuplicate()), 'another_index')).toBe(false);
  });

  it('is false for other database errors', () => {
    const foreignKey = Object.assign(new Error('fk'), { code: '23503', constraint: 't_pkey' });
    expect(isUniqueViolation(foreignKey)).toBe(false);
    expect(isUniqueViolation(Object.assign(bunDuplicate(), { errno: '23503' }))).toBe(false);
  });

  it('respects a decision already made above the database error', () => {
    // The app mapped the duplicate itself; the first code in the chain decides.
    expect(isUniqueViolation(new ORPCError('CONFLICT', { cause: pgDuplicate('t_pkey') }))).toBe(false);
  });

  it('is false for anything that is not a database error, and never loops', () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(Object.assign(new Error('word'), { code: 'ABORT' }))).toBe(false);

    const loop: { cause?: unknown } = {};
    loop.cause = loop;
    expect(isUniqueViolation(loop)).toBe(false);
  });
});
