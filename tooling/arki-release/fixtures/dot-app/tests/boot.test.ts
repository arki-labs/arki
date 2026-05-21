/**
 * Boot test — asserts the shape contract of the external DOT fixture.
 *
 * This file proves that, OUTSIDE the monorepo, the `@arki/dot` kernel
 * paired with the `@arki/env` + `@arki/kv` + `@arki/db` adapters:
 *
 *   - boots through configure -> boot lifecycle without error
 *   - publishes typed services in `app.services`
 *   - emits a `DotAppManifest` with the five contract arrays present
 *     (plugins, routes, services, lifecycle, dependencies) — even when
 *     empty arrays are the correct answer
 *   - emits a `DotDiagnosticsSnapshot` populated with per-plugin entries
 *
 * Task 11.5 will append the `dot new fixture-app` test once the
 * scaffold subcommand lands.
 */

import { defineApp } from '@arki/dot';
import { db } from '@arki/db/dot';
import { env } from '@arki/env/dot';
import { kv } from '@arki/kv/dot';
import { defineRelations } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const widgets = pgTable('widgets', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
});
const relations = defineRelations({ widgets });

async function bootFixture() {
  return defineApp('arki-dot-fixture')
    .use(env({ schema: { FIXTURE_GREETING: z.string().default('hello') }, skipValidation: true }))
    .use(kv({ url: 'redis://127.0.0.1:1', namespace: 'arki-dot-fixture' }))
    .use(db({ driver: 'pglite', memory: true, relations }))
    .boot();
}

describe('DOT fixture boot', () => {
  it('boots and exposes all three services', async () => {
    const app = await bootFixture();
    try {
      expect(app.state).toBe('booted');
      expect(app.services.env.FIXTURE_GREETING).toBe('hello');
      expect(app.services.kv).toBeDefined();
      expect(app.services.db).toBeDefined();
    } finally {
      await app.dispose();
    }
  });

  it('emits a DotAppManifest with all five contract arrays present', async () => {
    const app = await bootFixture();
    try {
      const m = app.manifest;
      expect(m.app.name).toBe('arki-dot-fixture');
      expect(Array.isArray(m.plugins)).toBe(true);
      expect(Array.isArray(m.routes)).toBe(true);
      expect(Array.isArray(m.services)).toBe(true);
      expect(Array.isArray(m.lifecycle)).toBe(true);
      expect(Array.isArray(m.dependencies)).toBe(true);
      expect(m.plugins.map(p => p.name)).toEqual(['env', 'kv', 'db']);
      expect(m.services.map(s => s.kind).sort()).toEqual(['db', 'env', 'kv']);
    } finally {
      await app.dispose();
    }
  });

  it('emits a DotDiagnosticsSnapshot with one entry per plugin', async () => {
    const app = await bootFixture();
    try {
      const d = app.diagnostics;
      expect(d.app).toEqual({ name: 'arki-dot-fixture', state: 'booted' });
      expect(d.plugins).toHaveLength(3);
      expect(d.plugins.every(p => p.status === 'ok')).toBe(true);
      expect(Array.isArray(d.services)).toBe(true);
      expect(Array.isArray(d.routes)).toBe(true);
      expect(Array.isArray(d.lifecycle)).toBe(true);
    } finally {
      await app.dispose();
    }
  });
});
