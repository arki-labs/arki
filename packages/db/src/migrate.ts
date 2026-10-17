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
import type { MigrationMeta } from 'drizzle-orm/migrator';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { getMigrationsToRun } from 'drizzle-orm/migrator.utils';
import { migrate } from 'drizzle-orm/pg-core';

import { z } from '@arki/contracts';

import { debugInit } from './debug.js';

/** Any handle the `db` plugin publishes. */
export type MigratableDb<TRelations extends AnyRelations = AnyRelations> =
  NodePgDatabase<TRelations> | PgliteDatabase<TRelations>;

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
  /** Override the schema the bookkeeping table lives in (`drizzle`). */
  readonly migrationsSchema?: string;
};

/** Read a `drizzle-kit generate` folder into the in-memory form. Build-time helper. */
export function readMigrations(migrationsFolder: string): MigrationMeta[] {
  return readMigrationFiles({ migrationsFolder });
}

function sourceOf(options: MigrateDbOptions): MigrationMeta[] {
  return options.migrations === undefined ? readMigrations(options.migrationsFolder) : [...options.migrations];
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
export async function pendingMigrations<TRelations extends AnyRelations>(
  db: MigratableDb<TRelations>,
  options: MigrateDbOptions,
): Promise<string[]> {
  const local = sourceOf(options);
  const table = `"${options.migrationsSchema ?? 'drizzle'}"."${options.migrationsTable ?? '__drizzle_migrations'}"`;
  const exists = await db.execute(sql`select to_regclass(${table}) is not null as "exists"`);
  const found = z.array(z.object({ exists: z.boolean() })).parse(exists.rows);
  if (found[0]?.exists !== true) return local.map(migration => migration.name);
  const applied = await db.execute(
    sql`select * from ${sql.identifier(options.migrationsSchema ?? 'drizzle')}.${sql.identifier(options.migrationsTable ?? '__drizzle_migrations')}`,
  );
  const dbMigrations = z.array(appliedRowSchema).parse(applied.rows);
  return getMigrationsToRun({ localMigrations: local, dbMigrations }).map(migration => migration.name);
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
  const migrations = sourceOf(options);
  debugInit.debug('[migrate] applying {migrationsLength} migration(s)', { migrationsLength: migrations.length });
  await migrate(migrations, db, {
    // Drizzle's config type requires the folder even though this step only
    // reads the table/schema names; the list above is already in memory.
    migrationsFolder: options.migrationsFolder ?? '',
    migrationsTable: options.migrationsTable ?? '__drizzle_migrations',
    migrationsSchema: options.migrationsSchema ?? 'drizzle',
  });
  debugInit.debug('[migrate] migrations applied');
}
