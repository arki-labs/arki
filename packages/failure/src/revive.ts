/**
 * Failures after JSON. A failure that went through a queue, a journal row or
 * a worker message is a plain object again: `isFailure` says no. `revive`
 * rebuilds it from the definitions you expect, and checks its data with their
 * schemas, because data from the wire is not trusted.
 */
import type { StandardSchemaV1 } from '@arki/schema';
import { parse, SCHEMA_ERROR_CODES, SchemaError, SchemaRunError } from '@arki/schema';

import { FAILURE_ERROR_CODES, FailureError } from './errors.js';

/** The parts of a definition `revive` needs. */
type Revivable = {
  readonly code: string;
  readonly dataSchema: StandardSchemaV1 | undefined;
  (...args: never[]): unknown;
};

/** The implementation's view of a definition: the overload above keeps the precise types. */
type LooseRevivable = {
  readonly code: string;
  readonly dataSchema: StandardSchemaV1 | undefined;
  (...args: unknown[]): unknown;
};

/**
 * The live failure `value` stands for, when it is one of `definitions`
 * (matched by `code`); `undefined` for anything else. Data that does not match
 * the definition's schema throws `ARKI_FAILURE_E006`.
 *
 * @example
 * const failure = revive(JSON.parse(message), [PostNotFound, EmailTaken]);
 * if (failure) return match(failure, { ok: …, 'post.not_found': …, 'user.email_taken': … });
 */
export function revive<const Definitions extends readonly Revivable[]>(
  value: unknown,
  definitions: Definitions,
): ReturnType<Definitions[number]> | undefined;
export function revive(value: unknown, definitions: readonly LooseRevivable[]): unknown {
  if (typeof value !== 'object' || value === null || !('code' in value)) return undefined;
  const definition = definitions.find(candidate => candidate.code === value.code);
  if (definition === undefined) return undefined;
  if (definition.dataSchema === undefined) return definition();
  const data = 'data' in value ? value.data : undefined;
  return definition(validate(definition.code, definition.dataSchema, data));
}

/**
 * The schema's output for `data`. Bad data becomes `ARKI_FAILURE_E006` and an
 * async schema `ARKI_FAILURE_E007`, each with the schema error as `cause`. A
 * validator that throws is a bug, not bad data: its `SchemaRunError` passes through.
 */
function validate(code: string, schema: StandardSchemaV1, data: unknown): unknown {
  try {
    return parse(schema, data);
  } catch (error) {
    if (error instanceof SchemaError) {
      throw new FailureError(
        FAILURE_ERROR_CODES.invalidData,
        `revive() got data for "${code}" that does not match its schema: ${error.message}`,
        'Check the producer and the consumer use the same definition, or migrate the stored data.',
        { cause: error },
      );
    }
    if (error instanceof SchemaRunError && error.code === SCHEMA_ERROR_CODES.asyncResult) {
      throw new FailureError(
        FAILURE_ERROR_CODES.asyncSchema,
        `revive() got an asynchronous schema for "${code}"`,
        'Give failure data a synchronous schema; revive() runs where awaiting is not possible.',
        { cause: error },
      );
    }
    throw error;
  }
}
