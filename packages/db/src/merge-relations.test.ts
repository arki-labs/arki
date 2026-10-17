/**
 * `mergeRelations` — why it exists: Drizzle's `{ ...partA, ...partB }` replaces a whole table entry,
 * so two parts that add relations to the same table silently lose keys. These tests pin that every
 * key survives, that a repeated key fails loudly, and that the merged config types and queries
 * exactly like one big `defineRelations`. PGlite runs the real queries.
 */
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
import { defineRelations, defineRelationsPart, sql } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { DB_COMPOSITION_ERROR_CODES, DbCompositionError } from './composition.js';
import { mergeRelations } from './merge-relations.js';

const users = pgTable('users', { id: text('id').primaryKey() });
const sources = pgTable('sources', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id),
});
const items = pgTable('items', {
  id: text('id').primaryKey(),
  sourceId: text('source_id').references(() => sources.id),
});
const cache = pgTable('cache', { hash: text('hash').primaryKey() });
const schema = { users, sources, items, cache };

const basePart = defineRelationsPart(schema);
// `sources` is extended by BOTH parts below: the case a plain spread gets wrong.
const sourcesPart = defineRelationsPart(schema, r => ({
  sources: { user: r.one.users({ from: r.sources.userId, to: r.users.id }) },
}));
const itemsPart = defineRelationsPart(schema, r => ({
  sources: { items: r.many.items({ from: r.sources.id, to: r.items.sourceId }) },
  items: { source: r.one.sources({ from: r.items.sourceId, to: r.sources.id, optional: true }) },
}));

const oracle = defineRelations(schema, r => ({
  sources: {
    user: r.one.users({ from: r.sources.userId, to: r.users.id }),
    items: r.many.items({ from: r.sources.id, to: r.items.sourceId }),
  },
  items: { source: r.one.sources({ from: r.items.sourceId, to: r.sources.id, optional: true }) },
}));

describe('mergeRelations at runtime', () => {
  it('keeps every key a table gets from two parts, where a spread loses one', () => {
    const merged = mergeRelations(basePart, sourcesPart, itemsPart);

    expect(Object.keys(merged.sources.relations).toSorted()).toEqual(['items', 'user']);
    expect(Object.keys(oracle.sources.relations).toSorted()).toEqual(['items', 'user']);
    expect(Object.keys({ ...basePart, ...sourcesPart, ...itemsPart }.sources.relations)).toEqual(['items']);
  });

  it('registers tables only the base part names, with no relations', () => {
    const merged = mergeRelations(basePart, sourcesPart);

    expect(Object.keys(merged).toSorted()).toEqual(['cache', 'items', 'sources', 'users']);
    expect(merged.cache.relations).toEqual({});
  });

  it('gives the same key sets whatever the order of the parts', () => {
    const forward = mergeRelations(basePart, sourcesPart, itemsPart);
    const backward = mergeRelations(itemsPart, sourcesPart, basePart);

    for (const name of Object.keys(forward) as (keyof typeof forward)[]) {
      expect(Object.keys(backward[name].relations).toSorted()).toEqual(Object.keys(forward[name].relations).toSorted());
    }
  });

  it('does not change the parts it was given', () => {
    mergeRelations(basePart, sourcesPart, itemsPart);

    expect(Object.keys(sourcesPart.sources.relations)).toEqual(['user']);
    expect(Object.keys(basePart.sources.relations)).toEqual([]);
  });

  it('throws when two parts declare the same relation on the same table, naming both', () => {
    expect(() => mergeRelations(basePart, sourcesPart, sourcesPart)).toThrow(
      '[db] relation "sources.user" is declared by more than one relations part.',
    );
    try {
      mergeRelations(sourcesPart, sourcesPart);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DbCompositionError);
      expect(error).toMatchObject({ code: DB_COMPOSITION_ERROR_CODES.duplicateRelationKey });
    }
  });
});

describe('mergeRelations types', () => {
  const merged = mergeRelations(basePart, sourcesPart, itemsPart);
  type MergedDb = PgliteDatabase<typeof merged>;
  type OracleDb = PgliteDatabase<typeof oracle>;
  type FindMany<TDb extends MergedDb | OracleDb, TTable extends 'sources' | 'items' | 'cache'> = Awaited<
    ReturnType<TDb['query'][TTable]['findMany']>
  >;

  it('lists the relation keys each table got from every part', () => {
    expectTypeOf<keyof (typeof merged)['sources']['relations']>().toEqualTypeOf<'user' | 'items'>();
    expectTypeOf<keyof (typeof merged)['items']['relations']>().toEqualTypeOf<'source'>();
    expectTypeOf<keyof (typeof merged)['cache']['relations']>().toEqualTypeOf<never>();
    expectTypeOf<keyof typeof merged>().toEqualTypeOf<'users' | 'sources' | 'items' | 'cache'>();
  });

  it('gives db.query results equal to one big defineRelations', () => {
    expectTypeOf<FindMany<MergedDb, 'sources'>>().toEqualTypeOf<FindMany<OracleDb, 'sources'>>();
    expectTypeOf<FindMany<MergedDb, 'items'>>().toEqualTypeOf<FindMany<OracleDb, 'items'>>();
    expectTypeOf<FindMany<MergedDb, 'cache'>>().toEqualTypeOf<FindMany<OracleDb, 'cache'>>();
  });

  it('runs real queries across relations declared in different parts', async () => {
    const client = new PGlite('memory://');
    await client.waitReady;
    const db = drizzle({ client, relations: merged });
    await db.execute(sql`create table users (id text primary key)`);
    await db.execute(sql`create table sources (id text primary key, user_id text references users (id))`);
    await db.execute(sql`create table items (id text primary key, source_id text references sources (id))`);
    await db.insert(users).values({ id: 'u1' });
    await db.insert(sources).values({ id: 's1', userId: 'u1' });
    await db.insert(items).values([
      { id: 'i1', sourceId: 's1' },
      { id: 'i2', sourceId: null },
    ]);

    const [source] = await db.query.sources.findMany({ with: { user: true, items: true } });
    const itemRows = await db.query.items.findMany({ with: { source: true }, orderBy: { id: 'asc' } });

    expect(source?.user?.id).toBe('u1');
    expect(source?.items.map(item => item.id)).toEqual(['i1']);
    expect(itemRows.map(item => item.source?.id ?? null)).toEqual(['s1', null]);
    await client.close();
  });
});
