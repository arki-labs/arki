/**
 * The kit's runtime promises. On Postgres, drizzle-kit cannot tell a kit
 * table from the hand-written one, so an app that switches gets no
 * migration. On SQLite, drizzle-kit generates a schema libSQL accepts, and
 * that schema keeps the Postgres rules: length limits, partial unique
 * indexes, foreign keys and defaults.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineRelations, eq } from 'drizzle-orm';
import { getTableConfig, pgSchema } from 'drizzle-orm/pg-core';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Temporal } from '@arki/date/types';

import { noteTables, pgComments, pgNotes } from './__fixtures__/kit/note-tables.js';
import { comments, notes } from './__fixtures__/kit/sqlite-schema.js';
import { pgColumns } from './columns-pg.js';
import { createLibsqlDb } from './libsql.js';
import { migrateDb } from './migrate.js';
import { findDatabaseError } from './sql-state.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The `bin.cjs` drizzle-kit installs as its command; the package exports only `./cli`, which sits beside it.
const drizzleKitBin = path.join(path.dirname(createRequire(import.meta.url).resolve('drizzle-kit/cli')), 'bin.cjs');

async function sqlStateOf(write: Promise<unknown>): Promise<string | undefined> {
  try {
    await write;
  } catch (error) {
    return findDatabaseError(error)?.sqlState;
  }
  return undefined;
}

describe('pgColumns', () => {
  it('builds tables drizzle-kit cannot tell from the hand-written ones, so switching needs no migration', async () => {
    const kit = noteTables(pgColumns());
    const handWritten = await generateDrizzleJson({ notes: pgNotes, comments: pgComments });
    const built = await generateDrizzleJson({ notes: kit.notes, comments: kit.comments });

    expect(await generateMigration(handWritten, built)).toEqual([]);
    // The comparison is not empty because both sides are empty.
    expect(await generateMigration(await generateDrizzleJson({}), built)).not.toEqual([]);
  });

  it('puts the tables in the schema it was given', () => {
    const kit = noteTables(pgColumns(pgSchema('app')));
    expect(getTableConfig(kit.notes).schema).toBe('app');
    expect(getTableConfig(noteTables(pgColumns()).notes).schema).toBeUndefined();
  });
});

describe('sqliteColumns, through drizzle-kit and migrateDb on libSQL', () => {
  const relations = defineRelations({ notes, comments });
  let dir: string;
  let opened: ReturnType<typeof createLibsqlDb<typeof relations>>;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'arki-column-kit-'));
    const migrationsFolder = path.join(dir, 'migrations');
    // The app's own flow: drizzle-kit reads the kit-built schema file and writes the SQL.
    execFileSync(
      process.execPath,
      [drizzleKitBin, 'generate', '--dialect', 'sqlite', '--schema', 'src/__fixtures__/kit/sqlite-schema.ts', '--out', migrationsFolder],
      { cwd: packageRoot, stdio: 'pipe' },
    );
    opened = createLibsqlDb({ url: `file:${path.join(dir, 'app.db')}`, relations });
    await migrateDb(opened.db, { migrationsFolder });
  }, 60_000);

  afterAll(() => {
    opened.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('fills every default and reads every kind back as its JS type', async () => {
    const before = Date.now();
    const [note] = await opened.db.insert(notes).values({ title: 'First', slug: 'first', tags: ['a', 'b'] }).returning();

    expect(note).toMatchObject({
      title: 'First',
      body: null,
      status: 'draft',
      views: 0,
      pinned: false,
      tags: ['a', 'b'],
      settings: null,
    });
    expect(note?.id).toMatch(/^note_/);
    // The database's "now" is milliseconds, read back as a Date and a Temporal.Instant.
    expect(note?.createdAt).toBeInstanceOf(Date);
    expect(note?.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(note?.expiresAt).toBeInstanceOf(Temporal.Instant);
    expect(note?.updatedAt).toBeInstanceOf(Date);
  });

  it('keeps json, boolean and 64-bit numbers exact', async () => {
    const [note] = await opened.db
      .insert(notes)
      .values({ title: 'Big', slug: 'big', tags: [], pinned: true, size: Number.MAX_SAFE_INTEGER, settings: { theme: 'dark' } })
      .returning();
    expect(note).toMatchObject({ pinned: true, size: Number.MAX_SAFE_INTEGER, settings: { theme: 'dark' } });
  });

  it('refuses a value longer than its varchar limit, as Postgres does', async () => {
    const tooLong = 'x'.repeat(65);
    expect(await sqlStateOf(opened.db.insert(notes).values({ title: 'Long', slug: tooLong, tags: [] }))).toBe('23514');
  });

  it('applies a partial unique index only to the rows its predicate selects', async () => {
    // Drafts may share a title; two ready notes may not.
    await opened.db.insert(notes).values({ title: 'Twin', slug: 'twin-1', tags: [] });
    await opened.db.insert(notes).values({ title: 'Twin', slug: 'twin-2', tags: [] });
    await opened.db.insert(notes).values({ title: 'Twin', slug: 'twin-3', tags: [], status: 'ready' });
    expect(
      await sqlStateOf(opened.db.insert(notes).values({ title: 'Twin', slug: 'twin-4', tags: [], status: 'ready' })),
    ).toBe('23505');
  });

  it('enforces foreign keys and cascades deletes', async () => {
    const [note] = await opened.db.insert(notes).values({ title: 'Parent', slug: 'parent', tags: [] }).returning();
    if (!note) throw new Error('insert returned no row');
    await opened.db.insert(comments).values({ id: 'c1', noteId: note.id });

    expect(await sqlStateOf(opened.db.insert(comments).values({ id: 'c2', noteId: 'note_missing' }))).toBe('23503');
    await opened.db.delete(notes).where(eq(notes.id, note.id));
    expect(await opened.db.select().from(comments).where(eq(comments.id, 'c1'))).toEqual([]);
  });

  it('refuses a row that breaks a table check', async () => {
    expect(await sqlStateOf(opened.db.insert(notes).values({ title: 'Neg', slug: 'neg', tags: [], views: -1 }))).toBe('23514');
  });
});
