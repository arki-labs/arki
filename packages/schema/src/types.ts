/**
 * The Standard Schema types (https://standardschema.dev). This is the only
 * file in the monorepo that imports `@standard-schema/spec`; everything else
 * imports these types from `@arki/schema`.
 */
import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';

export type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';

/** The type a schema accepts. */
export type SchemaInput<Schema extends StandardSchemaV1> = StandardSchemaV1.InferInput<Schema>;

/** The type a schema returns after validation. */
export type SchemaOutput<Schema extends StandardSchemaV1> = StandardSchemaV1.InferOutput<Schema>;

/** A Standard Schema that can also describe itself as JSON Schema. */
export type SchemaWithJson<Input = unknown, Output = Input> = StandardSchemaV1<Input, Output> &
  StandardJSONSchemaV1<Input, Output>;
