import type { AnyPgColumnBuilder } from 'drizzle-orm/pg-core';
import { timestamp } from 'drizzle-orm/pg-core';

/**
 * Options shared by the auth and the workspace table factories, and the
 * column makers that read them.
 */

/** How column names are spelled in the database: `email_verified` or `emailVerified`. */
export type AuthColumnNaming = 'snake' | 'camel';

/**
 * Who fills a column that has a default (`createdAt`, `updatedAt`,
 * `emailVerified`, ...) when a row is inserted without it.
 *
 * - `'app'`: the app, through Drizzle's `$defaultFn`. The database sees no
 *   default. This is the shape Better Auth expects when it writes the rows.
 * - `'database'`: the database, through `DEFAULT now()`, `DEFAULT false`, ... Such a
 *   column is `NOT NULL`, since the database can always fill it.
 */
export type AuthColumnFill = 'app' | 'database';

export type AuthColumnOptions<TFill extends AuthColumnFill> = {
  /** Spelling of the database column names. Default: `'snake'`. */
  naming?: AuthColumnNaming;
  /** Who fills the columns that have a default. */
  fill: TFill;
};

export type ColumnNamer = (key: string) => string;

const toSnakeCase: ColumnNamer = key => key.replaceAll(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
const keepKey: ColumnNamer = key => key;

export function columnNamer(naming: AuthColumnNaming = 'snake'): ColumnNamer {
  return naming === 'camel' ? keepKey : toSnakeCase;
}

/** Something that makes the primary key column of one table. The lib never makes ids. */
export type PrimaryColumnSource<TBuilder extends AnyPgColumnBuilder> = {
  primaryColumn: () => TBuilder;
};

export const now = () => /* @__PURE__ */ new Date();

/**
 * One column maker per `fill` mode. The returned function picks the maker
 * for the mode and keeps that maker's column type, so a table's inferred row
 * types follow the mode (`createdAt?` on insert only where a default exists).
 */
export function byFill<TApp, TDatabase>(makers: { app: (name: string) => TApp; database: (name: string) => TDatabase }) {
  return <TFill extends AuthColumnFill>(fill: TFill, name: string) =>
    // TypeScript cannot tie a runtime key to a type parameter
    // (microsoft/TypeScript#30581). The lookup uses that same key, so the
    // assertion only states what the line does.
    makers[fill](name) as { app: TApp; database: TDatabase }[TFill];
}

/** A `NOT NULL` timestamp that is filled on insert: by the app (`'app'`) or by the database (`'database'`). */
export const filledAt = byFill({
  app: name => timestamp(name).notNull().$defaultFn(now),
  database: name => timestamp(name).notNull().defaultNow(),
});
