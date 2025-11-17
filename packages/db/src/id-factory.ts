import { createId as createCuid } from '@paralleldrive/cuid2';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { varchar } from 'drizzle-orm/pg-core';

import { z } from '@arki/contracts';

// Core ID creation
export const createId = () => createCuid();

export const createPrefixedId = <T extends string>(prefix: T): `${T}${string}` => {
  return `${prefix}${createId()}`;
};

/**
 * Type-safe ID factory that generates all ID-related utilities at once
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
  const factory = {
    /**
     * Creates a new ID with the specified prefix
     */
    create: (): TId => createPrefixedId(prefix) as TId,

    /**
     * Zod validation schema for the ID type
     * Uses refine instead of transform for better type safety
     */
    schema: z
      .string()
      .startsWith(prefix)
      .brand<TId>()
      .transform(id => id as TId),

    /**
     * Drizzle column helper for primary key columns
     * Automatically configures as varchar(256), not null, primary key, with proper type and default
     */
    primaryColumn: (name = 'id') =>
      varchar(name, { length: 256 })
        .notNull()
        .primaryKey()
        .$type<TId>()
        .$defaultFn(() => createPrefixedId(prefix) as TId),

    optionalColumn: (name: string) =>
      varchar(name, { length: 256 })
        .$type<TId | null>()
        .$defaultFn(() => null),

    requiredColumn: (name: string) =>
      varchar(name, { length: 256 })
        .notNull()
        .$type<TId>()
        .$defaultFn(() => createPrefixedId(prefix) as TId),

    /**
     * Drizzle column helper for foreign key reference columns
     * Configures as varchar(256), not null, with proper type (no default or primary key)
     */
    reference: (name: string) => varchar(name, { length: 256 }).notNull().$type<TId>(),

    /**
     * Drizzle column helper for optional foreign key reference columns
     * Configures as varchar(256), nullable, with proper type
     */
    optionalReference: (name: string) => varchar(name, { length: 256 }).$type<TId>(),

    /**
     * Drizzle column helper for foreign key reference with relation
     * Configures as varchar(256), not null, with proper type and foreign key constraint
     */
    foreignKey: (
      name: string,
      referenceFn: () => PgColumn,
      options?: { onDelete?: 'cascade' | 'restrict' | 'no action' | 'set null' | 'set default' },
    ) => varchar(name, { length: 256 }).notNull().$type<TId>().references(referenceFn, options),

    /**
     * Drizzle column helper for optional foreign key reference with relation
     * Configures as varchar(256), nullable, with proper type and foreign key constraint
     */
    optionalForeignKey: (
      name: string,
      referenceFn: () => PgColumn,
      options?: { onDelete?: 'cascade' | 'restrict' | 'no action' | 'set null' | 'set default' },
    ) => varchar(name, { length: 256 }).$type<TId>().references(referenceFn, options),

    /**
     * Creates a foreign key factory bound to a specific table
     * This allows creating multiple foreign keys to the same table without repeating the reference
     */
    createForeignKeyFactory: (referenceFn: () => PgColumn) => ({
      required: (
        name: string,
        options?: { onDelete?: 'cascade' | 'restrict' | 'no action' | 'set null' | 'set default' },
      ) => factory.foreignKey(name, referenceFn, options),
      optional: (
        name: string,
        options?: { onDelete?: 'cascade' | 'restrict' | 'no action' | 'set null' | 'set default' },
      ) => factory.optionalForeignKey(name, referenceFn, options),
    }),
  };

  return factory;
}

// Re-export drizzle and zod utilities
export * from 'drizzle-orm';
export * from 'drizzle-zod';
