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

import { defineApp } from '@arki/dot/pip';
import { defineRelations } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { db } from './dot.js';

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
