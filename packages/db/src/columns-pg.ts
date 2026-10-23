/** `pgColumns`: the column kit that builds Postgres tables (see `./columns.ts`). */
import type { Column } from 'drizzle-orm';
import { is, SQL, sql } from 'drizzle-orm';
import type {
  PgBigInt53Builder,
  PgBooleanBuilder,
  PgBuildColumns,
  PgCharBuilder,
  PgIntegerBuilder,
  PgJsonbBuilder,
  PgSchema,
  PgTable,
  PgTableExtraConfigValue,
  PgTableWithColumns,
  PgTextBuilder,
  PgTimestampBuilder,
  PgVarcharBuilder,
  Set$Type,
} from 'drizzle-orm/pg-core';
import {
  bigint,
  boolean,
  char,
  check,
  ExtraConfigColumn,
  index,
  integer,
  jsonb,
  PgColumn,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

import { invariant } from '@arki/failure';

import type {
  AnyColumnSpec,
  ApplyFlags,
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
} from './columns.js';
import { createColumnKit, replayColumn } from './columns.js';
import { tagColumnSchema } from './id-columns-shared.js';
import type { PgInstantBuilder } from './temporal.js';
import { instant } from './temporal.js';

/** The builder `pgBase` makes for each kind. */
type PgBase<K extends ColumnKind, F> = {
  text: PgTextBuilder<EnumOf<F>>;
  varchar: PgVarcharBuilder<EnumOf<F>>;
  char: PgCharBuilder<EnumOf<F>>;
  id: PgVarcharBuilder;
  integer: PgIntegerBuilder;
  bigint: PgBigInt53Builder;
  boolean: PgBooleanBuilder;
  json: PgJsonbBuilder;
  timestamp: PgTimestampBuilder;
  instant: PgInstantBuilder;
}[K];

type PgBuilderOf<K extends ColumnKind, F extends ColumnFlags> = ApplyFlags<
  F extends { type: infer T } ? Set$Type<PgBase<K, F>, T> : PgBase<K, F>,
  F
>;

/** The type `pgTable(name, columns)` gives the specs' replayed builders. The schema name is not kept as a literal. */
export type PgTableOf<N extends string, C> = PgTableWithColumns<{
  name: N;
  schema: string | undefined;
  columns: PgBuildColumns<N, { [Key in keyof C]: C[Key] extends ColumnSpec<'pg', infer K, infer F> ? PgBuilderOf<K, F> : never }>;
  dialect: 'pg';
}>;

/**
 * The column kit for Postgres. With a schema, tables go in it
 * (`schema.table`); without one, in the search path (`pgTable`).
 *
 * @example
 * ```typescript skip="needs a package table factory"
 * const auth = createAuthTables(pgColumns(pgSchema('auth')), options);
 * ```
 */
export function pgColumns(schema?: PgSchema): ColumnKit<'pg'> {
  function table<N extends string, C extends Record<string, AnyColumnSpec<'pg'>>>(
    name: N,
    columns: C,
    extras?: (columns: ExtraColumns<C>) => TableExtra[],
  ): TableOf<'pg', N, C>;
  // The overloads above carry the computed type; Drizzle's own `pgTable` does the same.
  function table(
    name: string,
    columns: Record<string, AnyColumnSpec<'pg'>>,
    extras?: (columns: Record<string, Column>) => TableExtra[],
  ): PgTable {
    const builders = Object.fromEntries(Object.entries(columns).map(([key, spec]) => [key, pgColumn(spec.definition)]));
    const extraConfig = extras && ((self: Record<string, Column>) => extras(self).map((extra) => pgExtra(extra)));
    return schema ? schema.table(name, builders, extraConfig) : pgTable(name, builders, extraConfig);
  }
  return createColumnKit('pg', table);
}

function pgBase(definition: ColumnDefinition) {
  // Drizzle names a column '' until the table gives it its key.
  const name = definition.name ?? '';
  const { enum: values, length } = definition;
  switch (definition.kind) {
    case 'text': {
      return values ? text(name, { enum: values }) : text(name);
    }
    case 'varchar': {
      return values ? varchar(name, { length, enum: values }) : varchar(name, { length });
    }
    case 'char': {
      return values ? char(name, { length, enum: values }) : char(name, { length });
    }
    case 'id': {
      return varchar(name, { length: 256 });
    }
    case 'integer': {
      return integer(name);
    }
    case 'bigint': {
      return bigint(name, { mode: 'number' });
    }
    case 'boolean': {
      return boolean(name);
    }
    case 'json': {
      return jsonb(name);
    }
    case 'timestamp': {
      return timestamp(name, { withTimezone: definition.withTimezone, mode: 'date' });
    }
    case 'instant': {
      return instant(name, { withTimezone: definition.withTimezone, precision: definition.precision });
    }
  }
}

function pgColumn(definition: ColumnDefinition) {
  const builder = pgBase(definition);
  // What Drizzle's `defaultNow()` emits; the custom `instant` column has no such method.
  replayColumn(builder, definition.ops, { now: sql`now()`, columnOf: pgColumnOf });
  return definition.schema ? tagColumnSchema(builder, definition.schema) : builder;
}

function pgColumnOf(column: Column): PgColumn {
  invariant(is(column, PgColumn), () => `@arki/db/pg: column "${column.name}" belongs to a SQLite table, not a Postgres one.`);
  return column;
}

function pgIndexColumn(column: ExtraColumn): PgColumn | SQL {
  if (is(column, SQL)) return column;
  if ('order' in column) {
    invariant(is(column.column, ExtraConfigColumn), '@arki/db/pg: `c.desc()` takes a column of the table being defined.');
    return column.column.desc();
  }
  return pgColumnOf(column);
}

function pgExtra(extra: TableExtra): PgTableExtraConfigValue {
  switch (extra.extra) {
    case 'index': {
      const [first, ...rest] = extra.columns.map((column) => pgIndexColumn(column));
      invariant(first, `@arki/db/pg: index "${extra.name}" has no columns.`);
      const built = (extra.unique ? uniqueIndex : index)(extra.name).on(first, ...rest);
      return extra.predicate ? built.where(extra.predicate) : built;
    }
    case 'unique': {
      const [first, ...rest] = extra.columns.map((column) => pgColumnOf(column));
      invariant(first, `@arki/db/pg: unique constraint "${extra.name}" has no columns.`);
      return unique(extra.name).on(first, ...rest);
    }
    case 'check': {
      return check(extra.name, extra.sql);
    }
  }
}
