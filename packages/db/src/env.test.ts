/**
 * @arki/db env-resolution tests — DATABASE_URL → DB_URL alias.
 *
 * Closes pass-2 Concern B (2026-05-29): the silent divergence between an
 * app env schema keyed on DATABASE_URL and this package's historical
 * DB_URL schema blocked a production-mode smoke until both env vars were
 * set with the same value.
 *
 * The fix is a runtime alias in `env.ts`: `DB_URL` resolves from EITHER
 * `process.env.DATABASE_URL` (preferred — PG/Coolify/12-factor standard) OR
 * `process.env.DB_URL` (historical @arki/db name). This file tests the
 * resolution layer structurally so future regressions surface immediately.
 *
 * Why `vi.resetModules()` per test: `env.ts` reads `process.env` at module
 * load via `createEnv`. Without a reset, env-core caches the first read and
 * subsequent process.env mutations are invisible.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('@arki/db env — DATABASE_URL → DB_URL resolution (iteration 2 Concern B)', () => {
  const originalDbUrl = process.env['DB_URL'];
  const originalDatabaseUrl = process.env['DATABASE_URL'];

  afterEach(() => {
    if (originalDbUrl !== undefined) process.env['DB_URL'] = originalDbUrl;
    else delete process.env['DB_URL'];
    if (originalDatabaseUrl !== undefined) process.env['DATABASE_URL'] = originalDatabaseUrl;
    else delete process.env['DATABASE_URL'];
    vi.resetModules();
  });

  it('resolves env.DB_URL from DATABASE_URL when DB_URL is not set', async () => {
    process.env['DATABASE_URL'] = 'postgresql://user:pass@localhost:5432/from_database_url';
    delete process.env['DB_URL'];
    vi.resetModules();
    const { env } = await import('./env.js');
    expect(env.DB_URL).toBe('postgresql://user:pass@localhost:5432/from_database_url');
  });

  it('prefers DATABASE_URL over DB_URL when BOTH are set', async () => {
    process.env['DATABASE_URL'] = 'postgresql://user:pass@localhost:5432/preferred';
    process.env['DB_URL'] = 'postgresql://user:pass@localhost:5432/legacy';
    vi.resetModules();
    const { env } = await import('./env.js');
    expect(env.DB_URL).toBe('postgresql://user:pass@localhost:5432/preferred');
  });

  it('falls back to DB_URL when DATABASE_URL is unset (backward compatibility)', async () => {
    delete process.env['DATABASE_URL'];
    process.env['DB_URL'] = 'postgresql://user:pass@localhost:5432/legacy_only';
    vi.resetModules();
    const { env } = await import('./env.js');
    expect(env.DB_URL).toBe('postgresql://user:pass@localhost:5432/legacy_only');
  });
});
