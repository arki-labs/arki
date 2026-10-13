/**
 * Apply Drizzle migrations to a handle opened by `@arki/db`, whichever driver
 * produced it, plus a DOT plugin that does so at boot.
 *
 * Why this lives here and not in each app: consumers must not import the
 * drizzle migrator modules themselves. Outside the monorepo that pulls a second
 * `drizzle-orm` into the app whose types do not match the one `@arki/db`
 * returns, and every app ends up re-implementing "migrate at boot" anyway.
 *
 * Migrations come either from the folder `drizzle-kit generate` writes, or
 * from an in-memory list (`readMigrations(folder)` at build time, committed as
 * a module). The second form is what a bundled server needs: there is no
 * `drizzle/` folder next to `.output/server/index.mjs`.
 *
 * @example
 * ```ts
 * import { db } from '@arki/db/dot';
 * import { dbMigrations } from '@arki/db/migrate';
 *
 * defineApp('shop')
 *   .use(db({ driver: 'pglite', dataDir: './.local/db', relations }))
 *   .use(dbMigrations({ migrationsFolder: './drizzle' }))   // or { migrations }
 *   .useAll(plugs(features));
 * ```
 */
import type { AnyRelations } from 'drizzle-orm';
import type { MigrationMeta } from 'drizzle-orm/migrator';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate } from 'drizzle-orm/pg-core';

import { plugin, service, type Plugin } from '@arki/dot/plugin';

import { debugInit } from './debug.js';

/** Any handle the `db` plugin publishes. */
export type MigratableDb<TRelations extends AnyRelations = AnyRelations> =
  | NodePgDatabase<TRelations>
  | PgliteDatabase<TRelations>;

/** One migration as drizzle's migrator consumes it. Re-exported so apps can type a generated module. */
export type { MigrationMeta };

type MigrationSource =
  | {
      /** Folder produced by `drizzle-kit generate`. Read at migration time. */
      readonly migrationsFolder: string;
      readonly migrations?: undefined;
    }
  | {
      /** Migrations already in memory, e.g. a module generated with `readMigrations()`. */
      readonly migrations: readonly MigrationMeta[];
      readonly migrationsFolder?: undefined;
    };

export type MigrateDbOptions = MigrationSource & {
  /** Override drizzle's bookkeeping table (`__drizzle_migrations`). */
  readonly migrationsTable?: string;
  /** Override the schema the bookkeeping table lives in (`drizzle`). */
  readonly migrationsSchema?: string;
};

/** Read a `drizzle-kit generate` folder into the in-memory form. Build-time helper. */
export function readMigrations(migrationsFolder: string): MigrationMeta[] {
  return readMigrationFiles({ migrationsFolder });
}

/**
 * Run pending migrations. Both drivers share drizzle's Postgres migrate step
 * (`drizzle-orm/pg-core`'s `migrate`), which the per-driver `migrate()`
 * helpers merely wrap with `readMigrationFiles`.
 */
export async function migrateDb<TRelations extends AnyRelations>(
  db: MigratableDb<TRelations>,
  options: MigrateDbOptions,
): Promise<void> {
  const migrations =
    options.migrations === undefined ? readMigrations(options.migrationsFolder) : [...options.migrations];
  debugInit('[migrate] applying %d migration(s)', migrations.length);
  await migrate(migrations, db, {
    // Drizzle's config type requires the folder even though this step only
    // reads the table/schema names; the list above is already in memory.
    migrationsFolder: options.migrationsFolder ?? '',
    migrationsTable: options.migrationsTable ?? '__drizzle_migrations',
    migrationsSchema: options.migrationsSchema ?? 'drizzle',
  });
  debugInit('[migrate] migrations applied');
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
