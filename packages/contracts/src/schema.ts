import { getColumns } from 'drizzle-orm';
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
 * Symbol used to tag a Drizzle column builder with its runtime validation
 * schema. Producers (like `@arki/db`'s ID factories) write to
 * `builder.config[COLUMN_ZOD_SCHEMA]` at column-construction time; this
 * package's `createSelectSchema`/`createInsertSchema`/`createUpdateSchema`
 * wrappers read it back and merge it into the refine map automatically.
 *
 * Using `Symbol.for(...)` keeps the symbol globally registered so any package
 * resolves to the same value, even with multiple module copies.
 */
export const COLUMN_ZOD_SCHEMA: unique symbol = Symbol.for('@arki/contracts/columnZodSchema') as never;

/**
 * Drizzle column-config side-channel where producers stash their Zod schema.
 * The same `config` object is shared between the builder and the constructed
 * column (see `PgVarcharBuilder.build` → `new PgVarchar(table, this.config)`),
 * so reading at column time recovers what was written at builder time.
 */
type ColumnConfigWithSchema = { config?: Record<string | symbol, unknown> };

function readColumnSchema(column: unknown): z.ZodTypeAny | undefined {
  const cfg = (column as ColumnConfigWithSchema)?.config;
  const schema = cfg?.[COLUMN_ZOD_SCHEMA];
  return schema && typeof schema === 'object' && '_zod' in (schema as object)
    ? (schema as z.ZodTypeAny)
    : undefined;
}

/**
 * Walk every column on `table`, look up the optional Zod schema each producer
 * stashed via `COLUMN_ZOD_SCHEMA`, and merge it into the user-provided refine.
 *
 * The schema is registered as a CALLBACK refinement (`(_) => schema`) so that
 * drizzle-zod's `HandleRefinement` correctly wraps `ZodNullable` around it for
 * nullable columns. A bare-schema refinement bypasses the nullability wrap and
 * would refuse `null` at runtime for nullable foreign keys.
 *
 * User-provided refines win over auto-derived ones, so explicit overrides on a
 * specific column always take priority.
 */
function autoRefine<TTable extends Table>(
  table: TTable,
  userRefine: Refine<TTable> | undefined,
): Refine<TTable> {
  const columns = getColumns(table);
  const refine: Record<string, unknown> = { ...(userRefine ?? {}) };
  for (const [key, column] of Object.entries(columns)) {
    if (key in refine) continue;
    const schema = readColumnSchema(column);
    if (schema) {
      refine[key] = (() => schema) as never;
    }
  }
  return refine as Refine<TTable>;
}

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
 * `jsonb('col').$type<Shape>()` typings AND auto-applies any runtime validation
 * schema producers stashed on the column via {@link COLUMN_ZOD_SCHEMA}.
 *
 * Runtime behavior matches drizzle-zod's `createSelectSchema` (including any
 * `refine` overrides) PLUS the auto-applied per-column schemas from `@arki/db`
 * ID factories — so `\`plan_\${string}\`` IDs are validated at parse time,
 * not just typed at compile time.
 *
 * The TypeScript output type is widened to the table's `InferSelectModel`
 * shape, so `z.infer<typeof schema>['id']` is `\`plan_\${string}\``, not `string`.
 *
 * @example
 * const planSelectSchema = createSelectSchema(plans);
 * planSelectSchema.parse({ id: 'wrong_prefix_xyz', ... }); // throws
 */
export function createSelectSchema<TTable extends Table>(
  table: TTable,
  refine?: Refine<TTable>,
): StrongSchema<InferSelectModel<TTable>> {
  return drizzleCreateSelectSchema(
    table as never,
    autoRefine(table, refine) as never,
  ) as unknown as StrongSchema<InferSelectModel<TTable>>;
}

/**
 * Build an insert schema from a Drizzle table that preserves branded ID and
 * `jsonb('col').$type<Shape>()` typings AND auto-applies any runtime validation
 * schema producers stashed on the column via {@link COLUMN_ZOD_SCHEMA}.
 */
export function createInsertSchema<TTable extends Table>(
  table: TTable,
  refine?: Refine<TTable>,
): StrongSchema<InferInsertModel<TTable>> {
  return drizzleCreateInsertSchema(
    table as never,
    autoRefine(table, refine) as never,
  ) as unknown as StrongSchema<InferInsertModel<TTable>>;
}

/**
 * Build an update schema from a Drizzle table — every column becomes optional
 * but otherwise preserves branded ID and `jsonb('col').$type<Shape>()` typings
 * AND auto-applies producer-stashed schemas.
 */
export function createUpdateSchema<TTable extends Table>(
  table: TTable,
  refine?: Refine<TTable>,
): StrongSchema<Partial<InferInsertModel<TTable>>> {
  return drizzleCreateUpdateSchema(
    table as never,
    autoRefine(table, refine) as never,
  ) as unknown as StrongSchema<Partial<InferInsertModel<TTable>>>;
}
