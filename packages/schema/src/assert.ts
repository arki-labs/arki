/** The throwing channel: `is`, `assert` and `ensure` run a schema and treat a rejection as a bug in the caller. */
import { AsyncSchema, InvalidInput, orThrow } from '@arki/failure';
import { executeSchema } from '@arki/failure/schema';

import type { StandardSchemaV1 } from './types.js';
import { AssertError, SCHEMA_ERROR_CODES } from './errors.js';
import { formatIssues, pathOf } from './issues.js';

/** How a failed `assert` or `ensure` describes itself. */
export type AssertOptions = {
  /** Replaces the default headline. A function is called only on failure. */
  readonly message?: string | (() => string);
  /** Names the value in the message, such as `"PORT"`. */
  readonly at?: string;
};

/** The value at `path`, or undefined when the path leaves the value. */
function valueAt(value: unknown, path: readonly PropertyKey[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

/** Replaces `text` in `message` only as a whole token, so `1` does not hit the `1` inside `10`. */
function redactToken(message: string, text: string): string {
  const escaped = text.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);
  return message.replaceAll(new RegExp(`(?<![\\w.])${escaped}(?!\\w|\\.\\d)`, 'g'), '[redacted]');
}

/**
 * The issue with a plain-key path and the offending primitive removed from its message.
 * A string is removed only in its quoted form (`"secret"`); a number or bigint only as a whole token.
 * Limit: a validator that prints a value unquoted may still leak it.
 */
function redact(issue: StandardSchemaV1.Issue, value: unknown): StandardSchemaV1.Issue {
  const path = pathOf(issue);
  const leaf = valueAt(value, path);
  const message =
    typeof leaf === 'string'
      ? issue.message.replaceAll(JSON.stringify(leaf), '"[redacted]"')
      : typeof leaf === 'number' || typeof leaf === 'bigint'
        ? redactToken(issue.message, String(leaf))
        : issue.message;
  return { message, path };
}

function rejected(value: unknown, rawIssues: readonly StandardSchemaV1.Issue[], options?: AssertOptions): AssertError {
  const issues = rawIssues.map(issue => redact(issue, value));
  const custom = typeof options?.message === 'function' ? options.message() : options?.message;
  const label = options?.at === undefined ? '' : `${options.at}: `;
  return new AssertError(
    SCHEMA_ERROR_CODES.assertFailed,
    `${label}${custom ?? 'value does not match the schema'} (${formatIssues(issues)})`,
    'Fix the code that produced this value. Use parse where bad data is expected.',
    issues,
  );
}

function needsAsync(options?: AssertOptions): AssertError {
  return new AssertError(
    SCHEMA_ERROR_CODES.asyncAssert,
    `${options?.at === undefined ? '' : `${options.at}: `}the schema validates asynchronously, but is/assert/ensure are synchronous`,
    'Use parseAsync, or a schema that validates synchronously.',
    [],
  );
}

/**
 * True when `value` matches the schema. It is a guard, so a rejected value is `false`, never a throw.
 * An async schema throws `ARKI_SCHEMA_E005` instead of answering `false`, because `false` would
 * silently mean "invalid" for data that may be fine.
 *
 * @example
 * if (is(input, Port)) listen(input);
 */
export function is<Schema extends StandardSchemaV1>(
  value: unknown,
  schema: Schema,
): value is StandardSchemaV1.InferInput<Schema> {
  const result = executeSchema(schema, value);
  if (InvalidInput.is(result)) return false;
  if (AsyncSchema.is(result)) throw needsAsync();
  orThrow(result);
  return true;
}

/**
 * Throw `AssertError` unless `value` matches the schema, and narrow the variable to the schema's
 * input type. It never transforms: use {@link ensure} for the output. A rejection is a bug in the
 * caller (`ARKI_SCHEMA_E004`); use `parse` where bad data is expected.
 *
 * @example
 * assert(config, ConfigSchema, { at: 'config' });
 */
export function assert<Schema extends StandardSchemaV1>(
  value: unknown,
  schema: Schema,
  options?: AssertOptions,
): asserts value is StandardSchemaV1.InferInput<Schema> {
  const result = executeSchema(schema, value);
  if (InvalidInput.is(result)) throw rejected(value, result.data.issues, options);
  if (AsyncSchema.is(result)) throw needsAsync(options);
  orThrow(result);
}

/**
 * The schema's output, or `AssertError`: a throwing `parse`.
 *
 * @example
 * const port = ensure(process.env.PORT, z.coerce.number(), { at: 'PORT' });
 */
export function ensure<Schema extends StandardSchemaV1>(
  value: unknown,
  schema: Schema,
  options?: AssertOptions,
): StandardSchemaV1.InferOutput<Schema> {
  const result = executeSchema(schema, value);
  if (InvalidInput.is(result)) throw rejected(value, result.data.issues, options);
  if (AsyncSchema.is(result)) throw needsAsync(options);
  return orThrow(result).value;
}
