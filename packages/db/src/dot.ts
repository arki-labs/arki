/**
 * DOT adapter for `@arki/db`.
 *
 * Wraps the Drizzle database initialization as a `DotPip`. The pip
 * opens a database connection in `boot`, publishes the Drizzle handle as
 * `services.db`, and tears down the underlying client in `dispose`
 * (reverse-topological order).
 *
 * Two drivers are supported:
 *   - `'pg'` (default) — `node-postgres` pool. Reads `DB_URL` and the
 *     `DB_POOL_*` env vars via `@arki/db`'s built-in env loader.
 *   - `'pglite'` — embedded PGlite. Pass `dataDir`, or `memory: true` for
 *     an in-memory instance. Use for tests, single-binary apps, or local
 *     development without a real Postgres server.
 *
 * @example
 * ```ts
 * import { defineApp } from '@arki/dot';
 * import { db } from '@arki/db/dot';
 * import { defineRelations } from '@arki/db/orm';
 * import { schema } from './schema';
 *
 * const relations = defineRelations(schema, (b) => ({ ... }));
 *
 * // Node-postgres (default), reads DB_URL from env:
 * const app = await defineApp('my-app')
 *   .use(db({ relations }))
 *   .boot();
 *
 * // PGlite in-memory (great for tests):
 * const testApp = await defineApp('test')
 *   .use(db({ driver: 'pglite', memory: true, relations }))
 *   .boot();
 * ```
 *
 * The `@arki/dot` package is an OPTIONAL peer of `@arki/db`. Importing
 * this adapter without `@arki/dot` installed will fail at module load —
 * that is intentional: the adapter only makes sense in a DOT app.
 */

import type { AnyRelations, Logger } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';

import type { DotPip } from '@arki/dot/pip';
import { defineDotPip, DotPipError } from '@arki/dot/pip';

import type { PgliteInitOptions } from './runtime-local.js';
import { env } from './env.js';
import { createDb } from './factory.js';
import { initDbRuntimeLocal } from './runtime-local.js';

/**
 * Stable error codes thrown by the db pip. Exported so consumers and
 * coding agents can match against them — never parse the message.
 *
 * @see packages/dot/docs/principles.md — principle 1.3 ("errors are part
 * of the API") and principle 4 ("agent-discoverable everywhere").
 */
export const DB_PIP_ERROR_CODES = {
  /** boot was called without a configured DB_URL (pg driver). */
  dbUrlNotConfigured: 'DB_PIP_E001',
} as const;

/**
 * Common options shared by all DB driver variants.
 */
type BaseDbDotOptions<TRelations extends AnyRelations> = {
  /** Drizzle 1.0 relations config (build via `defineRelations`). */
  readonly relations: TRelations;
  /** Drizzle logger override — `true`/`false` or a custom `Logger` instance. */
  readonly logger?: boolean | Logger;
  /**
   * Pip name override. Defaults to `'db'`. Use this only when composing
   * multiple database scopes inside the same app (e.g. primary + reporting).
   */
  readonly name?: string;
};

/** Options for the node-postgres driver (the default). */
export type PgDbDotOptions<TRelations extends AnyRelations> = BaseDbDotOptions<TRelations> & {
  /** Driver discriminant. Defaults to `'pg'` when omitted. */
  readonly driver?: 'pg';
};

/** Options for the embedded-PGlite driver. */
export type PgliteDbDotOptions<TRelations extends AnyRelations> = BaseDbDotOptions<TRelations> &
  PgliteInitOptions & {
    /** Driver discriminant. */
    readonly driver: 'pglite';
  };

/** Discriminated union of all supported driver option shapes. */
export type DbDotOptions<TRelations extends AnyRelations> = PgDbDotOptions<TRelations> | PgliteDbDotOptions<TRelations>;

/**
 * Services published by the db adapter. Keyed by the driver — for the
 * default `'pg'` driver, `services.db` is a `NodePgDatabase<TRelations>`;
 * for `'pglite'` it is a `PgliteDatabase<TRelations>`.
 */
