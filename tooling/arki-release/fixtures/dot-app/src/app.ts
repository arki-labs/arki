/**
 * External fixture — proves that the DOT kernel + the 3-adapter trio
 * (env, kv, db) boot, expose typed services, and emit a `DotAppManifest`
 * + `DotDiagnosticsSnapshot` from outside the monorepo.
 *
 * This file is consumed by:
 *
 *   - `bun release:arki fixture` — installs `@arki/dot` + `@arki/env` +
 *     `@arki/kv` + `@arki/db` from packed tarballs into a sibling
 *     directory and runs `typecheck` / `test` / `boot` against this app.
 *   - `tests/boot.test.ts` — asserts the shape of `app.manifest` and
 *     `app.diagnostics` programmatically.
 *
 * Driver choices, chosen for hermeticity (no external services required):
 *
 *   - `env`: Zod-validated env vars from `process.env` (with defaults so
 *     boot never depends on the host env).
 *   - `kv`: real Redis URL but kept lazy — the KV constructor does NOT
 *     block on connect. We use a deliberately unreachable URL because
 *     the fixture never calls `kv.get/set` — only the lifecycle hooks
 *     are exercised.
 *   - `db`: PGlite in-memory. No Postgres server required.
 */

import { defineApp } from '@arki/dot';
import { db } from '@arki/db/dot';
import { env } from '@arki/env/dot';
import { kv } from '@arki/kv/dot';
import { defineRelations } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { z } from 'zod';

// Minimal Drizzle schema — the fixture only asserts that the adapter
// publishes a usable handle. The schema content is incidental.
const widgets = pgTable('widgets', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
});

const relations = defineRelations({ widgets });

export const app = await defineApp('arki-dot-fixture')
  .use(
    env({
      schema: {
        FIXTURE_GREETING: z.string().default('hello'),
      },
      skipValidation: true,
    }),
  )
  .use(
    kv({
      url: 'redis://127.0.0.1:1', // unreachable, never queried by the fixture
      namespace: 'arki-dot-fixture',
    }),
  )
  .use(
    db({
      driver: 'pglite',
      memory: true,
      relations,
    }),
  )
  .boot();

// Emit the manifest + diagnostics on stdout so the `bun release:arki
// fixture` matrix can capture them and assert their five-array shape.
console.log(JSON.stringify({ manifest: app.manifest, diagnostics: app.diagnostics }, null, 2));

// Clean up before exit. The kernel disposes in reverse-topological
// order; db.close drains PGlite, kv.close drains Keyv + ioredis.
await app.dispose();
