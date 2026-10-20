/** An embedded PGlite database with an owner lock on its data directory. */
import type { Extension, PGliteOptions } from '@electric-sql/pglite';
import type { AnyRelations, Logger } from 'drizzle-orm';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import { isFailure, orThrow } from '@arki/failure';

import type { LocalRuntimeCloseFailure, LocalRuntimeFailure } from './runtime-local-failures.js';
import { debugInit } from './debug.js';
import { acquireOwnerLock, classifyLocalRuntimeFailure, lockableDataDir } from './owner-lock.js';
import { LocalRuntimeCleanupFailed } from './runtime-local-failures.js';

export { DB_RUNTIME_LOCAL_ERROR_CODES, DbRuntimeLocalError } from './owner-lock.js';
export type { DbRuntimeLocalErrorCode } from './owner-lock.js';
export * from './runtime-local-failures.js';

export type PgliteInitOptions = {
  /** Path to the PGlite data directory. Defaults to `./.local/db`. */
  dataDir?: string;
  /** Use an in-memory database (overrides dataDir). */
  memory?: boolean;
  /** PGlite extensions to load (e.g. `{ vector }` from `@electric-sql/pglite/vector`). */
  extensions?: Record<string, Extension>;
};

/** The foreign close method bridges the owned outcome without changing PGlite's API. */
class LockedPGlite extends PGlite {
  readonly #release: () => Promise<void | LocalRuntimeCloseFailure>;
  #closing: Promise<void | LocalRuntimeCloseFailure> | undefined;

  constructor(dataDir: string, options: PGliteOptions, release: () => Promise<void | LocalRuntimeCloseFailure>) {
    super(dataDir, options);
    this.#release = release;
  }

  override async close(): Promise<void> {
    await orThrow(this.closeOwned());
  }

  closeOwned(): Promise<void | LocalRuntimeCloseFailure> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closing = (async () => {
      try {
        // A failed driver close may leave a live database. Its lock must remain held.
        if (!this.closed) await super.close();
        return await this.#release();
      } catch (error) {
        const failure = classifyLocalRuntimeFailure(error);
        return LocalRuntimeCleanupFailed.is(failure) ? failure : LocalRuntimeCleanupFailed({ cause: error });
      } finally {
        this.#closing = undefined;
      }
    })();
    return this.#closing;
  }

  async cleanupFailedStart(): Promise<void | LocalRuntimeCloseFailure> {
    try {
      if (this.ready || this.closed) return this.closeOwned();
      // A rejected waitReady cannot be closed through PGlite's public API.
      // Extensions may already own resources even before its module exists.
      return LocalRuntimeCleanupFailed({ cause: new Error('PGlite initialization did not confirm a closable state.') });
    } catch (error) {
      return LocalRuntimeCleanupFailed({ cause: error });
    }
  }
}

/**
 * Initialize a PGlite-backed Drizzle database for embedded local development.
 *
 * Returns canonical failures, or the Drizzle handle, raw PGlite and owned close.
 * A file data directory has one owner; a live owner returns DataDirInUse.
 * Dead owners are reclaimed. Memory and browser storage take no owner lock.
 * Owned close returns cleanup failures; raw pglite.close keeps PGlite's throwing API.
 *
 * @example
 * ```ts
 * import { isFailure } from '@arki/failure';
 * import { initDbRuntimeLocal } from '@arki/db/runtime-local';
 * const result = await initDbRuntimeLocal({ dataDir: './.local/db' }, { relations });
 * if (isFailure(result)) return result;
 * const { db, pglite } = result;
 * ```
 */
export async function initDbRuntimeLocal<TRelations extends AnyRelations>(
  options: PgliteInitOptions,
  config: {
    relations: TRelations;
    /** Drizzle logger override — `true`/`false` or a custom `Logger`, same as the pg driver. */
    logger?: boolean | Logger | undefined;
  },
): Promise<
  | {
      db: PgliteDatabase<TRelations>;
      pglite: PGlite;
      close: () => Promise<void | LocalRuntimeCloseFailure>;
    }
  | LocalRuntimeFailure
> {
  let pglite: LockedPGlite | undefined;
  let release: (() => Promise<void | LocalRuntimeCloseFailure>) | undefined;
  try {
    const url = options.memory === true ? 'memory://' : (options.dataDir ?? './.local/db');
    debugInit.debug('[runtime-local] Initializing PGlite at: {url}', { url });
    const pgliteOptions: PGliteOptions = options.extensions ? { extensions: options.extensions } : {};
    const lockDir = lockableDataDir(url);
    if (lockDir !== null) {
      const acquired = await acquireOwnerLock(lockDir);
      if (isFailure(acquired)) return acquired;
      release = acquired;
    }
    pglite = new LockedPGlite(url, pgliteOptions, release ?? (() => Promise.resolve()));
    await pglite.waitReady;
    const db = drizzle<TRelations>({
      client: pglite,
      relations: config.relations,
      ...(config.logger === undefined ? {} : { logger: config.logger }),
    });
    const handle = pglite;
    return { db, pglite, close: () => handle.closeOwned() };
  } catch (error) {
    const failure: LocalRuntimeFailure = classifyLocalRuntimeFailure(error);
    const cleanup = pglite === undefined ? await release?.() : await pglite.cleanupFailedStart();
    if (isFailure(cleanup))
      return LocalRuntimeCleanupFailed({
        cause: new AggregateError([failure, cleanup], 'Local database startup failed and cleanup is unconfirmed.'),
      });
    return failure;
  }
}
