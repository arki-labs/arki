/**
 * SQLite `idColumns`: same promises as the Postgres ones in `id-columns.test.ts`
 * (branded type, prefix check, foreign keys), proven on in-memory libSQL.
 */
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { IdOf } from '@arki/contracts';
import { defineId } from '@arki/contracts';
import { createInsertSchema } from '@arki/contracts/drizzle';
import { orThrow } from '@arki/failure';

import { idColumns } from './sqlite.js';

const storyId = defineId('sty_');
type StoryId = IdOf<typeof storyId>;
const universeId = defineId('univ_');

const universes = sqliteTable('universes', { id: idColumns(universeId).primaryColumn() });
const stories = sqliteTable('stories', {
  id: idColumns(storyId).primaryColumn(),
  universeId: idColumns(universeId).foreignKey('universe_id', () => universes.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
});

describe('sqlite idColumns', () => {
  it('types a column as the branded id, so a plain string cannot be stored', () => {
    expectTypeOf<typeof stories.$inferSelect.id>().toEqualTypeOf<StoryId>();
    expectTypeOf<typeof stories.$inferInsert.id>().toEqualTypeOf<StoryId | undefined>();
  });

  it('the contracts insert schema rejects an id with the wrong prefix', () => {
    // The brand is only a type; the stamped schema is what checks it at runtime.
    const insert = createInsertSchema(stories);
    const row = { id: storyId.create(), universeId: universeId.create(), title: 't' };
    expect(insert.safeParse(row).success).toBe(true);
    expect(insert.safeParse({ ...row, universeId: storyId.create() }).success).toBe(false);
  });

  it('enforces a foreign key in the database', async () => {
    // A foreign key helper that only types the column would let orphan rows in.
    const client = createClient({ url: ':memory:' });
    await client.execute('PRAGMA foreign_keys = ON');
    await client.execute('CREATE TABLE universes (id TEXT PRIMARY KEY NOT NULL)');
    await client.execute(
      'CREATE TABLE stories (id TEXT PRIMARY KEY NOT NULL, universe_id TEXT NOT NULL REFERENCES universes(id) ON DELETE CASCADE, title TEXT NOT NULL)',
    );
    const db = drizzle({ client });
    const orphan = { id: orThrow(storyId.create()), universeId: orThrow(universeId.create()), title: 't' };
    await expect(db.insert(stories).values(orphan)).rejects.toThrow();

    const universe = { id: orThrow(universeId.create()) };
    await db.insert(universes).values(universe);
    await db.insert(stories).values({ ...orphan, universeId: universe.id });
    expect(await db.select().from(stories)).toHaveLength(1);
    client.close();
  });

  it('generates a prefixed id when none is given', async () => {
    // The default comes from the declaration's generator, not from the caller.
    const client = createClient({ url: ':memory:' });
    await client.execute('CREATE TABLE universes (id TEXT PRIMARY KEY NOT NULL)');
    const db = drizzle({ client });
    const [row] = await db.insert(universes).values({}).returning();
    expect(row?.id.startsWith('univ_')).toBe(true);
    client.close();
  });
});
