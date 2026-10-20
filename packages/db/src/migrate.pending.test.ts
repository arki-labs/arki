/**
 * `pendingMigrations` and the `migrations` service of `dbMigrations`. `dot dev`
 * prints these names as the migrations its preflight applied, so they must be
 * exactly what `migrateDb` runs: everything on a fresh database, nothing once
 * it is up to date, only the new folder after one is added. The service must
 * be read before the plugin's `boot` migrates, or it would always be empty.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineRelations } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defineApp } from '@arki/dot/plugin';
import { orThrow } from '@arki/failure';

import { db, dbMigrations } from './dot.js';
import { migrateDb, pendingMigrations } from './migrate.js';
import { initDbRuntimeLocal } from './runtime-local.js';

const relations = defineRelations({});
let migrationsFolder: string;

function addMigration(name: string, table: string): void {
  const dir = path.join(migrationsFolder, name);
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'migration.sql'), `CREATE TABLE "${table}" ("id" text PRIMARY KEY);\n`);
}

beforeEach(() => {
  migrationsFolder = mkdtempSync(path.join(tmpdir(), 'arki-db-pending-'));
  addMigration('20260101000000_widgets', 'widgets');
  addMigration('20260102000000_gadgets', 'gadgets');
});

afterEach(() => {
  rmSync(migrationsFolder, { recursive: true, force: true });
});

describe('pendingMigrations', () => {
  it('lists every migration on a fresh database, none when up to date, then only a new one', async () => {
    const { db: handle, close } = await orThrow(initDbRuntimeLocal({ memory: true }, { relations }));
    try {
      expect(await pendingMigrations(handle, { migrationsFolder })).toEqual([
        '20260101000000_widgets',
        '20260102000000_gadgets',
      ]);
      await migrateDb(handle, { migrationsFolder });
      expect(await pendingMigrations(handle, { migrationsFolder })).toEqual([]);

      addMigration('20260103000000_doohickeys', 'doohickeys');
      expect(await pendingMigrations(handle, { migrationsFolder })).toEqual(['20260103000000_doohickeys']);
    } finally {
      await orThrow(close());
    }
  });

  it('dbMigrations publishes what this boot found pending, then applies it', async () => {
    const app = await orThrow(
      defineApp('pending')
        .use(db({ driver: 'pglite', memory: true, relations }))
        .use(dbMigrations({ migrationsFolder }))
        .boot(),
    );
    try {
      expect(app.services.migrations.pending).toEqual(['20260101000000_widgets', '20260102000000_gadgets']);
      expect(await pendingMigrations(app.services.db, { migrationsFolder })).toEqual([]);
    } finally {
      await orThrow(app.dispose());
    }
  });
});
