/** An embedded PGlite database with an owner lock on its data directory. */
import type { Extension, PGliteOptions } from '@electric-sql/pglite';
import type { AnyRelations, Logger } from 'drizzle-orm';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import { debugInit } from './debug.js';
import { acquireOwnerLock, lockableDataDir } from './owner-lock.js';

export { DB_RUNTIME_LOCAL_ERROR_CODES, DbRuntimeLocalError } from './owner-lock.js';
export type { DbRuntimeLocalErrorCode } from './owner-lock.js';

export type PgliteInitOptions = {
  /** Path to the PGlite data directory. Defaults to `./.local/db`. */
  dataDir?: string;
  /** Use an in-memory database (overrides dataDir). */
  memory?: boolean;
  /** PGlite extensions to load (e.g. `{ vector }` from `@electric-sql/pglite/vector`). */
  extensions?: Record<string, Extension>;
};

/** A PGlite handle that gives its data directory's owner lock back once it has closed. */
class LockedPGlite extends PGlite {
  readonly #release: () => Promise<void>;

  constructor(dataDir: string, options: PGliteOptions, release: () => Promise<void>) {
    super(dataDir, options);
    this.#release = release;
  }

  override async close(): Promise<void> {
    await super.close();
    await this.#release();
  }
}

/**
 * Initialize a PGlite-backed Drizzle database for embedded local development.
 *
 * Returns the raw PGlite instance alongside the Drizzle handle so callers can
 * share it with `@arki/queue/runtime-local` (one process, one PGlite).
 *
 * A file `dataDir` gets an owner lock (`<dataDir>/.arki-owner`): a second
 * open while the first handle lives — in another process or in this one —
 * throws `DbRuntimeLocalError` `ARKI_DB_LOCAL_E001` with the owner's pid. A
 * lock left by a process that is gone is taken over. `pglite.close()` gives
 * the lock back. `memory://` and `idb://` databases take no lock.
 *
 * @example
 * ```ts
 * import { initDbRuntimeLocal } from '@arki/db/runtime-local';
 * const { db, pglite } = await initDbRuntimeLocal({ dataDir: './.local/db' }, { relations });
 * ```
 */
export async function initDbRuntimeLocal<TRelations extends AnyRelations>(
  options: PgliteInitOptions,
  config: {
    relations: TRelations;
    /** Drizzle logger override — `true`/`false` or a custom `Logger`, same as the pg driver. */
    logger?: boolean | Logger | undefined;
  },
): Promise<{ db: PgliteDatabase<TRelations>; pglite: PGlite }> {
  const url = options.memory === true ? 'memory://' : (options.dataDir ?? './.local/db');
  debugInit.debug('[runtime-local] Initializing PGlite at: {url}', { url });

  const pgliteOptions: PGliteOptions = options.extensions ? { extensions: options.extensions } : {};
  const lockDir = lockableDataDir(url);
  const release = lockDir === null ? null : await acquireOwnerLock(lockDir);

  let pglite: PGlite | undefined;
  try {
    pglite = release === null ? new PGlite(url, pgliteOptions) : new LockedPGlite(url, pgliteOptions, release);
    await pglite.waitReady;
  } catch (error) {
    // A handle that never got ready still holds the directory: close it and give the lock back.
    try {
      await pglite?.close();
    } catch (closeError) {
      debugInit.debug('[runtime-local] close after a failed start threw', {
        error: closeError instanceof Error ? closeError : String(closeError),
      });
    } finally {
      await release?.();
    }
    throw error;
  }
  debugInit.debug('[runtime-local] PGlite ready');

  const db = drizzle({
    client: pglite,
    relations: config.relations,
    ...(config.logger === undefined ? {} : { logger: config.logger }),
  }) as PgliteDatabase<TRelations>;

  debugInit.debug('[runtime-local] Drizzle database initialized');
  return { db, pglite };
}
