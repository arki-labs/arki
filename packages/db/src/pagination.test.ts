/**
 * Keyset pagination against a real (PGlite) table. The cases that break
 * hand-written cursors: many rows with the SAME timestamp (a bulk import),
 * a last page that is exactly full, and mixed sort directions. Paging
 * through must return every row once — no repeats, no gaps.
 */
import { oc } from '@orpc/contract';
import { call, implement, ORPCError } from '@orpc/server';
import { and, defineRelations, eq, sql } from 'drizzle-orm';
import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SuccessOf } from '@arki/failure';
import { CURSOR_FAILURES, InvalidCursor, InvalidCursorValue, keyset, z } from '@arki/contracts';
import { orThrow } from '@arki/failure';
import { errorMap, orThrowRpc, reviveRpcError, rpcFailureDefinitions } from '@arki/failure/orpc';

import { keysetQuery } from './pagination.js';
import { initDbRuntimeLocal } from './runtime-local.js';

const stories = pgTable('stories', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  // Millisecond precision, as the module docs ask: a JS Date cannot carry microseconds.
  createdAt: timestamp('created_at', { precision: 3 }).notNull(),
  rank: integer('rank').notNull(),
});
const relations = defineRelations({ stories });

let closeRuntime: SuccessOf<typeof initDbRuntimeLocal<typeof relations>>['close'];
let db: SuccessOf<typeof initDbRuntimeLocal<typeof relations>>['db'];

const SAME_MOMENT = new Date('2026-10-15T08:00:00.000Z');
const LATER = new Date('2026-10-15T09:00:00.000Z');

beforeAll(async () => {
  ({ db, close: closeRuntime } = await orThrow(initDbRuntimeLocal({ memory: true }, { relations })));
  await db.execute(
    sql`create table stories (id text primary key, user_id text not null, created_at timestamp(3) not null, rank integer not null)`,
  );
  // 7 rows share one timestamp (the tie the id must break), 2 are later, 3 belong to someone else.
  const rows = [
    ...['sty_c', 'sty_a', 'sty_g', 'sty_e', 'sty_b', 'sty_f', 'sty_d'].map((id, rank) => ({
      id,
      userId: 'usr_me',
      createdAt: SAME_MOMENT,
      rank: rank % 3,
    })),
    { id: 'sty_y', userId: 'usr_me', createdAt: LATER, rank: 1 },
    { id: 'sty_z', userId: 'usr_me', createdAt: LATER, rank: 2 },
    ...['sty_o1', 'sty_o2', 'sty_o3'].map(id => ({ id, userId: 'usr_other', createdAt: LATER, rank: 0 })),
  ];
  await db.insert(stories).values(rows);
});

afterAll(async () => {
  await orThrow(closeRuntime());
});

const newestFirst = keyset({ createdAt: 'desc', id: 'desc' });
const byNewest = keysetQuery(newestFirst, stories);

/** Walk every page for one user and return the ids in order, plus how many pages it took. */
async function walk(limit: number, query = byNewest, userId = 'usr_me') {
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const rows = await db
      .select()
      .from(stories)
      .where(and(eq(stories.userId, userId), orThrow(query.after(cursor))))
      .orderBy(...query.orderBy)
      .limit(query.take(limit));
    const page = orThrow(query.page(rows, limit));
    expect(page.items.length).toBeLessThanOrEqual(limit);
    seen.push(...page.items.map(row => row.id));
    cursor = page.nextCursor ?? undefined;
    pages += 1;
  } while (cursor !== undefined && pages < 50);
  return { seen, pages };
}

describe('keysetQuery', () => {
  it('pages through tied timestamps without repeating or skipping a row', async () => {
    const all = await db
      .select({ id: stories.id })
      .from(stories)
      .where(eq(stories.userId, 'usr_me'))
      .orderBy(...byNewest.orderBy);
    const expected = all.map(row => row.id);
    expect(expected).toEqual(['sty_z', 'sty_y', 'sty_g', 'sty_f', 'sty_e', 'sty_d', 'sty_c', 'sty_b', 'sty_a']);

    for (const limit of [1, 2, 3, 4, 8, 20]) {
      const { seen } = await walk(limit);
      expect(seen, `limit ${limit}`).toEqual(expected);
    }
  });

  it('limit + 1 detection: an exactly full last page says "no more" without an extra empty request', async () => {
    // 9 rows, pages of 3 → exactly 3 pages; the third has nextCursor null.
    expect(await walk(3)).toMatchObject({ pages: 3 });
    // 9 rows, pages of 9 → one page, done.
    expect(await walk(9)).toMatchObject({ pages: 1 });
  });

  it('keeps the query’s own filters: a cursor never leaks rows of another user', async () => {
    const { seen } = await walk(2);
    expect(seen.some(id => id.startsWith('sty_o'))).toBe(false);
  });

  it('mixed directions: rank ascending, then newest first, then id', async () => {
    const mixed = keyset({ rank: 'asc', createdAt: 'desc', id: 'desc' });
    const query = keysetQuery(mixed, stories);
    const all = await db
      .select({ id: stories.id })
      .from(stories)
      .where(eq(stories.userId, 'usr_me'))
      .orderBy(...query.orderBy);
    for (const limit of [1, 2, 4]) {
      const { seen } = await walk(limit, query);
      expect(seen).toEqual(all.map(row => row.id));
    }
  });

  it('page() hands back the cursor of the last row it kept, not of the extra one', () => {
    const rows = [
      { id: 'sty_3', createdAt: LATER },
      { id: 'sty_2', createdAt: LATER },
      { id: 'sty_1', createdAt: LATER },
    ];
    const page = orThrow(byNewest.page(rows, 2));
    expect(page.items.map(row => row.id)).toEqual(['sty_3', 'sty_2']);
    expect(page.nextCursor === null ? null : orThrow(newestFirst.decode(page.nextCursor)).id).toBe('sty_2');
  });
});

it('returns malformed cursor refusal before a query can treat it as a predicate', () => {
  expect(InvalidCursor.is(byNewest.after('not-a-cursor'))).toBe(true);
});

it('refuses an unrepresentable last-row cursor instead of publishing a broken page', () => {
  const rows = [
    { createdAt: new Date(Number.NaN), id: 'sty_bad' },
    { createdAt: LATER, id: 'sty_extra' },
  ];
  expect(InvalidCursorValue.is(byNewest.page(rows, 1))).toBe(true);
});

it('uses original cursor definitions through the native RPC failure adapter', async () => {
  const contract = oc
    .errors(errorMap(...CURSOR_FAILURES))
    .input(z.string())
    .output(z.unknown());
  const procedure = implement(contract).handler(({ input, errors }) => orThrowRpc(byNewest.after(input), errors));
  try {
    await call(procedure, 'bad-cursor');
    throw new Error('Invalid cursor unexpectedly reached the success output');
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    if (!(error instanceof ORPCError)) throw error;
    expect(error.status).toBe(400);
    expect(error.defined).toBe(true);
    const definitions = rpcFailureDefinitions(contract['~orpc'].errorMap);
    expect(definitions).toEqual([...CURSOR_FAILURES]);
    expect(InvalidCursor.is(reviveRpcError(error, definitions))).toBe(true);
  }
});
