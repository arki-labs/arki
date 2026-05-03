import {
  createInsertSchema as drizzleCreateInsertSchema,
  createSelectSchema as drizzleCreateSelectSchema,
  createUpdateSchema as drizzleCreateUpdateSchema,
} from 'drizzle-orm/zod';
import type { BuildRefine } from 'drizzle-orm/zod';
import type { z } from 'zod/v4';
import type { InferInsertModel, InferSelectModel, Table } from 'drizzle-orm';

export {
  bufferSchema,
  createSchemaFactory,
  jsonSchema,
  literalSchema,
} from 'drizzle-orm/zod';
export * as formData from 'zod-form-data';
export * from 'zod/v4';

/**
 * Per-key Zod shape derived from a Drizzle table's inferred model.
 * Preserves branded `$type<>()` types and JSON shapes that drizzle-zod's
 * runtime extractor erases (it walks `dataType` strings, not the `_.data` phantom).
 *
 * Two subtleties make this mapping more involved than `[K in keyof T]: ZodType<T[K]>`:
 *
 *  1. The `-?` modifier strips the optional flag from source keys. If we left
 *     it, ZodObject would see `Shape['b']` as `ZodType<...> | undefined` and
 *     collapse the per-key inference to `unknown`.
 *  2. For source keys whose value type includes `undefined` (i.e. were optional),
 *     we wrap the ZodType in `ZodOptional` so Zod re-introduces optionality at
 *     parse time. We exclude `undefined` from the inner type so the parsed
 *     output is the actual value type.
 */
type StrongShape<TInferred> = {
  [K in keyof TInferred]-?: undefined extends TInferred[K]
    ? z.ZodOptional<
        z.ZodType<Exclude<TInferred[K], undefined>, Exclude<TInferred[K], undefined>>
      >
    : z.ZodType<TInferred[K], TInferred[K]>;
};

type StrongSchema<TInferred> = z.ZodObject<StrongShape<TInferred>, z.core.$strip>;

/**
 * Refine signature reused from drizzle-zod — accepts either a replacement
 * Zod schema or a callback that receives the auto-derived schema for that
 * column and returns a refined schema.
 */
type Refine<TTable extends Table> = BuildRefine<TTable['_']['columns'], Record<string, never>>;

/**
 * Build a select schema from a Drizzle table that preserves branded ID and
 * `jsonb('col').$type<Shape>()` typings.
 *
 * Runtime behavior matches drizzle-zod's `createSelectSchema` (including any
 * `refine` overrides). The TypeScript output type is widened to the table's
 * `InferSelectModel` shape, so:
 *
 *   - `id: varchar('id').$type<\`plan_\${string}\`>()` → `\`plan_\${string}\``
 *   - `metadata: jsonb('m').$type<MyShape>()` → `MyShape | null`
 *
 * If you need runtime validation for branded IDs, pass a `refine` with the
 * branded schema (e.g. `{ id: planIdSchema }`) — the runtime check kicks in
 * AND the type-level shape stays accurate.
 *
 * @example
 * const planSelectSchema = createSelectSchema(plans);
 * // z.infer<typeof planSelectSchema>['id'] is `plan_${string}`, not string.
 */
export function createSelectSchema<TTable extends Table>(
  table: TTable,
  refine?: Refine<TTable>,
): StrongSchema<InferSelectModel<TTable>> {
  return drizzleCreateSelectSchema(
    table as never,
    refine as never,
  ) as unknown as StrongSchema<InferSelectModel<TTable>>;
}

/**
 * Build an insert schema from a Drizzle table that preserves branded ID and
 * `jsonb('col').$type<Shape>()` typings.
 *
 * Same brand-preserving behavior as {@link createSelectSchema}, but for the
 * `InferInsertModel` shape — columns with defaults are optional, nullable
 * columns accept null.
 */
export function createInsertSchema<TTable extends Table>(
  table: TTable,
  refine?: Refine<TTable>,
): StrongSchema<InferInsertModel<TTable>> {
  return drizzleCreateInsertSchema(
    table as never,
    refine as never,
  ) as unknown as StrongSchema<InferInsertModel<TTable>>;
}

/**
 * Build an update schema from a Drizzle table — every column becomes optional
 * but otherwise preserves branded ID and `jsonb('col').$type<Shape>()` typings.
 */
export function createUpdateSchema<TTable extends Table>(
  table: TTable,
  refine?: Refine<TTable>,
): StrongSchema<Partial<InferInsertModel<TTable>>> {
  return drizzleCreateUpdateSchema(
    table as never,
    refine as never,
  ) as unknown as StrongSchema<Partial<InferInsertModel<TTable>>>;
}
