/** Prefixed id generators and `idColumns` for ids declared with `defineId`. */
import type { PgColumn } from 'drizzle-orm/pg-core';
import { varchar } from 'drizzle-orm/pg-core';

import type { IdGenerationFailure, z } from '@arki/contracts';
import { createIdBody } from '@arki/contracts';
import { isFailure, orThrow } from '@arki/failure';

import type { OnDelete } from './id-columns-shared.js';
import { tagColumnSchema } from './id-columns-shared.js';

export type { OnDelete } from './id-columns-shared.js';

/** Generate an unprefixed legacy ID, or the canonical entropy failure. */
export const createId = createIdBody;

/** Preserve the supplied prefix exactly, including legacy empty or non-word prefixes. */
export const createPrefixedId = <T extends string>(prefix: T): `${T}${string}` | IdGenerationFailure => {
  const body = createId();
  return isFailure(body) ? body : `${prefix}${body}`;
};

/**
 * What the column helpers need from an id kind: its schema (stamped on every
 * column, so `@arki/contracts/drizzle` schemas check the prefix at runtime)
 * and its generator (the default of generated columns). `defineId('sty_')`
 * from `@arki/contracts` has both.
 */
export type IdColumnSource<TId extends string> = {
  // Zod's canonical output retains brands; its deprecated `_output` alias does not.
  readonly schema: z.ZodType & z.core.$ZodType<TId>;
  readonly create: () => TId | IdGenerationFailure;
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
export function idColumns<TSchema extends z.ZodType & z.core.$ZodType<string>>(
  id: IdColumnSource<z.output<NoInfer<TSchema>>> & { readonly schema: TSchema },
) {
  type TId = z.output<TSchema>;
  const { schema, create } = id;

  const columns = {
    /**
     * Drizzle column helper for primary key columns
     * Automatically configures as varchar(256), not null, primary key, with proper type and default
     */
    primaryColumn: (name = 'id') =>
      tagColumnSchema(
        varchar(name, { length: 256 })
          .notNull()
          .primaryKey()
          .$type<TId>()
          .$defaultFn(() => {
            // Drizzle requires a scalar default; its foreign callback cannot return a Failure.
            return orThrow(create());
          }),
        schema,
      ),

    optionalColumn: (name: string) =>
      tagColumnSchema(
        varchar(name, { length: 256 })
          .$type<TId | null>()
          .$defaultFn(() => null),
        schema,
      ),

    requiredColumn: (name: string) =>
      tagColumnSchema(
        varchar(name, { length: 256 })
          .notNull()
          .$type<TId>()
          .$defaultFn(() => {
            // Drizzle requires a scalar default; its foreign callback cannot return a Failure.
            return orThrow(create());
          }),
        schema,
      ),

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

// Re-export drizzle and zod utilities
export * from 'drizzle-orm';
export { createInsertSchema, createSelectSchema, createSchemaFactory, createUpdateSchema } from 'drizzle-orm/zod';
