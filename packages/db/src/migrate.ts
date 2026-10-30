/**
 * Apply Drizzle migrations to a handle opened by `@arki/db`, whichever driver
 * produced it. The DOT plugin that does so at boot is `dbMigrations` in `@arki/db/dot`.
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
 * import { db, dbMigrations } from '@arki/db/dot';
 *
 * defineApp('shop')
 *   .use(db({ driver: 'pglite', dataDir: './.local/db', relations }))
 *   .use(dbMigrations({ migrationsFolder: './drizzle' }))   // or { migrations }
 *   .useAll(plugs(features));
 * ```
 */
import type { AnyRelations } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { MigrationMeta } from 'drizzle-orm/migrator';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { is, sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { getMigrationsToRun } from 'drizzle-orm/migrator.utils';
import { migrate } from 'drizzle-orm/pg-core';
import { migrateAsync, SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core';

import { z } from '@arki/contracts';
import { isFailure, UnexpectedDefect } from '@arki/failure';
import { parse } from '@arki/schema';

import { debugInit } from './debug.js';
import { MigrationReadFailed, MigrationStateFailed, MigrationUnconfirmed } from './migrate-failures.js';
import { observeDbOperation, observeDbSyncOperation } from './runtime-local-telemetry.js';

export {
  MIGRATION_APPLY_FAILURES,
  MIGRATION_READ_FAILURES,
  MIGRATION_STATE_FAILURES,
  MigrationReadFailed,
  MigrationStateFailed,
  MigrationUnconfirmed,
} from './migrate-failures.js';

/** Any handle the `db` plugin publishes. */
export type MigratableDb<TRelations extends AnyRelations = AnyRelations> =
  NodePgDatabase<TRelations> | PgliteDatabase<TRelations> | LibSQLDatabase<TRelations>;

/** One migration as drizzle's migrator consumes it. Re-exported so apps can type a generated module. */
export type { MigrationMeta } from 'drizzle-orm/migrator';

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
  /** Override the schema the bookkeeping table lives in (`drizzle`). Postgres only: SQLite has no schemas. */
  readonly migrationsSchema?: string;
};

/** Read a `drizzle-kit generate` folder into the in-memory form. Build-time helper. */
export function readMigrations(migrationsFolder: string) {
  return observeDbSyncOperation('db.migrations.read', () => {
    try {
      return readMigrationFiles({ migrationsFolder });
    } catch (error) {
      return MigrationReadFailed({ cause: error });
    }
  });
}

function sourceOf(options: MigrateDbOptions) {
  try {
    const migrations = options.migrations;
    return migrations === undefined ? readMigrations(options.migrationsFolder) : [...migrations];
  } catch (error) {
    return UnexpectedDefect({ cause: error });
  }
}

/** A row of drizzle's bookkeeping table. `created_at` is a bigint: a string on node-postgres. */
const appliedRowSchema = z.object({
  id: z.coerce.number(),
  hash: z.string(),
  created_at: z.coerce.string(),
  name: z
    .string()
    .nullish()
    .transform(name => name ?? null),
});

/**
 * The names of the migrations `migrateDb` would apply now, in order. Read
 * only: it never creates the bookkeeping table. Uses drizzle's own rule
 * (`getMigrationsToRun`), so the list matches what `migrateDb` runs.
 */
export function pendingMigrations<TRelations extends AnyRelations>(
  db: MigratableDb<TRelations>,
  options: MigrateDbOptions,
) {
  return observeDbOperation('db.migrations.pending', async () => {
    try {
      const local = sourceOf(options);
      if (isFailure(local)) return local;
      if (is(db, SQLiteAsyncDatabase)) {
        // SQLite has no schemas: the table sits in the main database.
        const name = options.migrationsTable ?? '__drizzle_migrations';
        const found = await db.all(sql`select 1 from sqlite_master where type = 'table' and name = ${name}`);
        if (found.length === 0) return local.map(migration => migration.name);
        const applied = parse(z.array(appliedRowSchema), await db.all(sql`select * from ${sql.identifier(name)}`));
        if (isFailure(applied)) return UnexpectedDefect({ cause: applied });
        return getMigrationsToRun({ localMigrations: local, dbMigrations: applied }).map(migration => migration.name);
      }
      const table = `"${options.migrationsSchema ?? 'drizzle'}"."${options.migrationsTable ?? '__drizzle_migrations'}"`;
      const exists = await db.execute(sql`select to_regclass(${table}) is not null as "exists"`);
      const found = parse(z.array(z.object({ exists: z.boolean() })), exists.rows);
      if (isFailure(found)) return UnexpectedDefect({ cause: found });
      if (found[0]?.exists !== true) return local.map(migration => migration.name);
      const applied = await db.execute(
        sql`select * from ${sql.identifier(options.migrationsSchema ?? 'drizzle')}.${sql.identifier(options.migrationsTable ?? '__drizzle_migrations')}`,
      );
      const dbMigrations = parse(z.array(appliedRowSchema), applied.rows);
      if (isFailure(dbMigrations)) return UnexpectedDefect({ cause: dbMigrations });
      return getMigrationsToRun({ localMigrations: local, dbMigrations }).map(migration => migration.name);
    } catch (error) {
      return MigrationStateFailed({ cause: error });
    }
  });
}

/**
 * Run pending migrations. Both drivers share drizzle's Postgres migrate step
 * (`drizzle-orm/pg-core`'s `migrate`), which the per-driver `migrate()`
 * helpers merely wrap with `readMigrationFiles`.
 */
export function migrateDb<TRelations extends AnyRelations>(db: MigratableDb<TRelations>, options: MigrateDbOptions) {
  return observeDbOperation('db.migrations.apply', async () => {
    let submitted = false;
    try {
      const migrations = sourceOf(options);
      if (isFailure(migrations)) return migrations;
      debugInit.debug('[migrate] applying {migrationsLength} migration(s)', { migrationsLength: migrations.length });
      if (is(db, SQLiteAsyncDatabase)) {
        // SQLite has no schemas, so `migrationsSchema` does not apply.
        const config = { migrationsTable: options.migrationsTable ?? '__drizzle_migrations' };
        submitted = true;
        await migrateAsync(migrations, db, config);
        debugInit.debug('[migrate] migrations applied');
        return;
      }
      const config = {
        // Drizzle's config type requires the folder even though this step only
        // reads the table/schema names; the list above is already in memory.
        migrationsFolder: options.migrationsFolder ?? '',
        migrationsTable: options.migrationsTable ?? '__drizzle_migrations',
        migrationsSchema: options.migrationsSchema ?? 'drizzle',
      };
      submitted = true;
      await migrate(migrations, db, config);
      debugInit.debug('[migrate] migrations applied');
      return;
    } catch (error) {
      return submitted ? MigrationUnconfirmed({ cause: error }) : UnexpectedDefect({ cause: error });
    }
  });
}
