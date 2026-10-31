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

import { defineRelations } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RandomSourceUnavailable } from '@arki/contracts';
import { defineApp, rename } from '@arki/dot/unit';
import { isFailure, orThrow, UnexpectedDefect } from '@arki/failure';

import { db, DB_PLUGIN_ERROR_CODES } from './dot.js';

const widgets = pgTable('widgets', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
});

const schema = { widgets };
const relations = defineRelations(schema);

// The env module validates DB_URL once and keeps the result, so deleting it from process.env
// later changes nothing. A fresh module graph with the env mocked simulates a missing DB_URL;
// DotUnitError comes from the same graph so `instanceof` still holds.
async function importDotWithoutDbUrl(): Promise<{
  db: (typeof import('./dot.js'))['db'];
  DotUnitError: (typeof import('@arki/dot/unit'))['DotUnitError'];
}> {
  vi.resetModules();
  vi.doMock('./env.js', () => ({ env: { DB_URL: undefined } }));
  const [{ db: freshDb }, { DotUnitError: FreshDotPluginError }] = await Promise.all([
    import('./dot.js'),
    import('@arki/dot/unit'),
  ]);
  return { db: freshDb, DotUnitError: FreshDotPluginError };
}

const connectionStringOf = (pool: unknown) => (pool as { options: { connectionString?: string } }).options.connectionString;

// Drizzle's type leaves out `$client`; dot.ts's dispose widens the handle the same way.
type WithClient = { readonly $client: { end(): Promise<void> } };
const queryPoolOf = <Handle extends object>(handle: Handle) => (handle as Handle & WithClient).$client;

