/**
 * The kit's promise: a table written once against `ColumnKit<D>` has, on each
 * dialect, exactly the type the hand-written Drizzle table has. If one of
 * these drifts, apps silently get weaker row or insert types.
 */
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import * as sqlite from 'drizzle-orm/sqlite-core';
import { expectTypeOf } from 'vitest';

import type { Settings } from './__fixtures__/kit/note-tables.js';
import type { ColumnKit, Dialect } from './columns.js';
import { noteId, noteTables, pgNotes, settingsSchema, STATUSES } from './__fixtures__/kit/note-tables.js';
import { pgColumns } from './columns-pg.js';
import { sqliteColumns } from './columns-sqlite.js';
import { idColumns as sqliteIdColumns, instant as sqliteInstant } from './sqlite.js';

const pgKit = noteTables(pgColumns());
const sqliteKit = noteTables(sqliteColumns());

// The SQLite table, hand-written in the order the kit replays a chain.
const sqliteNotes = sqlite.sqliteTable('notes', {
  id: sqliteIdColumns(noteId).primaryColumn(),
  title: sqlite.text('title').notNull(),
  body: sqlite.text(),
  status: sqlite.text('status', { enum: STATUSES }).notNull().default('draft'),
  slug: sqlite.text('slug').notNull().unique(),
  digest: sqlite.text('digest'),
  views: sqlite.integer('views', { mode: 'number' }).notNull().default(0),
  size: sqlite.integer('size', { mode: 'number' }),
  pinned: sqlite.integer('pinned', { mode: 'boolean' }).notNull().default(false),
  tags: sqlite.text('tags', { mode: 'json' }).$type<string[]>().notNull(),
  settings: sqlite.text('settings', { mode: 'json' }).$type<Settings>(),
  createdAt: sqlite.integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`0`),
  updatedAt: sqlite
    .integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date()),
  expiresAt: sqliteInstant('expires_at').default(sql`0`),
});

// Postgres: every column is the hand-written column, so rows, inserts and updates match too.
expectTypeOf(pgKit.notes.id).toEqualTypeOf(pgNotes.id);
expectTypeOf(pgKit.notes.status).toEqualTypeOf(pgNotes.status);
expectTypeOf(pgKit.notes.slug).toEqualTypeOf(pgNotes.slug);
expectTypeOf(pgKit.notes.tags).toEqualTypeOf(pgNotes.tags);
expectTypeOf(pgKit.notes.settings).toEqualTypeOf(pgNotes.settings);
expectTypeOf(pgKit.notes.createdAt).toEqualTypeOf(pgNotes.createdAt);
expectTypeOf(pgKit.notes.updatedAt).toEqualTypeOf(pgNotes.updatedAt);
expectTypeOf(pgKit.notes.expiresAt).toEqualTypeOf(pgNotes.expiresAt);
expectTypeOf(pgKit.notes.$inferSelect).toEqualTypeOf(pgNotes.$inferSelect);
expectTypeOf(pgKit.notes.$inferInsert).toEqualTypeOf(pgNotes.$inferInsert);
expectTypeOf(pgKit.notes._.columns).toEqualTypeOf(pgNotes._.columns);

// SQLite: the same, against the hand-written SQLite table.
expectTypeOf(sqliteKit.notes.$inferSelect).toEqualTypeOf(sqliteNotes.$inferSelect);
expectTypeOf(sqliteKit.notes.$inferInsert).toEqualTypeOf(sqliteNotes.$inferInsert);
expectTypeOf(sqliteKit.notes._.columns).toEqualTypeOf(sqliteNotes._.columns);
expectTypeOf(sqliteKit.notes).toEqualTypeOf(sqliteNotes);

// The rows a query returns are the hand-written table's rows.
declare const pgDb: PgliteDatabase;
declare const sqliteDb: LibSQLDatabase;
expectTypeOf(pgDb.select().from(pgKit.notes)).resolves.toEqualTypeOf<(typeof pgNotes.$inferSelect)[]>();
expectTypeOf(sqliteDb.select().from(sqliteKit.notes)).resolves.toEqualTypeOf<(typeof sqliteNotes.$inferSelect)[]>();
expectTypeOf(sqliteKit.comments.$inferSelect.noteId).toEqualTypeOf(sqliteNotes.$inferSelect.id);

// A kit table keeps Drizzle's dialect check.
// @ts-expect-error -- a SQLite table cannot be read through a Postgres db
void pgDb.select().from(sqliteKit.notes);
// The SQLite query builder does not check the dialect of a table, for hand-written tables either; the kit adds no check there.

// Chains Drizzle would refuse are refused by the kit too.
declare const kit: ColumnKit<Dialect>;
// @ts-expect-error -- only time columns have a database "now"
kit.text('name').defaultNow();
// @ts-expect-error -- an enum column's default must be one of its values
kit.text('status', { enum: STATUSES }).default('archived');
// @ts-expect-error -- a json column checked by a schema takes that schema's values
kit.json('settings', settingsSchema).default({ theme: 'blue' });
