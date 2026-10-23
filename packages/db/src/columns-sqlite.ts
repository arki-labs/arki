/** `sqliteColumns`: the column kit that builds SQLite tables (see `./columns.ts`). */
import type { $Type, BuildColumns, Column } from 'drizzle-orm';
import type {
  SQLiteBooleanBuilder,
  SQLiteIntegerBuilder,
  SQLiteTable,
  SQLiteTableExtraConfigValue,
  SQLiteTableWithColumns,
  SQLiteTextBuilder,
  SQLiteTextJsonBuilder,
  SQLiteTimestampBuilder,
} from 'drizzle-orm/sqlite-core';
import { is, SQL, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  SQLiteColumn,
  sqliteTableCreator,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

import { invariant } from '@arki/failure';

import type {
  AnyColumnSpec,
  ApplyFlags,
  Call,
  ColumnDefinition,
  ColumnFlags,
  ColumnKind,
  ColumnKit,
  ColumnSpec,
  EnumOf,
  ExtraColumn,
  ExtraColumns,
  TableExtra,
  TableOf,
  TextEnum,
} from './columns.js';
import { createColumnKit, replayColumn } from './columns.js';
import { tagColumnSchema } from './id-columns-shared.js';
import type { SqliteInstantBuilder } from './sqlite-instant.js';
import { instant } from './sqlite-instant.js';
import { sqliteNowMs } from './sqlite-now.js';

/** The builder `sqliteBase` makes for each kind. */
type SqliteBase<K extends ColumnKind, F> = {
  text: SQLiteTextBuilder<EnumOf<F>>;
  varchar: SQLiteTextBuilder<EnumOf<F>>;
  char: SQLiteTextBuilder<EnumOf<F>>;
  id: SQLiteTextBuilder<TextEnum>;
  integer: SQLiteIntegerBuilder;
  bigint: SQLiteIntegerBuilder;
  // The primary key is part of the column, not a replayed modifier.
  serial: Call<SQLiteIntegerBuilder, 'primaryKey'>;
  boolean: SQLiteBooleanBuilder;
  json: SQLiteTextJsonBuilder;
  timestamp: SQLiteTimestampBuilder;
  instant: SqliteInstantBuilder;
}[K];

type SqliteBuilderOf<K extends ColumnKind, F extends ColumnFlags> = ApplyFlags<
  F extends { type: infer T } ? $Type<SqliteBase<K, F>, T> : SqliteBase<K, F>,
  F
>;

/** The type `sqliteTable(name, columns)` gives the specs' replayed builders. */
export type SqliteTableOf<N extends string, C> = SQLiteTableWithColumns<{
  name: N;
  schema: undefined;
  columns: BuildColumns<N, { [Key in keyof C]: C[Key] extends ColumnSpec<'sqlite', infer K, infer F> ? SqliteBuilderOf<K, F> : never }, 'sqlite'>;
  dialect: 'sqlite';
}>;

export type SqliteColumnsOptions = {
  /** Put before every table name. SQLite has no schemas, so `pgSchema('auth')` becomes `prefix: 'auth_'`. */
  readonly prefix?: string;
};

/**
 * The column kit for SQLite (libSQL). Postgres-only column types map to
 * their nearest SQLite form: `jsonb` → JSON `text`, timestamps → integer
 * milliseconds, `varchar(n)`/`char(n)` → `text` with a `length()` check.
 *
 * @example
 * ```typescript skip="needs a package table factory"
 * const auth = createAuthTables(sqliteColumns({ prefix: 'auth_' }), options);
 * ```
 */
export function sqliteColumns(options: SqliteColumnsOptions = {}): ColumnKit<'sqlite'> {
  const prefix = options.prefix ?? '';
  // Types keep the unprefixed name; Drizzle keys join results by it too.
  const sqliteTable = sqliteTableCreator(name => `${prefix}${name}`);

  function table<N extends string, C extends Record<string, AnyColumnSpec<'sqlite'>>>(
    name: N,
    columns: C,
    extras?: (columns: ExtraColumns<C>) => TableExtra[],
  ): TableOf<'sqlite', N, C>;
  // The overloads above carry the computed type; Drizzle's own `sqliteTable` does the same.
  function table(
    name: string,
    columns: Record<string, AnyColumnSpec<'sqlite'>>,
    extras?: (columns: Record<string, Column>) => TableExtra[],
  ): SQLiteTable {
    const builders = Object.fromEntries(
      Object.entries(columns).map(([key, spec]) => [key, sqliteColumn(spec.definition)]),
    );
    return sqliteTable(name, builders, (self: Record<string, Column>) =>
      [...lengthChecks(`${prefix}${name}`, columns, self), ...(extras?.(self) ?? [])].map((extra) => sqliteExtra(extra, prefix)),
    );
  }
  return createColumnKit('sqlite', table);
}

/** SQLite ignores `varchar(n)`; a `CHECK` keeps the Postgres limit. */
function lengthChecks(
  tableName: string,
  columns: Record<string, AnyColumnSpec<'sqlite'>>,
  self: Record<string, Column>,
): TableExtra[] {
  return Object.entries(columns).flatMap(([key, spec]): TableExtra[] => {
    const { length } = spec.definition;
    const column = self[key];
    if (length === undefined || !column) return [];
    return [
      {
        extra: 'check',
        name: `${tableName}_${column.name}_length`,
        sql: sql`length(${column}) <= ${sql.raw(String(length))}`,
      },
    ];
  });
}

function sqliteBase(definition: ColumnDefinition) {
  // Drizzle names a column '' until the table gives it its key.
  const name = definition.name ?? '';
  const values = definition.enum;
  switch (definition.kind) {
    case 'text':
    case 'varchar':
    case 'char': {
      return values ? text(name, { enum: values }) : text(name);
    }
    case 'id': {
      return text(name);
    }
    case 'integer':
    case 'bigint': {
      return integer(name, { mode: 'number' });
    }
    case 'serial': {
      return integer(name, { mode: 'number' }).primaryKey({ autoIncrement: true });
    }
    case 'boolean': {
      return integer(name, { mode: 'boolean' });
    }
    case 'json': {
      return text(name, { mode: 'json' });
    }
    case 'timestamp': {
      return integer(name, { mode: 'timestamp_ms' });
    }
    case 'instant': {
      return instant(name);
    }
  }
}

function sqliteColumn(definition: ColumnDefinition) {
  const builder = sqliteBase(definition);
  replayColumn(builder, definition.ops, { now: sqliteNowMs, columnOf: sqliteColumnOf });
  return definition.schema ? tagColumnSchema(builder, definition.schema) : builder;
}

function sqliteColumnOf(column: Column): SQLiteColumn {
  invariant(
    is(column, SQLiteColumn),
    () => `@arki/db/sqlite: column "${column.name}" belongs to a Postgres table, not a SQLite one.`,
  );
  return column;
}

function sqliteIndexColumn(column: ExtraColumn): SQLiteColumn | SQL {
  if (is(column, SQL)) return column;
  if ('order' in column) return sql`${sqliteColumnOf(column.column)} desc`;
  return sqliteColumnOf(column);
}

/** Index names are global in a SQLite database (Postgres scopes them to the schema), so they take the prefix too. */
function sqliteExtra(extra: TableExtra, prefix: string): SQLiteTableExtraConfigValue {
  switch (extra.extra) {
    case 'index': {
      const [first, ...rest] = extra.columns.map((column) => sqliteIndexColumn(column));
      invariant(first, `@arki/db/sqlite: index "${extra.name}" has no columns.`);
      const built = (extra.unique ? uniqueIndex : index)(`${prefix}${extra.name}`).on(first, ...rest);
      return extra.predicate ? built.where(extra.predicate) : built;
    }
    case 'unique': {
      const [first, ...rest] = extra.columns.map((column) => sqliteColumnOf(column));
      invariant(first, `@arki/db/sqlite: unique constraint "${extra.name}" has no columns.`);
      return unique(extra.name).on(first, ...rest);
    }
    case 'check': {
      return check(extra.name, extra.sql);
    }
  }
}
