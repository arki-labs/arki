import type { SchemaOutput, StandardSchemaV1 } from '@arki/schema';
import { InvalidInput, orThrow } from '@arki/failure';
import { formatIssues, parse, pathOf } from '@arki/schema';

import { ValidationError } from '../errors.js';

/**
 * Check a provider service's own config, throwing `ValidationError` with field paths when it is wrong.
 * Internal: a bad service config is a caller bug found at construction. Outside values go through
 * `parse` from `@arki/schema`, which returns `InvalidInput`. A schema that cannot run synchronously
 * crosses this throwing adapter through `orThrow`.
 */
export function validateInput<S extends StandardSchemaV1>(
  schema: S,
  input: unknown,
  errorMessage?: string,
): SchemaOutput<S> {
  const result = parse(schema, input);
  if (!InvalidInput.is(result)) return orThrow(result);
  throw new ValidationError(
    errorMessage || `Input validation failed: ${formatIssues(result.data.issues)}`,
    result.data.issues.map(issue => ({ field: pathOf(issue).map(String).join('.'), message: issue.message })),
  );
}