export type DbServices<TRelations extends AnyRelations, TDriver extends 'pg' | 'pglite' = 'pg'> = {
  readonly db: TDriver extends 'pglite' ? PgliteDatabase<TRelations> : NodePgDatabase<TRelations>;
};

/**
 * Build a DOT pip that opens a Drizzle database and publishes it as
 * a service. The kernel calls `dispose` in reverse-topological order to
 * close the underlying pool / PGlite instance.
 */
export function db<TRelations extends AnyRelations>(
  options: PgDbDotOptions<TRelations>,
): DotPip<DbServices<TRelations, 'pg'>>;
export function db<TRelations extends AnyRelations>(
  options: PgliteDbDotOptions<TRelations>,
): DotPip<DbServices<TRelations, 'pglite'>>;
export function db<TRelations extends AnyRelations>(
  options: DbDotOptions<TRelations>,
): DotPip<DbServices<TRelations, 'pg' | 'pglite'>> {
  const name = options.name ?? 'db';
  const driver = options.driver ?? 'pg';

  if (driver === 'pglite') {
    const pgliteOptions = options as PgliteDbDotOptions<TRelations>;
    // PGlite path: open the embedded instance and Drizzle handle in boot.
    // We capture the raw PGlite client at boot-time so `dispose` can close
    // it deterministically. `services.db` is the Drizzle handle only —
    // exposing the PGlite client would leak driver-specific surface.
    let pgliteHandle: { close: () => Promise<void> } | undefined;
    return defineDotPip<DbServices<TRelations, 'pglite'>>({
      name,
      version: '0.1.0',
      provides: ['db'],
      configure(ctx) {
        ctx.registerService('db', 'db');
      },
      async boot() {
        const { db: handle, pglite } = await initDbRuntimeLocal<TRelations>(
          {
            ...(pgliteOptions.dataDir === undefined ? {} : { dataDir: pgliteOptions.dataDir }),
            ...(pgliteOptions.memory === undefined ? {} : { memory: pgliteOptions.memory }),
            ...(pgliteOptions.extensions === undefined ? {} : { extensions: pgliteOptions.extensions }),
          },
          { relations: pgliteOptions.relations },
        );
        pgliteHandle = pglite;
        return { services: { db: handle } };
      },
      async dispose() {
        if (pgliteHandle !== undefined) {
          await pgliteHandle.close();
          pgliteHandle = undefined;
        }
      },
    }) as DotPip<DbServices<TRelations, 'pg' | 'pglite'>>;
  }

  // Node-postgres path: createDb already reads env vars and constructs the
  // pool. Drizzle owns the pool — closing it goes via the `$client.end()`
  // path that node-postgres exposes through Drizzle's handle.
  return defineDotPip<DbServices<TRelations, 'pg'>>({
    name,
    version: '0.1.0',
    provides: ['db'],
    configure(ctx) {
      ctx.registerService('db', 'db');
    },
    boot() {
      // Validate at the pip boundary so the DOT lifecycle gets a coded
      // error. `createDb` still throws raw `Error` for non-DOT consumers
      // (its public contract is unchanged); the check here makes sure we
      // never reach it without a URL.
      if (env.DB_URL === undefined || env.DB_URL === '') {
        throw new DotPipError({
          code: DB_PIP_ERROR_CODES.dbUrlNotConfigured,
          message: `[${name}] DB_URL is not configured.`,
          remediation:
            'Set DB_URL in the environment before booting the app, or switch the pip to the pglite driver for in-process databases.',
          docsUrl: 'https://arki.dev/dot/errors/db-pip-e001',
        });
      }
      const handle = createDb<TRelations>({
        relations: options.relations,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });
      return { services: { db: handle } };
    },
    async dispose({ services }) {
      // Drizzle exposes the underlying pg.Pool as `$client`. We call its
      // `end()` to drain in-flight queries and close all sockets.
      const pgHandle = services.db as NodePgDatabase<TRelations> & {
        $client?: { end: () => Promise<void> };
      };
      if (pgHandle.$client !== undefined) {
        await pgHandle.$client.end();
      }
    },
  }) as DotPip<DbServices<TRelations, 'pg' | 'pglite'>>;
}
