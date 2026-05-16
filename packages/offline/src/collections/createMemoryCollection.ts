import { createCollection, localOnlyCollectionOptions } from '@tanstack/react-db';
import type { Collection } from '@tanstack/db';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { InferSchemaOutput } from '@tanstack/db';

export interface MemoryCollectionConfig<
  TSchema extends StandardSchemaV1,
  TKey extends string | number = string,
> {
  schema: TSchema;
  getKey: (item: InferSchemaOutput<TSchema>) => TKey;
  initialData?: Array<InferSchemaOutput<TSchema>>;
}

/**
 * Creates an in-memory TanStack DB collection backed by `localOnlyCollectionOptions`.
 *
 * Data survives re-renders but not page reloads. Useful for ephemeral UI state that
 * benefits from reactive live-query semantics without any persistence overhead.
 *
 * Schema is required — same reason as `createLocalCollection`.
 */
export function createMemoryCollection<
  TSchema extends StandardSchemaV1,
  TKey extends string | number = string,
>(
  config: MemoryCollectionConfig<TSchema, TKey>,
): Collection<InferSchemaOutput<TSchema>, TKey> {
  const { schema, getKey, initialData } = config;

  return createCollection(
    localOnlyCollectionOptions({
      schema,
      getKey,
      ...(initialData !== undefined ? { initialData } : {}),
    }),
  );
}
