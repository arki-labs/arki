/**
 * DOT adapter for `@arki/db`.
 *
 * Wraps the Drizzle database initialization as a DOT plugin. The plugin's
 * `db` factory opens the connection at boot, publishes the Drizzle handle
 * as `services.db`, and tears down the underlying client in `dispose`
 * (reverse declaration order). `database.provides.db` is the typed handle
 * consumers name in their `needs`, known before anything boots.
 *
 * Two drivers are supported:
 *   - `'pg'` (default) — `node-postgres` pool. Pass `url: () => env.DB_URL`
 *     to read the URL at boot (never at import); without it the adapter
 *     reads `DB_URL`. The `DB_POOL_*` env vars come from `@arki/db`'s
 *     built-in env loader.
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
 * // Node-postgres (default); the URL thunk runs at boot:
 * export const database = db({ relations, url: () => env.DB_URL });
 * export type Db = Provided<typeof database.provides.db>;
 *
 * const app = await defineApp('my-app').use(database).boot();
 * // a consumer: needs: { db: database.provides.db }
 *
 * // PGlite in-memory (great for tests):
 * const testApp = await defineApp('test')
 *   .use(db({ driver: 'pglite', memory: true, relations }))
 *   .boot();
 * ```
 *
 * To mount a second database scope (e.g. primary + reporting) in the same
 * app, rename the published wire key at the mount site:
 *
 * ```ts
 * import { rename } from '@arki/dot';
 *
 * const reportsDb = rename(db({ driver: 'pglite', memory: true, relations }), { db: 'reportsDb' }, 'reports-db');
 * .use(database).use(reportsDb)  // consumers name reportsDb.provides.reportsDb
 * ```
 *
 * The `@arki/dot` package is an OPTIONAL peer of `@arki/db`. Importing
 * this adapter without `@arki/dot` installed will fail at module load —
 * that is intentional: the adapter only makes sense in a DOT app.
 */

import type { AnyRelations, Logger } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';

import type { EmptyShape, Plugin, Token } from '@arki/dot/plugin';
import { plugin, service, DotPluginError } from '@arki/dot/plugin';

import type { PgliteInitOptions } from './runtime-local.js';
import type { LockableDb } from './lock.js';
import { env } from './env.js';
import { createDb } from './factory.js';
import { advisoryLocks as createAdvisoryLocks } from './lock.js';
import type { MigratableDb, MigrateDbOptions } from './migrate.js';
import { migrateDb } from './migrate.js';
import { initDbRuntimeLocal } from './runtime-local.js';

/**
 * Stable error codes thrown by the db plugin. Exported so consumers and
 * coding agents can match against them — never parse the message.
 *
 * @see packages/dot/docs/principles.md — principle 1.3 ("errors are part
 * of the API") and principle 4 ("agent-discoverable everywhere").
 */
export const DB_PLUGIN_ERROR_CODES = {
  /** The `db` factory ran without a URL (`url` thunk or DB_URL, pg driver). */
  dbUrlNotConfigured: 'ARKI_DB_PLUGIN_E001',
  /** `repos({ withTx: … })`: `withTx` is the rebinding helper on every repos set, not a repository name. */
  reservedRepoName: 'ARKI_DB_PLUGIN_E002',
  /** `reader(repo, ['x'])` named something that is not a method of the repository. */
  readerNotAMethod: 'ARKI_DB_PLUGIN_E003',
} as const;

/**
 * Common options shared by all DB driver variants.
 */
type BaseDbDotOptions<TRelations extends AnyRelations> = {
  /** Drizzle 1.0 relations config (build via `defineRelations`). */
  readonly relations: TRelations;
  /** Drizzle logger override — `true`/`false` or a custom `Logger` instance. */
  readonly logger?: boolean | Logger;
};

