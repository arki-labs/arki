/**
 * Regression: the PGlite driver must honour the `logger` option exactly like
 * the pg driver does. Before the fix `db({ driver: 'pglite', logger })` and
 * `initDbRuntimeLocal(..., { logger })` silently dropped it, so nothing built
 * on the logger (query tracing, the Drop Studio X-ray rail) saw any SQL.
 */
import { defineApp } from '@arki/dot/plugin';
import { defineRelations, sql, type Logger } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { db } from './dot.js';
import { initDbRuntimeLocal } from './runtime-local.js';

const relations = defineRelations({});

function recordingLogger(): { logger: Logger; queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    logger: {
      logQuery(query) {
        queries.push(query);
      },
    },
  };
}

describe('pglite driver + logger', () => {
  it('initDbRuntimeLocal passes a custom logger to drizzle', async () => {
    const { logger, queries } = recordingLogger();
    const { db: handle, pglite } = await initDbRuntimeLocal({ memory: true }, { relations, logger });
    try {
      await handle.execute(sql`select 1 as one`);
      expect(queries).toEqual(['select 1 as one']);
    } finally {
      await pglite.close();
    }
  });

  it('the db DOT plugin passes a custom logger through for the pglite driver', async () => {
    const { logger, queries } = recordingLogger();
    const app = await defineApp('pglite-logger').use(db({ driver: 'pglite', memory: true, relations, logger })).boot();
    try {
      await app.services.db.execute(sql`select 2 as two`);
      expect(queries).toEqual(['select 2 as two']);
    } finally {
      await app.dispose();
    }
  });
});
