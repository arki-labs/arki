/** The `@arki/db/sqlite` entry: Drizzle's SQLite column API plus `idColumns` for ids declared with `defineId`. */
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { text } from 'drizzle-orm/sqlite-core';

import type { z } from '@arki/contracts';
import { orThrow } from '@arki/failure';

import type { OnDelete } from './id-columns-shared.js';
import type { IdColumnSource } from './id-factory.js';
import { tagColumnSchema } from './id-columns-shared.js';

export type { OnDelete } from './id-columns-shared.js';

/**
 * The SQLite columns of one id kind. Same shape as the Postgres `idColumns`
 * in `@arki/db`; the id type comes from the declaration's generator, so it
 * is written once, in the prefix. SQLite `text` has no length, so there is no
 * `varchar(256)`.
 *
 * @example
 * ```typescript
 * const story = idColumns(storyId);
 * export const stories = sqliteTable('stories', {
 *   id: story.primaryColumn(),
 *   parentId: story.optionalReference('parent_id'),
 * });
 * ```
 */
export function idColumns<TSchema extends z.ZodType & z.core.$ZodType<string>>(
  id: IdColumnSource<z.output<NoInfer<TSchema>>> & { readonly schema: TSchema },
) {
  type TId = z.output<TSchema>;
  const { schema, create } = id;

  const columns = {
    /** Primary key column: text, not null, typed as the id, defaulting to a fresh id. */
    primaryColumn: (name = 'id') =>
      tagColumnSchema(
        text(name)
          .notNull()
          .primaryKey()
          .$type<TId>()
          .$defaultFn(() => {
            // Drizzle requires a scalar default; its foreign callback cannot return a Failure.
            return orThrow(create());
          }),
        schema,
      ),

    /** Nullable id column, null by default. */
    optionalColumn: (name: string) =>
      tagColumnSchema(
        text(name)
          .$type<TId | null>()
          .$defaultFn(() => null),
        schema,
      ),

    /** Not-null id column that defaults to a fresh id. */
    requiredColumn: (name: string) =>
      tagColumnSchema(
        text(name)
          .notNull()
          .$type<TId>()
          .$defaultFn(() => {
            // Drizzle requires a scalar default; its foreign callback cannot return a Failure.
            return orThrow(create());
          }),
        schema,
      ),

    /** Reference column: text, not null, typed as the id (no default, no constraint). */
    reference: (name: string) => tagColumnSchema(text(name).notNull().$type<TId>(), schema),

    /** Optional reference column: text, nullable, typed as the id. */
    optionalReference: (name: string) => tagColumnSchema(text(name).$type<TId>(), schema),

    /** Not-null foreign key column with a database constraint. */
    foreignKey: (name: string, referenceFn: () => SQLiteColumn, options?: { onDelete?: OnDelete }) =>
      tagColumnSchema(text(name).notNull().$type<TId>().references(referenceFn, options), schema),

    /** Nullable foreign key column with a database constraint. */
    optionalForeignKey: (name: string, referenceFn: () => SQLiteColumn, options?: { onDelete?: OnDelete }) =>
      tagColumnSchema(text(name).$type<TId>().references(referenceFn, options), schema),

    /** Foreign key factory bound to one table, for several keys to the same column. */
    createForeignKeyFactory: (referenceFn: () => SQLiteColumn) => ({
      required: (name: string, options?: { onDelete?: OnDelete }) => columns.foreignKey(name, referenceFn, options),
      optional: (name: string, options?: { onDelete?: OnDelete }) =>
        columns.optionalForeignKey(name, referenceFn, options),
    }),
  };

  return columns;
}

export * from 'drizzle-orm/sqlite-core';
export type { SqliteColumnsOptions, SqliteTableOf } from './columns-sqlite.js';
export { sqliteColumns } from './columns-sqlite.js';
export { instant } from './sqlite-instant.js';
export { sqliteNowMs } from './sqlite-now.js';
