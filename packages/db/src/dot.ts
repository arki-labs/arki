/**
 * DOT adapter for `@arki/db`.
 *
 * Wraps the Drizzle database initialization as a DOT plugin. The plugin's
 * `db` factory opens the connection at boot, publishes the Drizzle handle
 * as `services.db`, and tears down the underlying client in `dispose`
 * (reverse declaration order). `database.provides.db` is the typed handle
 * consumers name in their `needs`, known before anything boots.
 *
 * Three drivers are supported:
 *   - `'pg'` (default) — `node-postgres` pool. Pass `url: () => env.DB_URL`
 *     to read the URL at boot (never at import); without it the adapter
 *     reads `DB_URL`. The `DB_POOL_*` env vars come from `@arki/db`'s
 *     built-in env loader.
 *   - `'pglite'` — embedded PGlite. Pass `dataDir`, or `memory: true` for
 *     an in-memory instance. Use for tests, single-binary apps, or local
 *     development without a real Postgres server.
 *   - `'libsql'` — SQLite through libSQL: a `file:` path, `:memory:`, or a
 *     Turso / libSQL server. Pass `url: () => env.DB_URL` (or set `DB_URL`)
 *     and, for a server, `authToken`. `@libsql/client` is an optional peer,
 *     loaded only by this driver.
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
 * const app = await defineApp('my-app').infra(database).boot();
 * // a consumer: needs: { db: database.provides.db }
 *
 * // PGlite in-memory (great for tests):
 * const testApp = await defineApp('test')
 *   .infra(db({ driver: 'pglite', memory: true, relations }))
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
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import pg from 'pg';

import type { Handle } from '@arki/dot/unit';
import type { SuccessOf } from '@arki/failure';
import { DotUnitError, infra, service } from '@arki/dot/unit';
import { isFailure } from '@arki/failure';

import type { SessionNeedsDirectUrl } from './hosts.js';
import type { MigratableDb, MigrateDbOptions } from './migrate.js';
import type { ListenPool } from './pg-listen.js';
import type { PgliteInitOptions } from './runtime-local.js';
import type { TransactionFailure } from './transaction.js';
import { env } from './env.js';
import { createDb } from './factory.js';
import { resolveDirectUrl } from './hosts.js';
import { migrateDb, pendingMigrations } from './migrate.js';
import { runTransactionOnce } from './owned-transaction.js';
import { initDbRuntimeLocal } from './runtime-local.js';

/**
 * Stable error codes thrown by the db plugin. Exported so consumers and
 * coding agents can match against them — never parse the message.
 *
 * @see packages/dot/docs/principles.md — principle 1.3 ("errors are part
 * of the API") and principle 4 ("agent-discoverable everywhere").
 */
export const DB_PLUGIN_ERROR_CODES = {
  /**
   * The `db` factory ran without a database URL: no `url` thunk and no `DB_URL`.
   *
   * @fix Set `DB_URL`, or pass a `url` thunk to `db()`.
   * @verify bun run test -- src/dot.test.ts
   */
  dbUrlNotConfigured: 'ARKI_DB_PLUGIN_E001',
  /**
   * `repos({ withTx })` used `withTx` as a repository name. `withTx` is the helper that rebinds every repos set.
   *
   * @fix Rename the repository.
   * @verify bun run test -- src/repos.test.ts
   */
  reservedRepoName: 'ARKI_DB_PLUGIN_E002',
  /**
   * `reader(repo, [name])` named something that is not a method of the repository.
   *
   * @fix List only method names of the repository.
   * @verify bun run test -- src/repos.test.ts
   */
  readerNotAMethod: 'ARKI_DB_PLUGIN_E003',
  /**
   * `sessionPool.connect()` ran while `DB_URL` is a known transaction pooler and no direct URL is set.
   * Through the pooler, LISTEN hears nothing and a session lock outlives its owner.
   *
   * @fix Set `DB_DIRECT_URL`, or pass a `directUrl` thunk to `db()`.
   * @verify bun run test -- src/dot.test.ts
   */
  sessionOnPooledUrl: 'ARKI_DB_PLUGIN_E004',
  /**
   * The database URL does not fit the driver: a `postgres:` URL with `driver: 'libsql'`, or a SQLite URL
   * (`file:`, `libsql:`, `:memory:`) with the pg driver. The wrong driver would fail later, with a less clear error.
   *
   * @fix Set `driver` to match the URL, or fix the URL.
   * @verify bun run test -- src/dot.test.ts
   */
  driverUrlMismatch: 'ARKI_DB_PLUGIN_E005',
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
  /**
   * The direct (non-pooled) URL that `sessionPool` connects to, read at boot.
   * Falls back to `DB_DIRECT_URL`, then to `url` when `url` is not a known pooler.
   */
  readonly directUrl?: () => string | undefined;
};

