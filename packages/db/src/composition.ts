import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import type { SQLiteTransactionConfig } from 'drizzle-orm/sqlite-core';

import type { TransactionFailure } from './transaction.js';
import { runTransactionOnce } from './owned-transaction.js';
import { observeDbOperation } from './runtime-local-telemetry.js';

export const DB_COMPOSITION_ERROR_CODES = {
  /**
   * Two features export a schema entry under the same key, so one would hide the other.
   *
   * @fix Rename one table or relation export so each key is unique across features.
   * @verify bun run test -- src/composition.test.ts
   */
  duplicateSchemaKey: 'DB_COMPOSITION_E001',
  /**
   * A projection was declared without a name.
   *
   * @fix Pass a non-empty `name` when you declare the projection.
   * @verify bun run test -- src/composition.test.ts
   */
  projectionNameMissing: 'DB_COMPOSITION_E002',
  /**
   * A projection was declared without the events it reads.
   *
   * @fix List at least one event in the projection `events`.
   * @verify bun run test -- src/composition.test.ts
   */
  projectionEventsMissing: 'DB_COMPOSITION_E003',
  /**
   * Two features define a relation under the same key.
   *
   * @fix Rename one relation key so each is unique across features.
   * @verify bun run test -- src/merge-relations.test.ts
   */
  duplicateRelationKey: 'DB_COMPOSITION_E004',
} as const;

export class DbCompositionError extends Error {
  readonly code: (typeof DB_COMPOSITION_ERROR_CODES)[keyof typeof DB_COMPOSITION_ERROR_CODES];
  /** How to fix the declaration. Shown by `dot explain` when the import fails. */
  readonly remediation: string | undefined;

  constructor(args: {
    readonly code: (typeof DB_COMPOSITION_ERROR_CODES)[keyof typeof DB_COMPOSITION_ERROR_CODES];
    readonly message: string;
    readonly remediation?: string;
  }) {
    super(args.message);
    this.name = 'DbCompositionError';
    this.code = args.code;
    this.remediation = args.remediation;
  }
}

type SchemaSlice = Record<string, unknown>;

type UnionToIntersection<T> = (T extends unknown ? (value: T) => void : never) extends (value: infer I) => void
  ? I
  : never;

type DuplicateKeys<
  TSlices extends readonly SchemaSlice[],
  TSeen extends PropertyKey = never,
> = TSlices extends readonly [infer Head, ...infer Tail]
  ? Head extends SchemaSlice
    ? Tail extends readonly SchemaSlice[]
      ? (keyof Head & TSeen) | DuplicateKeys<Tail, TSeen | keyof Head>
      : keyof Head & TSeen
    : never
  : never;

type DuplicateSchemaError<TKeys extends PropertyKey> = {
  readonly 'ARKI_DB: duplicate schema keys': TKeys;
};

export type ComposedSchema<TSlices extends readonly SchemaSlice[]> = UnionToIntersection<TSlices[number]>;

export function composeSchema<const TSlices extends readonly SchemaSlice[]>(
  ...slices: DuplicateKeys<TSlices> extends never ? TSlices : readonly [DuplicateSchemaError<DuplicateKeys<TSlices>>]
): ComposedSchema<TSlices> {
  const seen = new Set<string>();
  const schema: SchemaSlice = {};

  for (const slice of slices as readonly SchemaSlice[]) {
    for (const key of Object.keys(slice)) {
      if (seen.has(key)) {
        throw new DbCompositionError({
          code: DB_COMPOSITION_ERROR_CODES.duplicateSchemaKey,
          message: `[db] schema key "${key}" is provided by more than one schema slice.`,
          remediation: 'Rename the table in one slice, or remove the slice that repeats it.',
        });
      }
      seen.add(key);
      schema[key] = slice[key];
    }
  }

  return schema as ComposedSchema<TSlices>;
}

/**
 * A database that can open a transaction: Drizzle's `db.transaction(fn, config)`,
 * on Postgres or SQLite. `config` is one object both dialects read: Postgres its
 * isolation level (`runTransaction` passes `serializable`), SQLite its `behavior`.
 * A `transaction` that takes either dialect's config, or none, fits.
 */
export type TransactionalDb<TTransaction> = {
  transaction<TResult>(
    fn: (tx: TTransaction) => Promise<TResult>,
    config?: TransactionConfig,
  ): Promise<TResult>;
};

/** A transaction config every dialect accepts: each driver reads its own keys. */
export type TransactionConfig = PgTransactionConfig & SQLiteTransactionConfig;

export type UnitOfWorkScopes<TFactories extends Record<string, (tx: never) => unknown>> = {
  readonly [K in keyof TFactories]: ReturnType<TFactories[K]>;
};

export type UnitOfWork<TScopes> = <TResult>(
  fn: (scopes: TScopes) => Promise<TResult> | TResult,
) => Promise<TResult | TransactionFailure>;

export function createUnitOfWork<TTransaction, const TFactories extends Record<string, (tx: TTransaction) => unknown>>(
  db: TransactionalDb<TTransaction>,
  factories: TFactories,
): UnitOfWork<{
  readonly [K in keyof TFactories]: ReturnType<TFactories[K]>;
}> {
  return fn =>
    observeDbOperation('db.unit_of_work', () =>
      runTransactionOnce(db, async tx => {
        const scopes: Record<string, unknown> = {};
        for (const [name, factory] of Object.entries(factories)) {
          scopes[name] = factory(tx);
        }
        return fn(scopes as { readonly [K in keyof TFactories]: ReturnType<TFactories[K]> });
      }),
    );
}
