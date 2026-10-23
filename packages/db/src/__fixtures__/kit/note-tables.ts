/** Sample tables written once against the column kit, plus the same Postgres tables written by hand. */
import { sql } from 'drizzle-orm';
import * as pg from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { defineId } from '@arki/contracts';

import type { ColumnKit, Dialect } from '../../columns.js';
import { idColumns as pgIdColumns } from '../../id-factory.js';
import { instant as pgInstant } from '../../temporal.js';

/** The kit's table definitions, the way a package writes them. */
export const noteId = defineId('note_');
export const settingsSchema = z.object({ theme: z.enum(['light', 'dark']) });
export type Settings = z.output<typeof settingsSchema>;
export const STATUSES = ['draft', 'ready'] as const;

export function noteTables<D extends Dialect>(c: ColumnKit<D>) {
  const notes = c.table(
    'notes',
    {
      id: c.id(noteId).primaryColumn(),
      title: c.text('title').notNull(),
      body: c.text(),
      status: c.text('status', { enum: STATUSES }).notNull().default('draft'),
      slug: c.varchar('slug', { length: 64 }).notNull().unique(),
      digest: c.char('digest', { length: 64 }),
      views: c.integer('views').notNull().default(0),
      size: c.bigint('size'),
      pinned: c.boolean('pinned').notNull().default(false),
      tags: c.json('tags').$type<string[]>().notNull(),
      settings: c.json('settings', settingsSchema),
      createdAt: c.timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updatedAt: c
        .timestamp('updated_at')
        .notNull()
        .$defaultFn(() => new Date())
        .$onUpdateFn(() => new Date()),
      expiresAt: c.instant('expires_at', { precision: 3 }).defaultNow(),
    },
    (t) => [
      c.index('notes_created').on(t.createdAt, c.desc(t.id)),
      c.uniqueIndex('notes_ready_title').on(t.title).where(sql`${t.status} = 'ready'`),
      c.check('notes_views_positive', sql`${t.views} >= 0`),
    ],
  );
  const comments = c.table('comments', {
    id: c.text('id').primaryKey(),
    noteId: c.id(noteId).foreignKey('note_id', () => notes.id, { onDelete: 'cascade' }),
    parentId: c.id(noteId).optionalReference('parent_id'),
  });
  const noteEvents = c.table('note_events', {
    seq: c.serial('seq'),
    noteId: c.id(noteId).reference('note_id'),
  });
  return { notes, comments, noteEvents };
}

export const pgNotes = pg.pgTable('notes', {
  id: pgIdColumns(noteId).primaryColumn(),
  title: pg.text('title').notNull(),
  body: pg.text(),
  status: pg.text('status', { enum: STATUSES }).notNull().default('draft'),
  slug: pg.varchar('slug', { length: 64 }).notNull().unique(),
  digest: pg.char('digest', { length: 64 }),
  views: pg.integer('views').notNull().default(0),
  size: pg.bigint('size', { mode: 'number' }),
  pinned: pg.boolean('pinned').notNull().default(false),
  tags: pg.jsonb('tags').$type<string[]>().notNull(),
  settings: pg.jsonb('settings').$type<Settings>(),
  createdAt: pg.timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: pg
    .timestamp('updated_at', { mode: 'date' })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date()),
  expiresAt: pgInstant('expires_at', { precision: 3 }).default(sql`now()`),
}, (t) => [
  pg.index('notes_created').on(t.createdAt, t.id.desc()),
  pg.uniqueIndex('notes_ready_title').on(t.title).where(sql`${t.status} = 'ready'`),
  pg.check('notes_views_positive', sql`${t.views} >= 0`),
]);
export const pgComments = pg.pgTable('comments', {
  id: pg.text('id').primaryKey(),
  noteId: pgIdColumns(noteId).foreignKey('note_id', () => pgNotes.id, { onDelete: 'cascade' }),
  parentId: pgIdColumns(noteId).optionalReference('parent_id'),
});
export const pgNoteEvents = pg.pgTable('note_events', {
  seq: pg.bigserial('seq', { mode: 'number' }).primaryKey(),
  noteId: pgIdColumns(noteId).reference('note_id'),
});
