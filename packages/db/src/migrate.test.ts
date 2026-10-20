/**
 * Tests for `@arki/db/migrate`.
 *
 * Uses the PGlite driver and a temporary migrations folder in the layout
 * `drizzle-kit generate` (1.0) writes: one sub-folder per migration holding
 * `migration.sql`. Verifies:
 *   - `migrateDb` applies pending SQL and is idempotent
 *   - `dbMigrations()` runs inside a DOT boot, after `db`, before dependents
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineRelations, sql } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { defineApp, plugin, service } from '@arki/dot/plugin';
import { orThrow } from '@arki/failure';

import type { MigratableDb } from './migrate.js';
import { db, dbMigrations } from './dot.js';
import { migrateDb, readMigrations } from './migrate.js';
import { initDbRuntimeLocal } from './runtime-local.js';

const widgets = pgTable('widgets', { id: text('id').primaryKey(), label: text('label').notNull() });
const relations = defineRelations({ widgets });

let migrationsFolder: string;

beforeAll(() => {
  migrationsFolder = mkdtempSync(path.join(tmpdir(), 'arki-db-migrate-'));
  const dir = path.join(migrationsFolder, '20260101000000_widgets');
  mkdirSync(dir);
  writeFileSync(
    path.join(dir, 'migration.sql'),
    'CREATE TABLE "widgets" ("id" text PRIMARY KEY, "label" text NOT NULL);\n--> statement-breakpoint\nINSERT INTO "widgets" ("id", "label") VALUES (\'w1\', \'first\');\n',
  );
});

afterAll(() => {
  rmSync(migrationsFolder, { recursive: true, force: true });
});

describe('migrateDb', () => {
  it('applies pending migrations and does nothing the second time', async () => {
    const { db: handle, close } = await orThrow(initDbRuntimeLocal({ memory: true }, { relations }));
    try {
      await migrateDb(handle, { migrationsFolder });
      await migrateDb(handle, { migrationsFolder });
      const rows = await handle.select().from(widgets);
      expect(rows).toEqual([{ id: 'w1', label: 'first' }]);
      const applied = await handle.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
      expect(applied.rows[0]).toEqual({ n: 1 });
    } finally {
      await orThrow(close());
    }
  });
});

describe('migrateDb with in-memory migrations', () => {
  it('applies a list read at build time, so a bundled server needs no folder on disk', async () => {
    const migrations = readMigrations(migrationsFolder);
    expect(migrations).toHaveLength(1);
    expect(migrations[0]?.sql).toHaveLength(2);

    const { db: handle, close } = await orThrow(initDbRuntimeLocal({ memory: true }, { relations }));
    try {
      await migrateDb(handle, { migrations });
      await migrateDb(handle, { migrations });
      const rows = await handle.select().from(widgets);
      expect(rows).toEqual([{ id: 'w1', label: 'first' }]);
    } finally {
      await orThrow(close());
    }
  });
});

describe('dbMigrations()', () => {
  it('migrates during boot so a dependent plugin can read the tables', async () => {
    let seenLabels: string[] = [];
    const reader = plugin({
      name: 'reader',
      needs: { db: service<MigratableDb<typeof relations>>() },
      async boot({ db: handle }) {
        seenLabels = (await handle.select().from(widgets)).map(row => row.label);
      },
    });

    const app = await orThrow(
      defineApp('migrate-test')
        .use(db({ driver: 'pglite', memory: true, relations }))
        .use(dbMigrations<typeof relations>({ migrationsFolder }))
        .use(reader)
        .boot(),
    );
    try {
      expect(seenLabels).toEqual(['first']);
      expect(app.manifest.plugins.map(entry => entry.name)).toEqual(['db', 'db-migrations', 'reader']);
    } finally {
      await orThrow(app.dispose());
    }
  });
});
