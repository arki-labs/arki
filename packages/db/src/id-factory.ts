import { createId as createCuid } from '@paralleldrive/cuid2';
import { varchar } from 'drizzle-orm/pg-core';
import { z } from 'zod';

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
 *   id: poetId.column(),
 *   // ... other columns
 * });
 * ```
 */
export function createIdFactory<TPrefix extends string, TId extends `${TPrefix}${string}`>(
  prefix: TPrefix
) {
  return {
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
      .transform((id) => id as TId),

    /**
     * Drizzle column helper for primary key columns
     * Automatically configures as varchar(256), not null, primary key, with proper type and default
     */
    column: (name = 'id') => varchar(name, { length: 256 })
      .notNull()
      .primaryKey()
      .$type<TId>()
      .$defaultFn(() => createPrefixedId(prefix) as TId),

    /**
     * Drizzle column helper for foreign key reference columns
     * Configures as varchar(256), not null, with proper type (no default or primary key)
     */
    reference: (name: string) => varchar(name, { length: 256 })
      .notNull()
      .$type<TId>(),

    /**
     * Drizzle column helper for optional foreign key reference columns
     * Configures as varchar(256), nullable, with proper type
     */
    optionalReference: (name: string) => varchar(name, { length: 256 })
      .$type<TId>(),
  };
}

// Re-export drizzle and zod utilities
export * from 'drizzle-orm';
export * from 'drizzle-zod';