describe('@arki/db/dot', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('./env.js');
    vi.resetModules();
  });

  it('returns entropy refusal from the PGlite provider before opening a file database', async () => {
    vi.stubGlobal('crypto', {});
    const result = await defineApp('db-no-entropy')
      .infra(db({ driver: 'pglite', dataDir: './must-not-open-without-entropy', relations }))
      .boot();
    expect(RandomSourceUnavailable.is(result)).toBe(true);
  });

  it('contributes a db-kind service to the manifest', () => {
    const configured = orThrow(
      defineApp('db-manifest-test')
        .infra(db({ driver: 'pglite', memory: true, relations }))
        .configure(),
    );
    expect(configured.manifest.services).toEqual([{ name: 'db', plugin: 'db', kind: 'db' }]);
    expect(configured.manifest.plugins.map(p => p.name)).toEqual(['db']);
  });

  it('boots a PGlite-backed Drizzle handle and disposes cleanly', async () => {
    const app = await orThrow(
      defineApp('db-lifecycle-test')
        .infra(db({ driver: 'pglite', memory: true, relations }))
        .boot(),
    );
    try {
      expect(app.services.db).toBeDefined();
      // Drizzle handle has the standard `select`/`insert` methods even
      // before any schema is created.
      expect(typeof app.services.db.select).toBe('function');
      expect(typeof app.services.db.insert).toBe('function');
    } finally {
      await orThrow(app.dispose());
    }
  });

  it('can execute a round-trip query via the booted handle', async () => {
    const app = await orThrow(
      defineApp('db-query-test')
        .infra(db({ driver: 'pglite', memory: true, relations }))
        .boot(),
    );
    try {
      // Use the raw client to create the table — Drizzle migrations are
      // outside the adapter's concern.
      await app.services.db.execute(`CREATE TABLE widgets (id text PRIMARY KEY, label text NOT NULL)`);
      await app.services.db.insert(widgets).values({ id: 'a', label: 'first' });
      const rows = await app.services.db.select().from(widgets);
      expect(rows).toEqual([{ id: 'a', label: 'first' }]);
    } finally {
      await orThrow(app.dispose());
    }
  });

  it('returns a defect preserving the coded DotUnitError when DB_URL is not configured (pg driver)', async () => {
    // Legacy plugin throws return a defect with the original coded cause.
    const { db: dbWithoutUrl, DotUnitError: FreshDotPluginError } = await importDotWithoutDbUrl();
    {
      const caught = await defineApp('db-missing-url').infra(dbWithoutUrl({ relations })).boot();
      if (!UnexpectedDefect.is(caught)) throw new Error('boot should return UnexpectedDefect');
      const cause = caught.cause;
      expect(cause).toBeInstanceOf(FreshDotPluginError);
      if (!(cause instanceof FreshDotPluginError)) throw new Error('cause should be a DotUnitError');
      const pluginErr = cause;
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
    const { db: dbWithoutUrl, DotUnitError: FreshDotPluginError } = await importDotWithoutDbUrl();
    const database = dbWithoutUrl({
      relations,
      url: () => {
        reads += 1;
        return undefined;
      },
    });
    expect(database.provides.db).toMatchObject({ key: 'db', provider: 'db' });
    const builder = defineApp('db-url-thunk').infra(database);
    orThrow(builder.configure());
    expect(reads).toBe(0);

    const caught = await builder.boot();
    expect(reads).toBe(1);
    if (!UnexpectedDefect.is(caught)) throw new Error('boot should return UnexpectedDefect');
    if (!(caught.cause instanceof FreshDotPluginError)) throw new Error('cause should be a DotUnitError');
    expect(caught.cause.code).toBe(DB_PLUGIN_ERROR_CODES.dbUrlNotConfigured);
  });

  describe('sessionPool', () => {
    const neonPooled = 'postgresql://app:pw@ep-x-123-pooler.eu-central-1.aws.neon.tech/neondb';
    const neonDirect = 'postgresql://app:pw@ep-x-123.eu-central-1.aws.neon.tech/neondb';
    // pg.Pool opens no socket until connect(), so these boots need no database.

    it('boots on a pooled DB_URL but refuses LISTEN through it, naming the host and the fix', async () => {
      // Why: an app that never listens must run on the pooler; one that does must not hear silence.
      const app = await orThrow(defineApp('db-session-pooled').infra(db({ relations, url: () => neonPooled })).boot());
      try {
        await expect(app.services.sessionPool.connect()).rejects.toMatchObject({
          code: DB_PLUGIN_ERROR_CODES.sessionOnPooledUrl,
          message: expect.stringContaining('neon pooler'),
          remediation: expect.stringContaining('DB_DIRECT_URL'),
        });
      } finally {
        await orThrow(app.dispose());
      }
    });

    it('connects to directUrl when given, so listeners skip the pooler', async () => {
      const app = await orThrow(
        defineApp('db-session-direct')
          .infra(db({ relations, url: () => neonPooled, directUrl: () => neonDirect }))
          .boot(),
      );
      try {
        expect(connectionStringOf(app.services.sessionPool)).toBe(neonDirect);
      } finally {
        await orThrow(app.dispose());
      }
    });

    it('reuses a direct DB_URL, so plain Postgres needs one URL', async () => {
      const app = await orThrow(defineApp('db-session-plain').infra(db({ relations, url: () => neonDirect })).boot());
      try {
        expect(connectionStringOf(app.services.sessionPool)).toBe(neonDirect);
        expect(app.services.sessionPool).not.toBe(queryPoolOf(app.services.db));
      } finally {
        await orThrow(app.dispose());
      }
    });

    it('still ends the session pool when the query pool end() rejects, and reports the failure', async () => {
      const app = await orThrow(defineApp('db-session-dispose-fail').infra(db({ relations, url: () => neonDirect })).boot());
      const queryEnd = vi.spyOn(queryPoolOf(app.services.db), 'end').mockRejectedValue(new Error('query pool end failed'));
      const sessionEnd = vi.spyOn(app.services.sessionPool, 'end').mockImplementation(() => Promise.resolve());
      const outcome = await app.dispose();
      expect(queryEnd).toHaveBeenCalledOnce();
      expect(sessionEnd).toHaveBeenCalledOnce();
      expect(isFailure(outcome)).toBe(true);
    });

    it('ends the session pool on dispose, after the query pool', async () => {
      const app = await orThrow(defineApp('db-session-dispose').infra(db({ relations, url: () => neonDirect })).boot());
      const order: string[] = [];
      const queryEnd = vi.spyOn(queryPoolOf(app.services.db), 'end').mockImplementation(() => {
        order.push('query');
        return Promise.resolve();
      });
      const sessionEnd = vi.spyOn(app.services.sessionPool, 'end').mockImplementation(() => {
        order.push('session');
        return Promise.resolve();
      });
      await orThrow(app.dispose());
      expect(queryEnd).toHaveBeenCalledOnce();
      expect(sessionEnd).toHaveBeenCalledOnce();
      expect(order).toEqual(['query', 'session']);
    });
  });

  it('refuses a SQLite URL for the pg driver, so a SQLite app on the wrong entry fails at boot', async () => {
    // The likeliest slip: a file: URL given to @arki/db/dot instead of @arki/db/libsql/dot.
    const caught = await defineApp('db-pg-file-url')
      .infra(db({ relations, url: () => 'file:./app.db' }))
      .boot();
    if (!UnexpectedDefect.is(caught)) throw new Error('boot should return UnexpectedDefect');
    expect(caught.cause).toMatchObject({ code: DB_PLUGIN_ERROR_CODES.driverUrlMismatch });
  });

  it('mounts a second db scope via rename()', async () => {
    const app = await orThrow(
      defineApp('db-named-test')
        .infra(db({ driver: 'pglite', memory: true, relations }))
        .infra(rename(db({ driver: 'pglite', memory: true, relations }), { db: 'reportsDb' }, 'reports-db'))
        .boot(),
    );
    try {
      expect(app.manifest.plugins.map(p => p.name)).toEqual(['db', 'reports-db']);
      expect(app.services.db).toBeDefined();
      expect(app.services.reportsDb).toBeDefined();
      expect(app.services.db).not.toBe(app.services.reportsDb);
      // The two instances are isolated databases.
      await app.services.db.execute(`CREATE TABLE only_primary (id text PRIMARY KEY)`);
      await expect(app.services.reportsDb.execute(`SELECT * FROM only_primary`)).rejects.toThrow();
    } finally {
      await orThrow(app.dispose());
    }
  });
});