/** Options for the node-postgres driver (the default). */
export type PgDbDotOptions<TRelations extends AnyRelations> = BaseDbDotOptions<TRelations> & {
  /** Driver discriminant. Defaults to `'pg'` when omitted. */
  readonly driver?: 'pg';
  /**
   * The connection URL, read when the app boots (never at import). Falls
   * back to `DB_URL` from the environment when absent or `undefined`.
   */
  readonly url?: () => string | undefined;
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
 * Build a DOT plugin that opens a Drizzle database and publishes it as
 * a service. The kernel calls `dispose` in reverse declaration order to
 * close the underlying pool / PGlite instance.
 */
export function db<TRelations extends AnyRelations>(
  options: PgDbDotOptions<TRelations>,
): Plugin<EmptyShape, DbServices<TRelations, 'pg'>>;
export function db<TRelations extends AnyRelations>(
  options: PgliteDbDotOptions<TRelations>,
): Plugin<EmptyShape, DbServices<TRelations, 'pglite'>>;
export function db<TRelations extends AnyRelations>(
  options: DbDotOptions<TRelations>,
): Plugin<EmptyShape, DbServices<TRelations, 'pg' | 'pglite'>> {
  const driver = options.driver ?? 'pg';

  if (driver === 'pglite') {
    const pgliteOptions = options as PgliteDbDotOptions<TRelations>;
    // PGlite path: open the embedded instance and Drizzle handle at boot.
    // We capture the raw PGlite client in the factory so `dispose` can close
    // it deterministically. `services.db` is the Drizzle handle only —
    // exposing the PGlite client would leak driver-specific surface.
    let pgliteHandle: { close: () => Promise<void> } | undefined;
    return plugin({
      name: 'db',
      version: '0.1.0',
      configure(ctx) {
        ctx.registerService('db', 'db');
      },
      provides: {
        db: async (): Promise<DbServices<TRelations, 'pglite'>['db']> => {
          const { db: handle, pglite } = await initDbRuntimeLocal<TRelations>(
            {
              ...(pgliteOptions.dataDir === undefined ? {} : { dataDir: pgliteOptions.dataDir }),
              ...(pgliteOptions.memory === undefined ? {} : { memory: pgliteOptions.memory }),
              ...(pgliteOptions.extensions === undefined ? {} : { extensions: pgliteOptions.extensions }),
            },
            {
              relations: pgliteOptions.relations,
              ...(pgliteOptions.logger === undefined ? {} : { logger: pgliteOptions.logger }),
            },
          );
          pgliteHandle = pglite;
          return handle;
        },
      },
      async dispose() {
        if (pgliteHandle !== undefined) {
          await pgliteHandle.close();
          pgliteHandle = undefined;
        }
      },
    }) as Plugin<EmptyShape, DbServices<TRelations, 'pg' | 'pglite'>>;
  }

  // Node-postgres path: createDb already reads env vars and constructs the
  // pool. Drizzle owns the pool — closing it goes via the `$client.end()`
  // path that node-postgres exposes through Drizzle's handle.
  return plugin({
    name: 'db',
    version: '0.1.0',
    configure(ctx) {
      ctx.registerService('db', 'db');
    },
    provides: {
      db: (): DbServices<TRelations, 'pg'>['db'] => {
        // Validate at the plugin boundary so the DOT lifecycle gets a coded
        // error. `createDb` still throws raw `Error` for non-DOT consumers
        // (its public contract is unchanged); the check here makes sure we
        // never reach it without a URL.
        const url = ('url' in options ? options.url?.() : undefined) ?? env.DB_URL;
        if (url === undefined || url === '') {
          throw new DotPluginError({
            code: DB_PLUGIN_ERROR_CODES.dbUrlNotConfigured,
            message: '[db] DB_URL is not configured.',
            remediation:
              'Pass url: () => env.DB_URL to db(...) or set DB_URL in the environment before booting the app, or switch the plugin to the pglite driver for in-process databases.',
            docsUrl: 'https://arki.dev/dot/errors/arki-db-plugin-e001',
          });
        }
        return createDb<TRelations>({
          relations: options.relations,
          url,
          ...(options.logger === undefined ? {} : { logger: options.logger }),
        });
      },
    },
    async dispose({ db: handle }) {
      // Drizzle exposes the underlying pg.Pool as `$client`. We call its
      // `end()` to drain in-flight queries and close all sockets.
      const pgHandle = handle as NodePgDatabase<TRelations> & {
        $client?: { end: () => Promise<void> };
      };
      if (pgHandle.$client !== undefined) {
        await pgHandle.$client.end();
      }
    },
  }) as Plugin<EmptyShape, DbServices<TRelations, 'pg' | 'pglite'>>;
}

/**
 * DOT plugin: migrate during `boot`, after the `db` plugin and before any
 * plugin that reads tables. Needs the `db` service; provides nothing.
 */
export function dbMigrations<TRelations extends AnyRelations = AnyRelations>(
  options: MigrateDbOptions,
): Plugin<{ readonly db: MigratableDb<TRelations> }, Record<never, never>> {
  return plugin({
    name: 'db-migrations',
    version: '0.1.0',
    needs: { db: service<MigratableDb<TRelations>>() },
    async boot({ db }) {
      await migrateDb(db, options);
    },
  });
}

/* ------------------------------------------------------------------ */
/* repos() — a feature's repositories as one private infra plugin      */
/* ------------------------------------------------------------------ */

/** Repository factories by name: `{ highlights: createHighlightRepository }`, each `(database) => repository`. */
export type RepoFactories = Readonly<Record<string, (database: never) => object>>;

/**
 * The database type the factories take, read from their own parameter
 * (Avocabo: `Db | Transaction`). Written once — in the factories.
 */
export type DatabaseOf<F extends RepoFactories> = Parameters<F[keyof F]>[0];

/** One repository per factory, all bound to the same database or transaction. */
export type RepoSet<F extends RepoFactories> = { readonly [K in keyof F]: ReturnType<F[K]> };

/**
 * The `repos` service: the repositories bound to the app's database, plus
 * `withTx(tx)` for the same set bound to a transaction.
 */
export type Repos<F extends RepoFactories> = RepoSet<F> & {
  /**
   * The same repositories bound to `tx`. Every call builds a fresh set
   * (one small object per repository), so call it once per transaction and
   * keep the result — not once per query. For a nested transaction, call it
   * again on this `repos` with the inner `tx`; the set it returns has no
   * `withTx` of its own.
   */
  withTx(tx: DatabaseOf<F>): RepoSet<F>;
};

/** Every factory must accept the one shared database type: a stricter factory fails at `repos()`. */
type SameDatabase<F extends RepoFactories> = { readonly [K in keyof F]: (database: DatabaseOf<F>) => object };

/** `withTx` belongs to the set; a repository with that name would be silently replaced by it. */
type NoWithTx = { readonly withTx?: never };

function bindAll<F extends RepoFactories>(factories: F, database: DatabaseOf<F>): RepoSet<F> {
  const out: Record<string, object> = {};
  // SameDatabase<F> proved at `repos()` that each factory takes `DatabaseOf<F>`.
  for (const [key, make] of Object.entries(factories)) out[key] = make(database);
  // Erasure seam: built key by key at runtime; typed by the factories' own return types.
  return out as RepoSet<F>;
}

/**
 * A feature's repositories as one infra plugin: built once at boot, bound to
 * the database the handle names, published as `repos`. In the feature chain
 * it becomes private (`highlights.repos`), and `dot explain` draws
 * `highlights → highlights/repos → database`.
 *
 * - The database is explicit: pass the handle (`database.provides.db`, or a
 *   second database's handle). Its type must be one the factories accept —
 *   a compile error otherwise. Nothing is chosen by name behind your back.
 * - `withTx` is reserved (compile error and `ARKI_DB_PLUGIN_E002`).
 * - Tests replace the whole set: `feature.override({ repos })` takes a full
 *   `Repos<F>`. See the README for fakes that type-check.
 *
 * @example
 * ```ts
 * // features/highlights/infra/repository.ts
 * export const repository = repos(database.provides.db, {
 *   highlights: (db: Database) => new HighlightRepository(db),
 *   collections: createCollectionRepository,
 * });
 * // feature.ts
 * defineFeature('highlights').infra(repository).usecases({
 *   list: ({ repos }: Deps) => (itemId: ItemId) => repos.highlights.listByItem(itemId),
 * });
 * ```
 */
export function repos<K extends string, const F extends RepoFactories>(
  database: Token<NoInfer<DatabaseOf<F>>, K>,
  factories: F & SameDatabase<F> & NoWithTx,
) {
  if (Object.hasOwn(factories, 'withTx')) {
    throw new DotPluginError({
      code: DB_PLUGIN_ERROR_CODES.reservedRepoName,
      message: '[repos] "withTx" is reserved: every repos set uses it to rebind to a transaction.',
      remediation: 'Rename the repository (for example "transactions" or "txLog").',
      docsUrl: 'https://arki.dev/dot/errors/arki-db-plugin-e002',
    });
  }
  return plugin({
    name: 'repos',
    // The handle is the need: the kernel orders this plugin after the database
    // that publishes it, and the app builder checks its type.
    needs: { db: database },
    provides: {
      repos: ({ db }): Repos<F> => ({ ...bindAll(factories, db), withTx: (tx: DatabaseOf<F>) => bindAll(factories, tx) }),
    },
  });
}

/** The keys of `R` whose values are functions. */
type MethodKeys<R> = { [K in keyof R]: R[K] extends (...args: never[]) => unknown ? K : never }[keyof R];

/**
 * Some methods of a repository, bound to it: what a feature hands other
 * features instead of the whole repository (reads, not writes).
 *
 * Why bound: `{ get: repos.stories.get }` copies a class method off its
 * object, and the first `this.db` inside it throws. `reader()` binds each one.
 *
 * @example
 * ```ts
 * .provides({ storyReader: ({ repos }) => reader(repos.stories, ['get', 'listByUser']) })
 * ```
 */
export function reader<R extends object, const M extends readonly MethodKeys<R>[]>(
  repository: R,
  methods: M,
): Pick<R, M[number]> {
  const out: Record<PropertyKey, unknown> = {};
  for (const name of methods) {
    const method: unknown = repository[name];
    if (typeof method !== 'function') {
      throw new DotPluginError({
        code: DB_PLUGIN_ERROR_CODES.readerNotAMethod,
        message: `[repos] reader(): "${String(name)}" is not a method of the repository.`,
        remediation: 'List only method names; publish plain values through provides() directly.',
        docsUrl: 'https://arki.dev/dot/errors/arki-db-plugin-e003',
      });
    }
    out[name] = method.bind(repository);
  }
  // Erasure seam: built name by name above; each value is the repository's own method, bound.
  return out as Pick<R, M[number]>;
}

/* ------------------------------------------------------------------ */
/* advisoryLocks() — PostgreSQL advisory locks as a service             */
/* ------------------------------------------------------------------ */

/**
 * PostgreSQL advisory locks on the database the handle names, published as
 * `locks`. `schedules(core, [{ …, lock: true }])` from `@arki/schedule/dot`
 * uses it to keep a job to one replica at a time, for as long as the job runs.
 *
 * @example
 * ```ts
 * defineFeature('clustering')
 *   .infra(advisoryLocks(database.provides.db, { namespace: 'avocabo' }))
 *   .usecases({ assign })
 *   .entrypoints(schedules(core, [{ name: 'cluster-assign', cron: '*\/5 * * * *', lock: true, handler }]));
 * ```
 */
export function advisoryLocks<K extends string>(
  database: Token<LockableDb, K>,
  options: { readonly namespace: string },
) {
  return plugin({
    name: 'locks',
    needs: { db: database },
    provides: { locks: ({ db }) => createAdvisoryLocks(db, options) },
  });
}
