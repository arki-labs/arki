/**
 * Running a schema. `parse` returns the schema's output or throws: a
 * {@link SchemaError} for bad data, a {@link SchemaRunError} when the schema
 * cannot be run (it is async, or its `validate` threw).
 */
import type { StandardSchemaV1 } from './types.js';
import { SCHEMA_ERROR_CODES, SchemaError, SchemaRunError } from './errors.js';

const THREW_REMEDIATION = 'Fix the schema: validate must return issues, never throw. The thrown value is the cause.';

/** Does nothing. Handles a rejection nobody will read. */
const ignore = (): void => undefined;

/** An async result. A sync result may carry a `then` field that is not a function; that is still sync. */
function isThenable<T extends object>(result: T | PromiseLike<T>): result is PromiseLike<T> {
  return 'then' in result && typeof result.then === 'function';
}

/**
 * The schema's output for `value`. Throws {@link SchemaError} when the value
 * does not match, and {@link SchemaRunError} when the schema is asynchronous
 * (`ARKI_SCHEMA_E001`) or its `validate` throws (`ARKI_SCHEMA_E002`).
 *
 * @example
 * const user = parse(UserSchema, JSON.parse(body));
 */
export function parse<Output>(schema: StandardSchemaV1<unknown, Output>, value: unknown): Output {
  const standard = schema['~standard'];
  let result: StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>>;
  try {
    result = standard.validate(value);
  } catch (error) {
    throw new SchemaRunError(
      SCHEMA_ERROR_CODES.validatorThrew,
      `the "${standard.vendor}" schema threw instead of returning a result`,
      THREW_REMEDIATION,
      { cause: error },
    );
  }
  if (isThenable(result)) {
    // The result is dropped; a rejection must not escape as an unhandled one.
    Promise.resolve(result).then(ignore, ignore);
    throw new SchemaRunError(
      SCHEMA_ERROR_CODES.asyncResult,
      `parse() got an asynchronous result from the "${standard.vendor}" schema`,
      'Use parseAsync() for a schema with asynchronous checks.',
    );
  }
  if (result.issues === undefined) return result.value;
  throw new SchemaError(result.issues);
}

/**
 * The schema's output for `value`, for sync and async schemas alike. Always
 * rejects, never throws: {@link SchemaError} for bad data, `ARKI_SCHEMA_E002`
 * when `validate` throws or rejects.
 *
 * @example
 * const user = await parseAsync(UserSchema, input);
 */
export async function parseAsync<Output>(schema: StandardSchemaV1<unknown, Output>, value: unknown): Promise<Output> {
  const standard = schema['~standard'];
  let result: StandardSchemaV1.Result<Output>;
  try {
    result = await standard.validate(value);
  } catch (error) {
    throw new SchemaRunError(
      SCHEMA_ERROR_CODES.validatorThrew,
      `the "${standard.vendor}" schema threw or rejected instead of returning a result`,
      THREW_REMEDIATION,
      { cause: error },
    );
  }
  if (result.issues === undefined) return result.value;
  throw new SchemaError(result.issues);
}
