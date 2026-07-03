import type { AnyRelations } from 'drizzle-orm';
import { PGlite, type Extension } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';

import { debugInit } from './debug.js';

export type PgliteInitOptions = {
  /** Path to the PGlite data directory. Defaults to `./.local/db`. */
  dataDir?: string;
  /** Use an in-memory database (overrides dataDir). */
  memory?: boolean;
  /** PGlite extensions to load (e.g. `{ vector }` from `@electric-sql/pglite/vector`). */
  extensions?: Record<string, Extension>;
};

/**
 * Initialize a PGlite-backed Drizzle database for embedded local development.
 *
 * Returns the raw PGlite instance alongside the Drizzle handle so callers can
 * share it with `@arki/queue/runtime-local` (one process, one PGlite).
 *
 * @example
 * ```ts
 * import { initDbRuntimeLocal } from '@arki/db/runtime-local';
 * const { db, pglite } = await initDbRuntimeLocal({ dataDir: './.local/db' }, { relations });
 * ```
 */
export async function initDbRuntimeLocal<TRelations extends AnyRelations>(
  options: PgliteInitOptions,
  config: { relations: TRelations },
): Promise<{ db: PgliteDatabase<TRelations>; pglite: PGlite }> {
  const url = options.memory === true ? 'memory://' : (options.dataDir ?? './.local/db');
  debugInit('[runtime-local] Initializing PGlite at: %s', url);

  const pglite = options.extensions
    ? new PGlite(url, { extensions: options.extensions })
    : new PGlite(url);
  await pglite.waitReady;
  debugInit('[runtime-local] PGlite ready');

  const db = drizzle({
    client: pglite,
    relations: config.relations,
  }) as PgliteDatabase<TRelations>;

  debugInit('[runtime-local] Drizzle database initialized');
  return { db, pglite };
}