/** Options for the embedded-PGlite driver. */
export type PgliteDbDotOptions<TRelations extends AnyRelations> = BaseDbDotOptions<TRelations> &
  PgliteInitOptions & {
    /** Driver discriminant. */
    readonly driver: 'pglite';
  };

/** Options for the libSQL driver: SQLite in a file, in memory, or on a libSQL server. */
export type LibsqlDbDotOptions<TRelations extends AnyRelations> = BaseDbDotOptions<TRelations> & {
  /** Driver discriminant. */
  readonly driver: 'libsql';
  /**
   * `file:path.db`, `:memory:`, or a `libsql:` / `http(s):` / `ws(s):` server URL,
   * read when the app boots. Falls back to `DB_URL` when absent or `undefined`.
   */
  readonly url?: () => string | undefined;
  /** The server's auth token (Turso), read at boot. Not used for local files. */
  readonly authToken?: () => string | undefined;
};

/** Discriminated union of all supported driver option shapes. */
export type DbDotOptions<TRelations extends AnyRelations> =
  | PgDbDotOptions<TRelations>
  | PgliteDbDotOptions<TRelations>
  | LibsqlDbDotOptions<TRelations>;

/**
 * A small pool on the direct URL, for work that must keep one session: LISTEN
 * (`listenOnPool`), session locks (a lock lease's `listen`), migrations. It is
 * separate from the query pool, so held listeners never take query connections.
 */
export type SessionPool = ListenPool & { end(): Promise<void> };

/**
 * Services published by the db adapter. Keyed by the driver — for the
 * default `'pg'` driver, `services.db` is a `NodePgDatabase<TRelations>`
 * and `services.sessionPool` a {@link SessionPool}; for `'pglite'`, `db` is a
 * `PgliteDatabase<TRelations>` (PGlite listens through `client.listen`); for
 * `'libsql'`, `db` is a `LibSQLDatabase<TRelations>` (SQLite has no LISTEN).
 */
export type DbServices<
  TRelations extends AnyRelations,
  TDriver extends 'pg' | 'pglite' | 'libsql' = 'pg',
> = TDriver extends 'pglite'
  ? { readonly db: PgliteDatabase<TRelations> }
  : TDriver extends 'libsql'
    ? { readonly db: LibSQLDatabase<TRelations> }
    : { readonly db: NodePgDatabase<TRelations>; readonly sessionPool: SessionPool };

/** Listeners and lock waiters hold their connection for as long as they run; four covers both with room to spare. */
const SESSION_POOL_MAX = 4;

/**
 * Build a DOT plugin that opens a Drizzle database and publishes it as
 * a service. The kernel calls `dispose` in reverse declaration order to
 * close the underlying pool / PGlite instance.
 */
export function db<TRelations extends AnyRelations>(
  options: PgDbDotOptions<TRelations>,
): ReturnType<typeof createPgPlugin<TRelations>>;
export function db<TRelations extends AnyRelations>(
  options: PgliteDbDotOptions<TRelations>,
): ReturnType<typeof createPglitePlugin<TRelations>>;
export function db<TRelations extends AnyRelations>(
  options: LibsqlDbDotOptions<TRelations>,
): ReturnType<typeof createLibsqlPlugin<TRelations>>;
export function db<TRelations extends AnyRelations>(options: DbDotOptions<TRelations>) {
  if (options.driver === 'pglite') return createPglitePlugin(options);
  if (options.driver === 'libsql') return createLibsqlPlugin(options);
  return createPgPlugin(options);
}

