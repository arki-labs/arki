/**
 * `createDb({ url })` must not need `DB_URL`. An app that passes its own URL
 * (the `db({ url })` plugin, `dot dev` pointing at a local database) has no
 * `DB_URL` to give, and reading the pool settings used to validate it anyway.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('createDb', () => {
  const saved = { DB_URL: process.env['DB_URL'], DATABASE_URL: process.env['DATABASE_URL'] };

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
  });

  it('opens a pool from `url` alone when DB_URL and DATABASE_URL are unset', async () => {
    delete process.env['DB_URL'];
    delete process.env['DATABASE_URL'];
    vi.resetModules();
    const { createDb } = await import('./factory.js');

    const url = 'postgres://user:pass@127.0.0.1:1/override';
    const db = createDb({ relations: {}, url });

    expect(db.$client.options.connectionString).toBe(url);
    await db.$client.end();
  });
});
