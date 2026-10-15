/**
 * `idColumns(defineId('sty_'))`: the browser-safe id declaration from
 * `@arki/contracts` becomes table columns here. The prefix is written once,
 * the default id comes from the declaration, and the contracts select schema
 * checks the prefix at runtime.
 */
import type { PGlite } from '@electric-sql/pglite';
import { defineRelations, sql } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';

import type { IdOf } from '@arki/contracts';
import { defineId } from '@arki/contracts';
import { createSelectSchema } from '@arki/contracts/drizzle';

import { createIdFactory, idColumns } from './id-factory.js';
import { initDbRuntimeLocal } from './runtime-local.js';

const storyId = defineId('sty_');
type StoryId = IdOf<typeof storyId>;
const universeId = defineId('univ_');

const story = idColumns(storyId);
const stories = pgTable('stories', {
  id: story.primaryColumn(),
  universeId: idColumns(universeId).reference('universe_id'),
  parentId: story.optionalReference('parent_id'),
  title: text('title').notNull(),
});
const relations = defineRelations({ stories });

let client: PGlite;
let db: Awaited<ReturnType<typeof initDbRuntimeLocal<typeof relations>>>['db'];

beforeAll(async () => {
  ({ db, pglite: client } = await initDbRuntimeLocal({ memory: true }, { relations }));
  await db.execute(
    sql`create table stories (id varchar(256) primary key, universe_id varchar(256) not null, parent_id varchar(256), title text not null)`,
  );
});

afterAll(async () => {
  await client.close();
});

describe('idColumns', () => {
  it('types every column from the declaration: no `$type<…>` written by hand', () => {
    type Row = typeof stories.$inferSelect;
    expectTypeOf<Row['id']>().toEqualTypeOf<StoryId>();
    expectTypeOf<Row['universeId']>().toEqualTypeOf<`univ_${string}`>();
    expectTypeOf<Row['parentId']>().toEqualTypeOf<StoryId | null>();
  });

  it('the primary column defaults to a fresh id from the declaration', async () => {
    const [row] = await db
      .insert(stories)
      .values({ universeId: universeId.create(), title: 'The Lighthouse' })
      .returning();
    expect(row?.id).toMatch(/^sty_[a-z][a-z0-9]{23}$/);
    expect(storyId.is(row?.id)).toBe(true);
  });

  it('the contracts select schema rejects an id of another kind', () => {
    const select = createSelectSchema(stories);
    const ok = { id: storyId.create(), universeId: universeId.create(), parentId: null, title: 't' };
    expect(select.safeParse(ok).success).toBe(true);
    expect(select.safeParse({ ...ok, universeId: storyId.create() }).success).toBe(false);
  });

  it('createIdFactory keeps working for ids declared the old way', () => {
    const poet = createIdFactory<'pt_', `pt_${string}`>('pt_');
    expect(poet.create()).toMatch(/^pt_/);
    expect(poet.make).toBe(poet.create);
    expect(poet.schema.safeParse('xx_1').success).toBe(false);
  });
});
