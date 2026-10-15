/**
 * Failures after JSON. A failure that went through a queue, a journal row or
 * a worker message is a plain object again: `isFailure` says no. `revive`
 * rebuilds it from the definitions you expect, and checks its data with their
 * schemas, because data from the wire is not trusted.
 */
import type { StandardSchemaV1 } from './standard-schema.js';
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

function validate(code: string, schema: StandardSchemaV1, data: unknown): unknown {
  const result = schema['~standard'].validate(data);
  if (result instanceof Promise) {
    throw new FailureError(
      FAILURE_ERROR_CODES.asyncSchema,
      `revive() got an asynchronous schema for "${code}"`,
      'Give failure data a synchronous schema; revive() runs where awaiting is not possible.',
    );
  }
  if (typeof result === 'object' && result !== null && 'issues' in result && Array.isArray(result.issues)) {
    throw new FailureError(
      FAILURE_ERROR_CODES.invalidData,
      `revive() got data for "${code}" that does not match its schema: ${describeIssues(result.issues)}`,
      'Check the producer and the consumer use the same definition, or migrate the stored data.',
    );
  }
  return typeof result === 'object' && result !== null && 'value' in result ? result.value : data;
}

function describeIssues(issues: readonly unknown[]): string {
  return issues
    .map(issue =>
      typeof issue === 'object' && issue !== null && 'message' in issue ? String(issue.message) : 'invalid',
    )
    .join('; ');
}
