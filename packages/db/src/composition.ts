export const DB_COMPOSITION_ERROR_CODES = {
  duplicateSchemaKey: 'DB_COMPOSITION_E001',
} as const;

export class DbCompositionError extends Error {
  readonly code: (typeof DB_COMPOSITION_ERROR_CODES)[keyof typeof DB_COMPOSITION_ERROR_CODES];

  constructor(args: {
    readonly code: (typeof DB_COMPOSITION_ERROR_CODES)[keyof typeof DB_COMPOSITION_ERROR_CODES];
    readonly message: string;
  }) {
    super(args.message);
    this.name = 'DbCompositionError';
    this.code = args.code;
  }
}

type SchemaSlice = Record<string, unknown>;

type UnionToIntersection<T> = (T extends unknown ? (value: T) => void : never) extends (value: infer I) => void
  ? I
  : never;

type DuplicateKeys<TSlices extends readonly SchemaSlice[], TSeen extends PropertyKey = never> = TSlices extends readonly [
  infer Head,
  ...infer Tail,
]
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
        });
      }
      seen.add(key);
      schema[key] = slice[key];
    }
  }

  return schema as ComposedSchema<TSlices>;
}

export type TransactionalDb<TTransaction> = {
  transaction<TResult>(fn: (tx: TTransaction) => Promise<TResult>): Promise<TResult>;
};

export type UnitOfWorkScopes<TFactories extends Record<string, (tx: never) => unknown>> = {
  readonly [K in keyof TFactories]: ReturnType<TFactories[K]>;
};

export type UnitOfWork<TScopes> = <TResult>(
  fn: (scopes: TScopes) => Promise<TResult> | TResult,
) => Promise<TResult>;

export function createUnitOfWork<
  TTransaction,
  const TFactories extends Record<string, (tx: TTransaction) => unknown>,
>(
  db: TransactionalDb<TTransaction>,
  factories: TFactories,
): UnitOfWork<{
  readonly [K in keyof TFactories]: ReturnType<TFactories[K]>;
}> {
  return async fn =>
    db.transaction(async tx => {
      const scopes: Record<string, unknown> = {};
      for (const [name, factory] of Object.entries(factories)) {
        scopes[name] = factory(tx);
      }
      return fn(scopes as { readonly [K in keyof TFactories]: ReturnType<TFactories[K]> });
    });
}