function createPglitePlugin<TRelations extends AnyRelations>(options: PgliteDbDotOptions<TRelations>) {
  // PGlite path: open the embedded instance and Drizzle handle at boot.
  // We capture the raw PGlite client in the factory so `dispose` can close
  // it deterministically. `services.db` is the Drizzle handle only —
  // exposing the PGlite client would leak driver-specific surface.
  let close: SuccessOf<typeof initDbRuntimeLocal<TRelations>>['close'] | undefined;
  return infra({
    name: 'db',
    configure(ctx): undefined {
      ctx.registerService('db', 'db');
    },
    provides: {
      db: async () => {
        const local = await initDbRuntimeLocal<TRelations>(
          {
            ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
            ...(options.memory === undefined ? {} : { memory: options.memory }),
            ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
          },
          {
            relations: options.relations,
            ...(options.logger === undefined ? {} : { logger: options.logger }),
          },
        );
        if (isFailure(local)) return local;
        close = local.close;
        return local.db;
      },
    },
    async dispose() {
      if (close !== undefined) {
        const outcome = await close();
        if (isFailure(outcome)) return outcome;
        close = undefined;
      }
      return;
    },
  });
}

function createPgPlugin<TRelations extends AnyRelations>(options: PgDbDotOptions<TRelations>) {
  // Node-postgres path: createDb already reads env vars and constructs the
  // pool. Drizzle owns the pool — closing it goes via the `$client.end()`
  // path that node-postgres exposes through Drizzle's handle.
  return infra({
    name: 'db',
    configure(ctx) {
      ctx.registerService('db', 'db');
      ctx.registerService('sessionPool', 'db');
    },
    provides: {
      db: (): DbServices<TRelations, 'pg'>['db'] =>
        createDb<TRelations>({
          relations: options.relations,
          url: readUrl('pg', options.url),
          ...(options.logger === undefined ? {} : { logger: options.logger }),
        }),
      sessionPool: (): SessionPool => {
        // Never throws for a pooled URL: an app that uses no session feature must still boot.
        const direct = resolveDirectUrl({ url: readUrl('pg', options.url), directUrl: options.directUrl?.() ?? env.DB_DIRECT_URL });
        if (isFailure(direct)) return refusingPool(direct);
        return new pg.Pool({ connectionString: direct, max: SESSION_POOL_MAX });
      },
    },
    async dispose({ db: handle, sessionPool }) {
      // Drizzle exposes the underlying pg.Pool as `$client`. We call its
      // `end()` to drain in-flight queries and close all sockets.
      const pgHandle = handle as NodePgDatabase<TRelations> & {
        $client?: { end: () => Promise<void> };
      };
      if (pgHandle.$client !== undefined) {
        await pgHandle.$client.end();
      }
      await sessionPool.end();
    },
  });
}

function createLibsqlPlugin<TRelations extends AnyRelations>(options: LibsqlDbDotOptions<TRelations>) {
  // libSQL path: `@libsql/client` is an optional peer, so it loads only here.
  let close: (() => void) | undefined;
  return infra({
    name: 'db',
    configure(ctx): undefined {
      ctx.registerService('db', 'db');
    },
    provides: {
      db: async (): Promise<DbServices<TRelations, 'libsql'>['db']> => {
        const url = readUrl('libsql', options.url);
        const { createLibsqlDb } = await import('./libsql.js');
        const opened = createLibsqlDb<TRelations>({
          url,
          authToken: options.authToken?.(),
          relations: options.relations,
          ...(options.logger === undefined ? {} : { logger: options.logger }),
        });
        close = opened.close;
        return opened.db;
      },
    },
    dispose() {
      close?.();
      close = undefined;
    },
  });
}

/** URL schemes that belong to the other driver: the realistic mix-ups, not every invalid URL. */
const FOREIGN_SCHEMES = {
  pg: ['file:', 'libsql:', ':memory:'],
  libsql: ['postgres:', 'postgresql:'],
} as const;

/**
 * The URL from the `url` thunk, else `DB_URL`. Validated at the plugin boundary
 * so the DOT lifecycle gets a coded error. `createDb` still throws raw `Error`
 * for non-DOT consumers (its public contract is unchanged).
 */
function readUrl(driver: keyof typeof FOREIGN_SCHEMES, url: (() => string | undefined) | undefined): string {
  const value = url?.() ?? env.DB_URL;
  if (value === undefined || value === '') {
    throw new DotUnitError({
      code: DB_PLUGIN_ERROR_CODES.dbUrlNotConfigured,
      message: '[db] DB_URL is not configured.',
      remediation:
        'Pass url: () => env.DB_URL to db(...) or set DB_URL in the environment before booting the app, or switch the plugin to the pglite driver for in-process databases.',
      docsUrl: 'https://arki.dev/dot/errors/arki-db-plugin-e001',
    });
  }
  const scheme = FOREIGN_SCHEMES[driver].find(foreign => value.toLowerCase().startsWith(foreign));
  if (scheme !== undefined) {
    throw new DotUnitError({
      code: DB_PLUGIN_ERROR_CODES.driverUrlMismatch,
      message: `[db] the ${driver} driver was given a ${scheme} URL.`,
      remediation:
        driver === 'pg'
          ? "A SQLite URL needs db({ driver: 'libsql' }). For Postgres, give a postgres:// URL."
          : "A Postgres URL needs the pg driver (omit driver). For SQLite, give a file:, :memory: or libsql:// URL.",
      docsUrl: 'https://arki.dev/dot/errors/arki-db-plugin-e005',
    });
  }
  return value;
}

