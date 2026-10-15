/**
 * The type side of Standard Schema v1 (https://standardschema.dev), copied as
 * the spec invites so this package has no dependencies. Zod 4, Valibot and
 * ArkType schemas all satisfy it, so any of them can describe a failure's data.
 * This package never validates; boundaries such as oRPC do.
 */
export type StandardSchemaV1<Input = unknown, Output = Input> = {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => unknown;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
};

/** The type a schema accepts. */
export type SchemaInput<Schema extends StandardSchemaV1> = NonNullable<Schema['~standard']['types']>['input'];
