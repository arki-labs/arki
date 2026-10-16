/**
 * Tests for the db DOT adapter.
 *
 * Uses the PGlite driver throughout — no external Postgres required.
 * Verifies:
 *   - manifest contribution (one `db`-kind service entry)
 *   - boot opens a Drizzle handle, dispose closes the underlying PGlite
 *   - sanity-check round-trip query through the booted handle
 *   - multi-instance mount via rename()
 */

import { defineApp, DotLifecycleError, DotPluginError, rename } from '@arki/dot/plugin';
import { defineRelations } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DB_PLUGIN_ERROR_CODES, db } from './dot.js';

const widgets = pgTable('widgets', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
});

const schema = { widgets };
const relations = defineRelations(schema);

// The env module validates DB_URL once and keeps the result, so deleting it from process.env
// later changes nothing. A fresh module graph with the env mocked simulates a missing DB_URL;
// DotPluginError comes from the same graph so `instanceof` still holds.
async function importDotWithoutDbUrl(): Promise<{
  db: (typeof import('./dot.js'))['db'];
  DotPluginError: (typeof import('@arki/dot/plugin'))['DotPluginError'];
}> {
  vi.resetModules();
  vi.doMock('./env.js', () => ({ env: { DB_URL: undefined } }));
  const [{ db: freshDb }, { DotPluginError: FreshDotPluginError }] = await Promise.all([
    import('./dot.js'),
    import('@arki/dot/plugin'),
  ]);
  return { db: freshDb, DotPluginError: FreshDotPluginError };
}

describe('@arki/db/dot', () => {
  afterEach(() => {
    vi.doUnmock('./env.js');
    vi.resetModules();
  });

  it('contributes a db-kind service to the manifest', () => {
    const configured = defineApp('db-manifest-test')
      .use(db({ driver: 'pglite', memory: true, relations }))
      .configure();
    expect(configured.manifest.services).toEqual([
      { name: 'db', plugin: 'db', kind: 'db' },
    ]);
    expect(configured.manifest.plugins.map(p => p.name)).toEqual(['db']);
  });

  it('boots a PGlite-backed Drizzle handle and disposes cleanly', async () => {
    const app = await defineApp('db-lifecycle-test')
      .use(db({ driver: 'pglite', memory: true, relations }))
      .boot();
    try {
      expect(app.services.db).toBeDefined();
      // Drizzle handle has the standard `select`/`insert` methods even
      // before any schema is created.
      expect(typeof app.services.db.select).toBe('function');
      expect(typeof app.services.db.insert).toBe('function');
    } finally {
      await app.dispose();
    }
  });

  it('can execute a round-trip query via the booted handle', async () => {
    const app = await defineApp('db-query-test')
      .use(db({ driver: 'pglite', memory: true, relations }))
      .boot();
    try {
      // Use the raw client to create the table — Drizzle migrations are
      // outside the adapter's concern.
      await app.services.db.execute(
        `CREATE TABLE widgets (id text PRIMARY KEY, label text NOT NULL)`,
      );
      await app.services.db
        .insert(widgets)
        .values({ id: 'a', label: 'first' });
      const rows = await app.services.db.select().from(widgets);
      expect(rows).toEqual([{ id: 'a', label: 'first' }]);
    } finally {
      await app.dispose();
    }
  });

  it('throws a coded DotPluginError when DB_URL is not configured (pg driver)', async () => {
    // The kernel wraps any throw from a boot hook in DotLifecycleError so
    // every boot failure has a uniform outer shape. The original throw is
    // preserved on `.cause` — that's what consumers and coding agents
    // match against for the stable code / remediation / docsUrl.
    const { db: dbWithoutUrl, DotPluginError: FreshDotPluginError } = await importDotWithoutDbUrl();
    {
      const caught = await defineApp('db-missing-url')
        .use(dbWithoutUrl({ relations }))
        .boot()
        .catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(DotLifecycleError);
      const cause = (caught as DotLifecycleError).cause;
      expect(cause).toBeInstanceOf(FreshDotPluginError);
      const pluginErr = cause as DotPluginError;
      expect(pluginErr.code).toBe(DB_PLUGIN_ERROR_CODES.dbUrlNotConfigured);
      expect(pluginErr.code).toBe('ARKI_DB_PLUGIN_E001');
      expect(pluginErr.message).toMatch(/DB_URL is not configured/);
      expect(pluginErr.remediation).toMatch(/DB_URL|pglite/);
      expect(pluginErr.docsUrl).toMatch(/^https?:\/\//);
    }
  });

  it('reads the url thunk when the app boots, never at import — the handle exists before', async () => {
    // Why: an app module declares `database = db({ relations, url: () => env.DB_URL })`
    // at top level and features name `database.provides.db`. Importing that
    // module must not read env or open a pool.
    let reads = 0;
    const { db: dbWithoutUrl } = await importDotWithoutDbUrl();
    const database = dbWithoutUrl({
      relations,
      url: () => {
        reads += 1;
        return undefined;
      },
    });
    expect(database.provides.db).toMatchObject({ key: 'db', provider: 'db' });
    const builder = defineApp('db-url-thunk').use(database);
    builder.configure();
    expect(reads).toBe(0);

    const caught = await builder.boot().catch((error: unknown) => error);
    expect(reads).toBe(1);
    expect(((caught as DotLifecycleError).cause as DotPluginError).code).toBe(DB_PLUGIN_ERROR_CODES.dbUrlNotConfigured);
  });

  it('mounts a second db scope via rename()', async () => {
    const app = await defineApp('db-named-test')
      .use(db({ driver: 'pglite', memory: true, relations }))
      .use(rename(db({ driver: 'pglite', memory: true, relations }), { db: 'reportsDb' }, 'reports-db'))
      .boot();
    try {
      expect(app.manifest.plugins.map(p => p.name)).toEqual(['db', 'reports-db']);
      expect(app.services.db).toBeDefined();
      expect(app.services.reportsDb).toBeDefined();
      expect(app.services.db).not.toBe(app.services.reportsDb);
      // The two instances are isolated databases.
      await app.services.db.execute(`CREATE TABLE only_primary (id text PRIMARY KEY)`);
      await expect(app.services.reportsDb.execute(`SELECT * FROM only_primary`)).rejects.toThrow();
    } finally {
      await app.dispose();
    }
  });
});
