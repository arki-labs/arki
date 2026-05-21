/**
 * Tests for the db DOT adapter.
 *
 * Uses the PGlite driver throughout — no external Postgres required.
 * Verifies:
 *   - manifest contribution (one `db`-kind service entry)
 *   - boot opens a Drizzle handle, dispose closes the underlying PGlite
 *   - sanity-check round-trip query through the booted handle
 *   - custom pip-name override
 */

import { defineApp, DotLifecycleError, DotPipError } from '@arki/dot/pip';
import { defineRelations } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { DB_PIP_ERROR_CODES, db } from './dot.js';

const widgets = pgTable('widgets', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
});

const schema = { widgets };
const relations = defineRelations(schema);

describe('@arki/db/dot', () => {
  it('contributes a db-kind service to the manifest', () => {
    const configured = defineApp('db-manifest-test')
      .use(db({ driver: 'pglite', memory: true, relations }))
      .configure();
    expect(configured.manifest.services).toEqual([
      { name: 'db', pip: 'db', kind: 'db' },
    ]);
    expect(configured.manifest.pips.map(p => p.name)).toEqual(['db']);
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

  it('throws a coded DotPipError when DB_URL is not configured (pg driver)', async () => {
    // The kernel wraps any throw from a boot hook in DotLifecycleError so
    // every boot failure has a uniform outer shape. The original throw is
    // preserved on `.cause` — that's what consumers and coding agents
    // match against for the stable code / remediation / docsUrl.
    const previous = process.env['DB_URL'];
    delete process.env['DB_URL'];
    try {
      const caught = await defineApp('db-missing-url')
        .use(db({ relations }))
        .boot()
        .catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(DotLifecycleError);
      const cause = (caught as DotLifecycleError).cause;
      expect(cause).toBeInstanceOf(DotPipError);
      const pipErr = cause as DotPipError;
      expect(pipErr.code).toBe(DB_PIP_ERROR_CODES.dbUrlNotConfigured);
      expect(pipErr.code).toBe('DB_PIP_E001');
      expect(pipErr.message).toMatch(/DB_URL is not configured/);
      expect(pipErr.remediation).toMatch(/DB_URL|pglite/);
      expect(pipErr.docsUrl).toMatch(/^https?:\/\//);
    } finally {
      if (previous !== undefined) process.env['DB_URL'] = previous;
    }
  });

  it('honors a custom pip name', () => {
    const configured = defineApp('db-named-test')
      .use(
        db({
          driver: 'pglite',
          memory: true,
          relations,
          name: 'primary-db',
        }),
      )
      .configure();
    expect(configured.manifest.pips.map(p => p.name)).toEqual(['primary-db']);
    expect(configured.manifest.services).toEqual([
      { name: 'db', pip: 'primary-db', kind: 'db' },
    ]);
  });
});
