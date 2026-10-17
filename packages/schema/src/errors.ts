/**
 * Two kinds of error, kept apart on purpose:
 *
 * - {@link SchemaError}: the value does not match the schema. Bad data.
 * - {@link SchemaRunError}: the schema could not be run as asked. A bug or a
 *   misuse, never bad data. Match on its `code`, never on the message.
 */
import type { StandardSchemaV1 } from './types.js';
import { formatIssues } from './issues.js';

/** Stable error codes of `@arki/schema`. */
export const SCHEMA_ERROR_CODES = {
  /**
   * `parse` got a Promise from `validate`: the schema is asynchronous.
   *
   * @fix Call `parseAsync` and await it.
   * @verify bun run test -- src/parse.test.ts
   */
  asyncResult: 'ARKI_SCHEMA_E001',
  /**
   * The schema's `validate` threw or rejected. The thrown value is the `cause`.
   *
   * @fix Fix the schema or its custom check. This is a bug in the validator, not bad data, so never answer it with a 400.
   * @verify bun run test -- src/parse.test.ts
   */
  validatorThrew: 'ARKI_SCHEMA_E002',
  /**
   * A `withJsonSchema` converter was asked for a target other than draft-2020-12.
   *
   * @fix Ask for the `draft-2020-12` target.
   * @verify bun run test -- src/vendors.test.ts
   */
  unsupportedTarget: 'ARKI_SCHEMA_E003',
} as const;

/** The code of a {@link SchemaRunError}. */
export type SchemaRunErrorCode = (typeof SCHEMA_ERROR_CODES)[keyof typeof SCHEMA_ERROR_CODES];

/** The schema could not be run as asked. Never means "the value is invalid". */
export class SchemaRunError extends Error {
  readonly code: SchemaRunErrorCode;
  /** What to do about it, in one sentence. */
  readonly remediation: string;

  constructor(code: SchemaRunErrorCode, message: string, remediation: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = 'SchemaRunError';
    this.code = code;
    this.remediation = remediation;
  }
}

/** The value does not match the schema. Same shape as `@standard-schema/utils`' `SchemaError`. */
export class SchemaError extends Error {
  /** What is wrong, as the schema reported it. */
  readonly issues: readonly StandardSchemaV1.Issue[];

  constructor(issues: readonly StandardSchemaV1.Issue[], options?: ErrorOptions) {
    super(formatIssues(issues), options);
    this.name = 'SchemaError';
    this.issues = issues;
  }
}
