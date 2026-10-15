/**
 * Keyset pagination against a real (PGlite) table. The cases that break
 * hand-written cursors: many rows with the SAME timestamp (a bulk import),
 * a last page that is exactly full, and mixed sort directions. Paging
 * through must return every row once — no repeats, no gaps.
 */
import type { PGlite } from '@electric-sql/pglite';
import { and, defineRelations, eq, sql } from 'drizzle-orm';
import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { keyset } from '@arki/contracts';

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

let client: PGlite;
let db: Awaited<ReturnType<typeof initDbRuntimeLocal<typeof relations>>>['db'];

const SAME_MOMENT = new Date('2026-10-15T08:00:00.000Z');
const LATER = new Date('2026-10-15T09:00:00.000Z');

beforeAll(async () => {
  ({ db, pglite: client } = await initDbRuntimeLocal({ memory: true }, { relations }));
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
  await client.close();
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
      .where(and(eq(stories.userId, userId), query.after(cursor)))
      .orderBy(...query.orderBy)
      .limit(query.take(limit));
    const page = query.page(rows, limit);
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
    const page = byNewest.page(rows, 2);
    expect(page.items.map(row => row.id)).toEqual(['sty_3', 'sty_2']);
    expect(page.nextCursor === null ? null : newestFirst.decode(page.nextCursor).id).toBe('sty_2');
  });
});