/** A `sessionPool` stand-in whose every `connect()` rejects with the coded refusal. */
function refusingPool(refusal: ReturnType<typeof SessionNeedsDirectUrl>): SessionPool {
  return {
    connect: () =>
      Promise.reject(
        new DotUnitError({
          code: DB_PLUGIN_ERROR_CODES.sessionOnPooledUrl,
          message: `[db] ${refusal.message}`,
          remediation: `Set DB_DIRECT_URL, or pass directUrl: () => env.DB_DIRECT_URL to db(...). ${refusal.data.hint}`,
          docsUrl: 'https://arki.dev/dot/errors/arki-db-plugin-e004',
        }),
      ),
    end: () => Promise.resolve(),
  };
}

/**
 * DOT plugin: migrate during `boot`, after the `db` plugin and before any
 * plugin that reads tables. Needs the `db` service.
 *
 * Provides `migrations`: `{ pending }`, the names this boot found pending and
 * then applied, in order (empty when the database was up to date). `dot dev`
 * reads it from its preflight boot to print what it applied.
 */
export function dbMigrations<TRelations extends AnyRelations = AnyRelations>(options: MigrateDbOptions) {
  return infra({
    name: 'db-migrations',
    needs: { db: service<MigratableDb<TRelations>>() },
    provides: {
      // Factories run before `boot`, so this reads the database before any migration is applied.
      migrations: async ({ db }) => {
        const pending = await pendingMigrations(db, options);
        if (isFailure(pending)) return pending;
        return { pending: Object.freeze(pending) } as const;
      },
    },
    async boot({ db }) {
      return migrateDb(db, options);
    },
  });
}

/* ------------------------------------------------------------------ */
/* repos() — a feature's repositories as one private infra unit      */
/* ------------------------------------------------------------------ */

/** Repository factories by name: `{ highlights: createHighlightRepository }`, each `(database) => repository`. */
export type RepoFactories = Readonly<Record<string, (database: never) => object>>;

/**
 * The database type the factories take, read from their own parameter
 * (for example `Db | Transaction`). Written once — in the factories.
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
 * The `repos` service of a transaction-owning scope: `withTx(tx)` only. There
 * is no database-bound set to call by mistake, so every query runs inside a
 * transaction an entrypoint opened. See `txRepos()`.
 */
export type TxRepos<F extends RepoFactories> = { withTx(tx: DatabaseOf<F>): RepoSet<F> };

function refuseReservedRepoName(factories: RepoFactories): void {
  if (Object.hasOwn(factories, 'withTx')) {
    throw new DotUnitError({
      code: DB_PLUGIN_ERROR_CODES.reservedRepoName,
      message: '[repos] "withTx" is reserved: every repos set uses it to rebind to a transaction.',
      remediation: 'Rename the repository (for example "transactions" or "txLog").',
      docsUrl: 'https://arki.dev/dot/errors/arki-db-plugin-e002',
    });
  }
}

/**
 * A feature's repositories as one infra unit: built once at boot, bound to
 * the feature's `db`, published as `repos`. In the feature chain it becomes
 * private (`highlights.repos`), and `dot explain` draws
 * `highlights → highlights/repos → database`.
 *
 * - The plugin needs `db` unbound (`DatabaseOf<F>`, read off the factories).
 *   The feature declares which database that is: `.needs({ db: database.provides.db })`
 *   (or a second database's handle, `.needs({ db: reports.provides.reportsDb })`).
 *   A feature that declares no `db`, or one of another type, fails at `.infra()`.
 *   Nothing is chosen by name behind your back.
 * - `withTx` is reserved (compile error and `ARKI_DB_PLUGIN_E002`).
 * - Tests replace the whole set: `feature.override({ repos })` takes a full
 *   `Repos<F>`. See the README for fakes that type-check.
 *
 * @example
 * ```ts
 * // features/highlights/infra/repository.ts
 * export const repository = repos({
 *   highlights: (db: Database) => new HighlightRepository(db),
 *   collections: createCollectionRepository,
 * });
 * // feature.ts
 * defineFeature('highlights')
 *   .needs({ db: entrypointOnly(database.provides.db) })
 *   .infra(repository)
 *   .usecases({ list: ({ repos }: Deps) => (itemId: ItemId) => repos.highlights.listByItem(itemId) });
 * ```
 */
