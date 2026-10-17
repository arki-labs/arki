/** Prefixed id factories (`createIdFactory`) and `idColumns` for ids declared with `defineId`. */
import { createId as createCuid } from '@paralleldrive/cuid2';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { varchar } from 'drizzle-orm/pg-core';

import { z } from '@arki/contracts';
import { COLUMN_ZOD_SCHEMA } from '@arki/contracts/drizzle';

// Core ID creation
export const createId = () => createCuid();

export const createPrefixedId = <T extends string>(prefix: T): `${T}${string}` => {
  return `${prefix}${createId()}`;
};

/**
 * Stash a Zod schema on a Drizzle column builder so that
 * `@arki/contracts`'s `createSelectSchema`/`createInsertSchema`/`createUpdateSchema`
 * wrappers auto-apply it as a refine — turning the brand from a phantom-only
 * type into a real runtime check.
 *
 * The builder's `config` object is the SAME reference passed to the constructed
 * column (see `PgVarcharBuilder.build` → `new PgVarchar(table, this.config)`),
 * so writing here is readable from the column later.
 */
function tagColumnSchema<TBuilder>(builder: TBuilder, schema: z.ZodTypeAny): TBuilder {
  const cfg = (builder as unknown as { config: Record<string | symbol, unknown> }).config;
  cfg[COLUMN_ZOD_SCHEMA] = schema;
  return builder;
}

type OnDelete = 'cascade' | 'restrict' | 'no action' | 'set null' | 'set default';

/**
 * What the column helpers need from an id kind: its schema (stamped on every
 * column, so `@arki/contracts/drizzle` schemas check the prefix at runtime)
 * and its generator (the default of generated columns). `defineId('sty_')`
 * from `@arki/contracts` has both, and so does {@link createIdFactory}.
 */
export type IdColumnSource<TId extends string> = {
  readonly schema: z.ZodType;
  readonly create: () => TId;
};

/**
 * The Drizzle columns of one id kind. The id type comes from the
 * declaration's generator, so it is written once — in the prefix.
 *
 * @example
 * ```typescript
 * // model/ids.ts (browser-safe):  export const storyId = defineId('sty_');
 * // model/tables.ts (server):
 * const story = idColumns(storyId);
 * export const stories = pgTable('stories', {
 *   id: story.primaryColumn(),
 *   parentId: story.optionalReference('parent_id'),
 * });
 * ```
 */
export function idColumns<TId extends string>(id: IdColumnSource<TId>) {
  const { schema, create } = id;

  const columns = {
    /**
     * Drizzle column helper for primary key columns
     * Automatically configures as varchar(256), not null, primary key, with proper type and default
     */
    primaryColumn: (name = 'id') =>
      tagColumnSchema(varchar(name, { length: 256 }).notNull().primaryKey().$type<TId>().$defaultFn(create), schema),

    optionalColumn: (name: string) =>
      tagColumnSchema(
        varchar(name, { length: 256 })
          .$type<TId | null>()
          .$defaultFn(() => null),
        schema,
      ),

    requiredColumn: (name: string) =>
      tagColumnSchema(varchar(name, { length: 256 }).notNull().$type<TId>().$defaultFn(create), schema),

    /**
     * Drizzle column helper for foreign key reference columns
     * Configures as varchar(256), not null, with proper type (no default or primary key)
     */
    reference: (name: string) => tagColumnSchema(varchar(name, { length: 256 }).notNull().$type<TId>(), schema),

    /**
     * Drizzle column helper for optional foreign key reference columns
     * Configures as varchar(256), nullable, with proper type
     */
    optionalReference: (name: string) => tagColumnSchema(varchar(name, { length: 256 }).$type<TId>(), schema),

    /**
     * Drizzle column helper for foreign key reference with relation
     * Configures as varchar(256), not null, with proper type and foreign key constraint
     */
    foreignKey: (name: string, referenceFn: () => PgColumn, options?: { onDelete?: OnDelete }) =>
      tagColumnSchema(varchar(name, { length: 256 }).notNull().$type<TId>().references(referenceFn, options), schema),

    /**
     * Drizzle column helper for optional foreign key reference with relation
     * Configures as varchar(256), nullable, with proper type and foreign key constraint
     */
    optionalForeignKey: (name: string, referenceFn: () => PgColumn, options?: { onDelete?: OnDelete }) =>
      tagColumnSchema(varchar(name, { length: 256 }).$type<TId>().references(referenceFn, options), schema),

    /**
     * Creates a foreign key factory bound to a specific table
     * This allows creating multiple foreign keys to the same table without repeating the reference
     */
    createForeignKeyFactory: (referenceFn: () => PgColumn) => ({
      required: (name: string, options?: { onDelete?: OnDelete }) => columns.foreignKey(name, referenceFn, options),
      optional: (name: string, options?: { onDelete?: OnDelete }) =>
        columns.optionalForeignKey(name, referenceFn, options),
    }),
  };

  return columns;
}

/**
 * Type-safe ID factory that generates all ID-related utilities at once
 *
 * New code: declare the id with `defineId('pt_')` from `@arki/contracts`
 * (browser-safe, type written once) and get its columns with
 * {@link idColumns}. This factory stays for the ids declared the old way.
 *
 * @param prefix - The prefix for the ID type (e.g., 'pt', 'usr', 'ant')
 * @returns An object with create function, schema, and column helpers
 *
 * @example
 * ```typescript
 * export type PoetId = `pt${string}`;
 * const poetId = createIdFactory<'pt', PoetId>('pt');
 *
 * export const createPoetId = poetId.create;
 * export const poetIdSchema = poetId.schema;
 *
 * export const poets = schema.table('poets', {
 *   id: poetId.primaryColumn(),
 *   // ... other columns
 * });
 * ```
 */
export function createIdFactory<TPrefix extends string, TId extends `${TPrefix}${string}`>(prefix: TPrefix) {
  /**
   * Zod validation schema for the ID type. Uses refine instead of transform
   * for better type safety; auto-applied at parse time by @arki/contracts'
   * schema wrappers when this factory's columns appear on the table.
   */
  const schema = z
    .string()
    .startsWith(prefix)
    .brand<TId>()
    .transform(id => id as TId);

  const create = (): TId => createPrefixedId(prefix) as TId;

  return {
    /**
     * Creates a new ID with the specified prefix
     */
    create,
    /**
     * Creates a new ID with the specified prefix
     */
    make: create,
    /**
     * Creates a new ID with the specified prefix
     */
    new: create,

    schema,

    ...idColumns({ schema, create }),
  };
}

// Re-export drizzle and zod utilities
export * from 'drizzle-orm';
export { createInsertSchema, createSelectSchema, createSchemaFactory, createUpdateSchema } from 'drizzle-orm/zod';
