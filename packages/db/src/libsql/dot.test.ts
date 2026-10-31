/**
 * Tests for the libSQL DOT adapter: boot on a SQLite file, migrate at boot with
 * `dbMigrations()` from `@arki/db/dot`, and refuse a Postgres URL with a coded error.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { defineRelations, sql } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defineApp } from '@arki/dot/unit';
import { orThrow, UnexpectedDefect } from '@arki/failure';

import { DB_PLUGIN_ERROR_CODES, dbMigrations } from '../dot.js';
import { db } from './dot.js';

const notes = sqliteTable('notes', { id: text('id').primaryKey() });
const relations = defineRelations({ notes });

describe('@arki/db/libsql/dot', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'arki-db-dot-libsql-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('boots a SQLite file, runs a query, and closes it on dispose', async () => {
    const url = `file:${path.join(dir, 'app.db')}`;
    const app = await orThrow(defineApp('db-libsql').infra(db({ relations, url: () => url })).boot());
    try {
      await app.services.db.run(sql`create table notes (id text primary key)`);
      await app.services.db.run(sql`insert into notes values ('n1')`);
      expect(await app.services.db.all(sql`select id from notes`)).toEqual([{ id: 'n1' }]);
    } finally {
      await orThrow(app.dispose());
    }
  });

  it('migrates at boot with dbMigrations(), the same plugin Postgres apps use', async () => {
    const migrationsFolder = path.join(dir, 'migrations');
    mkdirSync(path.join(migrationsFolder, '20260101000000_notes'), { recursive: true });
    writeFileSync(
      path.join(migrationsFolder, '20260101000000_notes', 'migration.sql'),
      'CREATE TABLE `notes` (`id` text PRIMARY KEY);\n',
    );
    const url = `file:${path.join(dir, 'app.db')}`;
    const app = await orThrow(
      defineApp('db-libsql-migrate')
        .infra(db({ relations, url: () => url }))
        .infra(dbMigrations({ migrationsFolder }))
        .boot(),
    );
    try {
      expect(app.services.migrations.pending).toEqual(['20260101000000_notes']);
      expect(await app.services.db.all(sql`select name from sqlite_master where name = 'notes'`)).toHaveLength(1);
    } finally {
      await orThrow(app.dispose());
    }
  });

  it('refuses a postgres:// URL, naming the mix-up', async () => {
    // Without the check, libSQL fails later with an unrelated "unsupported URL" error.
    const caught = await defineApp('db-libsql-pg-url')
      .infra(db({ relations, url: () => 'postgres://app:pw@localhost:5432/app' }))
      .boot();
    if (!UnexpectedDefect.is(caught)) throw new Error('boot should return UnexpectedDefect');
    expect(caught.cause).toMatchObject({ code: DB_PLUGIN_ERROR_CODES.driverUrlMismatch });
  });
});
