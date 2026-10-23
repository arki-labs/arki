/** Dialect-free helpers shared by the pg and SQLite `idColumns`. */
import type { z } from '@arki/contracts';
import { CONTRACTS_ERROR_CODES, ContractsError } from '@arki/contracts';
import { COLUMN_ZOD_SCHEMA } from '@arki/contracts/drizzle';

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
export function tagColumnSchema<TBuilder extends object>(builder: TBuilder, schema: z.ZodType): TBuilder {
  const config: unknown = Reflect.get(builder, 'config');
  if (typeof config !== 'object' || config === null) {
    throw new ContractsError(CONTRACTS_ERROR_CODES.invalidColumnMetadata, 'The Drizzle builder has no column config.');
  }
  Object.assign(config, { [COLUMN_ZOD_SCHEMA]: schema });
  return builder;
}

export type OnDelete = 'cascade' | 'restrict' | 'no action' | 'set null' | 'set default';
