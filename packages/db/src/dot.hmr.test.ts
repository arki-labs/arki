/**
 * The plan's Milestone 2 demo: a server file edited 20 times fast under Vite
 * leaves one app and one PGlite handle. Vite does not wait for
 * `hot.dispose`, so without `createAppRuntime` the next request starts a new
 * app while the old one still holds the data directory — the owner lock
 * then throws `ARKI_DB_LOCAL_E001`. The hot updates are replayed the way
 * Vite runs them: `dispose(data)` on the old module, then a new module with
 * the same `hot.data`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { defineApp } from '@arki/dot';
import { createAppRuntime } from '@arki/dot/runtime';

import { db } from './dot.js';

/** A fake `import.meta.hot` per module instance; `replace()` is the hot update. */
function hotModule(data: Record<string, unknown>) {
  let onDispose: ((data: Record<string, unknown>) => void) | undefined;
  return {
    hot: {
      data,
      dispose(callback: (data: Record<string, unknown>) => void) {
        onDispose = callback;
      },
    },
    replace() {
      onDispose?.(data);
    },
  };
}

/** How a request to one module instance ended: the app, refused as replaced, or another error. */
const settle = (promise: Promise<unknown>) =>
  promise.then(
    () => 'started',
    (error: unknown) =>
      error instanceof Error && error.message.includes('replaced by a hot update') ? 'replaced' : String(error),
  );

describe('db({ driver: "pglite" }) under hot updates', () => {
  it('20 fast edits: one app at a time, one handle on the data directory', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'arki-db-hmr-'));
    try {
      const app = defineApp('hmr').use(db({ driver: 'pglite', dataDir, relations: {} }));
      const data: Record<string, unknown> = {};
      const requests: Promise<string>[] = [];

      let module = hotModule(data);
      for (let edit = 0; edit < 20; edit += 1) {
        // A request reaches the module, then the next edit lands before the app is up.
        requests.push(settle(createAppRuntime(app, { hot: module.hot }).get()));
        module.replace();
        module = hotModule(data);
      }
      const current = await createAppRuntime(app, { hot: module.hot }).get();

      // Requests to replaced modules were refused; none started a second app or hit the owner lock.
      expect(await Promise.all(requests)).toEqual(Array.from({ length: 20 }, () => 'replaced'));
      const rows = await current.services.db.execute(sql`select 1 as one`);
      expect(rows.rows).toEqual([{ one: 1 }]);
      await current.dispose();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
