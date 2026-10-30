/**
 * `migrateDb` and `pendingMigrations` on SQLite (libSQL). The same contract as
 * on Postgres: apply what is pending, in order, once. SQLite has no schemas, so
 * the bookkeeping table sits in the main database.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { defineRelations, sql } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLibsqlDb } from './libsql.js';
import { migrateDb, pendingMigrations } from './migrate.js';

const widgets = sqliteTable('widgets', { id: text('id').primaryKey(), label: text('label').notNull() });
const relations = defineRelations({ widgets });

let dir: string;
let migrationsFolder: string;
let opened: ReturnType<typeof createLibsqlDb<typeof relations>>;

function writeMigration(name: string, statements: readonly string[]): void {
  const folder = path.join(migrationsFolder, name);
  mkdirSync(folder);
  writeFileSync(path.join(folder, 'migration.sql'), `${statements.join('\n--> statement-breakpoint\n')}\n`);
}

describe('migrations on libSQL', () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'arki-libsql-migrate-'));
    migrationsFolder = path.join(dir, 'migrations');
    mkdirSync(migrationsFolder);
    writeMigration('20260101000000_widgets', ['CREATE TABLE `widgets` (`id` text PRIMARY KEY, `label` text NOT NULL);']);
    writeMigration('20260102000000_seed', ["INSERT INTO `widgets` (`id`, `label`) VALUES ('w1', 'first');"]);
    opened = createLibsqlDb({ url: `file:${path.join(dir, 'app.db')}`, relations });
  });

  afterEach(() => {
    opened.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists every migration as pending on a fresh database, before the bookkeeping table exists', async () => {
    expect(await pendingMigrations(opened.db, { migrationsFolder })).toEqual([
      '20260101000000_widgets',
      '20260102000000_seed',
    ]);
  });

  it('applies pending migrations in order, then finds none pending and applies nothing again', async () => {
    // Running twice must not re-run the seed: a second insert of w1 would fail on the primary key.
    expect(await migrateDb(opened.db, { migrationsFolder })).toBeUndefined();
    expect(await migrateDb(opened.db, { migrationsFolder })).toBeUndefined();
    expect(await opened.db.select().from(widgets)).toEqual([{ id: 'w1', label: 'first' }]);
    expect(await pendingMigrations(opened.db, { migrationsFolder })).toEqual([]);
  });

  it('applies only what was added since the last run', async () => {
    expect(await migrateDb(opened.db, { migrationsFolder })).toBeUndefined();
    writeMigration('20260103000000_more', ["INSERT INTO `widgets` (`id`, `label`) VALUES ('w2', 'second');"]);
    expect(await pendingMigrations(opened.db, { migrationsFolder })).toEqual(['20260103000000_more']);
    expect(await migrateDb(opened.db, { migrationsFolder })).toBeUndefined();
    expect(await opened.db.$count(widgets)).toBe(2);
  });

  it('honours a custom bookkeeping table name', async () => {
    expect(await migrateDb(opened.db, { migrationsFolder, migrationsTable: 'schema_history' })).toBeUndefined();
    const tables = await opened.db.all(sql`select name from sqlite_master where name = 'schema_history'`);
    expect(tables).toHaveLength(1);
    expect(await pendingMigrations(opened.db, { migrationsFolder, migrationsTable: 'schema_history' })).toEqual([]);
  });
});
