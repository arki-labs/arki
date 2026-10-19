/** Minimal Standard Schema execution shared by schema parsing and failure revival. */
import type { StandardSchemaV1 } from '@standard-schema/spec';

import type { FailureOf } from './failure.js';
import { isFailure } from './failure.js';
import { AsyncSchema, InvalidInput, ValidatorDefect } from './foundations.js';
import { executeSchema, executeSchemaAsync } from './schema-executor.js';

/** Validation definitions for boundaries that expose schema parsing to their callers. */
export const SCHEMA_FAILURES = [InvalidInput, AsyncSchema, ValidatorDefect] as const;

/** The schema's output, or an invalid-input, async-schema or validator-defect failure. */
export function parse<Output>(schema: StandardSchemaV1<unknown, Output>, value: unknown) {
  const result = executeSchema(schema, value);
  return isFailure(result) ? result : result.value;
}

/** The schema's output, or an invalid-input or validator-defect failure. */
export async function parseAsync<Output>(schema: StandardSchemaV1<unknown, Output>, value: unknown) {
  const result = await executeSchemaAsync(schema, value);
  return isFailure(result) ? result : result.value;
}

/** The exact failures a synchronous schema parse can return. */
export type SchemaFailure = FailureOf<typeof parse<never>>;

/** The exact failures an asynchronous schema parse can return. */
export type AsyncSchemaFailure = FailureOf<typeof parseAsync<never>>;

/** True only for the canonical failures returned by synchronous schema parsing. */
export function isSchemaFailure(value: unknown): value is SchemaFailure {
  return SCHEMA_FAILURES.some(definition => definition.is(value));
}

/** True only for the canonical failures returned by asynchronous schema parsing. */
export function isAsyncSchemaFailure(value: unknown): value is AsyncSchemaFailure {
  return InvalidInput.is(value) || ValidatorDefect.is(value);
}