export function repos<const F extends RepoFactories>(factories: F & SameDatabase<F> & NoWithTx) {
  refuseReservedRepoName(factories);
  return infra({
    name: 'repos',
    // Unbound: the feature binds `db` to its own handle at `.infra()`, and the
    // kernel orders this plugin after the database that publishes it.
    needs: { db: service<DatabaseOf<F>>() },
    provides: {
      repos: ({ db }): Repos<F> => ({
        ...bindAll(factories, db),
        withTx: (tx: DatabaseOf<F>) => bindAll(factories, tx),
      }),
    },
  });
}

/**
 * `repos()` for a scope that owns its transactions: the published `repos`
 * has `withTx(tx)` and nothing else. Pair it with
 * `.needs({ db: entrypointOnly(database.provides.db) })`: entrypoints open the
 * transaction, usecases take `tx`, and no usecase can reach a database-bound
 * repository — `repos.highlights` is a compile error.
 *
 * @example
 * ```ts
 * export const store = txRepos({ digests: (tx: Transaction) => new DigestRepository(tx) });
 * // usecases/run.ts
 * const run = ({ repos }: Deps) => (tx: Transaction, id: DigestId) => repos.withTx(tx).digests.get(id);
 * ```
 */
export function txRepos<const F extends RepoFactories>(factories: F & SameDatabase<F> & NoWithTx) {
  refuseReservedRepoName(factories);
  return infra({
    name: 'repos',
    needs: { db: service<DatabaseOf<F>>() },
    provides: {
      repos: (): TxRepos<F> => ({ withTx: (tx: DatabaseOf<F>) => bindAll(factories, tx) }),
    },
  });
}

/* ------------------------------------------------------------------ */
/* transactions() — open a transaction, and nothing else               */
/* ------------------------------------------------------------------ */

/** Anything with Drizzle's `transaction(fn)` handing `fn` a `Tx`: the database handle, or a transaction (then `fn` runs in a savepoint). */
export type Transactable<Tx> = { transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> };

/** The transaction type `TDb.transaction(fn)` hands to `fn` — read off the database, never restated. */
export type TxOf<TDb> = TDb extends { transaction(fn: (tx: infer Tx) => never): unknown } ? Tx : never;

/**
 * The `transaction` service: run `fn` inside one transaction of the bound
 * database. It commits ordinary values and rolls back returned failures or thrown errors.
 * The `tx` it hands out is the database's own transaction type, so
 * `repos.withTx(tx)` takes it with no cast.
 */
export type OpenTransaction<Tx> = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T | TransactionFailure>;

/**
 * A feature's transaction opener as one private infra unit: it needs `db`
 * unbound (the feature binds its own handle at `.infra()`) and publishes
 * `transaction(fn)` — and nothing else: no query builder, no `db`. Pair it
 * with `.needs({ db: entrypointOnly(database.provides.db) })`: a usecase
 * may open a transaction and hand its `tx` on, but it can never run raw SQL.
 * It takes the database HANDLE, never a type: the database and transaction
 * types are read off the handle, and `.infra()` checks the feature declares
 * that same handle — another database's handle is a compile error.
 *
 * @example
 * ```ts
 * const digestDeps = defineFeature('digest')
 *   .needs({ db: entrypointOnly(database.provides.db) })
 *   .infra(store, transactions(database.provides.db));
 * // usecases/compile.ts
 * const compile = ({ transaction, compiler }: Deps) => (plan: DigestPlan) => transaction(tx => compiler.store(tx, plan));
 * ```
 */
export function transactions<TDb extends Transactable<Tx>, K extends string, O extends string, Tx = TxOf<TDb>>(
  db: Handle<TDb, K, O>,
) {
  return infra({
    name: 'transactions',
    // Bound to the feature's database handle — key and provider literals included, so `.infra()` refuses any other.
    needs: { db },
    provides: {
      transaction:
        ({ db }): OpenTransaction<Tx> =>
        fn =>
          runTransactionOnce(db, fn),
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
      throw new DotUnitError({
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
