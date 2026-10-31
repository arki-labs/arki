import type { SchemaWithJson, StandardJSONSchemaV1, StandardSchemaV1 } from '@arki/schema';

import { hasJsonSchema } from '@arki/schema';

import { ConfigurationError } from './errors.js';

/** The one JSON Schema dialect @arki/ai asks a schema for. */
const JSON_SCHEMA_TARGET = 'draft-2020-12';

/**
 * The schema, narrowed to one that can emit JSON Schema in `target` (default draft-2020-12).
 * Throws a loud error that names `where` and the fix when it cannot, or when its conversion fails.
 */
export function requireJsonSchema<Input, Output>(
  schema: StandardSchemaV1<Input, Output>,
  where: string,
  target: StandardJSONSchemaV1.Target = JSON_SCHEMA_TARGET,
): SchemaWithJson<Input, Output> {
  const fix = 'Wrap the schema with withJsonSchema() from @arki/schema, or use a schema library that can emit JSON Schema.';
  if (!hasJsonSchema(schema)) {
    throw new ConfigurationError(`${where}: the schema cannot produce JSON Schema for the model. ${fix}`);
  }
  try {
    schema['~standard'].jsonSchema.input({ target });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(`${where}: converting the schema to ${target} JSON Schema failed (${reason}). ${fix}`);
  }
  return schema;
}

/** The schema's input JSON Schema (what a model must write), or the loud error of {@link requireJsonSchema}. */
export function inputJsonSchema(schema: StandardSchemaV1, where: string) {
  return requireJsonSchema(schema, where)['~standard'].jsonSchema.input({ target: JSON_SCHEMA_TARGET });
}
