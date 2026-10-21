import type { StandardSchemaV1 } from './types.js';

/** JSON Schema converter errors. Validation failures are returned by `parse`. */
/** Stable error codes of `@arki/schema`. */
export const SCHEMA_ERROR_CODES = {
  /**
   * A `withJsonSchema` converter was asked for a target other than draft-2020-12.
   *
   * @fix Ask for the `draft-2020-12` target.
   * @verify bun run test -- src/vendors.test.ts
   */
  unsupportedTarget: 'ARKI_SCHEMA_E003',
  /**
   * `assert` or `ensure` got a value the schema rejects. The value is a bug in the caller, so it throws instead of returning a failure.
   *
   * @fix Read `issues` on the error, then fix the code that produced the value. Use `parse` where bad data is expected.
   * @verify bun run test -- src/assert.test.ts
   */
  assertFailed: 'ARKI_SCHEMA_E004',
  /**
   * `is`, `assert` or `ensure` got a schema that validates asynchronously. They are synchronous and cannot wait for it.
   *
   * @fix Use `parseAsync`, or a schema that validates synchronously.
   * @verify bun run test -- src/assert.test.ts
   */
  asyncAssert: 'ARKI_SCHEMA_E005',
} as const;

/** The code of a {@link SchemaRunError}. */
export type SchemaRunErrorCode = typeof SCHEMA_ERROR_CODES.unsupportedTarget;

/** The code of an {@link AssertError}. */
export type AssertErrorCode = typeof SCHEMA_ERROR_CODES.assertFailed | typeof SCHEMA_ERROR_CODES.asyncAssert;

/** A JSON Schema converter was asked for an unsupported target. */
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

/**
 * A value failed `assert` or `ensure`, or a schema could not run synchronously.
 * The message lists the issues with their paths. It never contains the value,
 * because asserted values are often secrets: `issues` holds redacted messages and plain-key paths.
 */
export class AssertError extends Error {
  readonly code: AssertErrorCode;
  /** The schema's issues, with the value redacted out of each message. Empty for `asyncAssert`. */
  readonly issues: readonly StandardSchemaV1.Issue[];
  /** What to do about it, in one sentence. */
  readonly remediation: string;

  constructor(
    code: AssertErrorCode,
    message: string,
    remediation: string,
    issues: readonly StandardSchemaV1.Issue[],
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = 'AssertError';
    this.code = code;
    this.remediation = remediation;
    this.issues = issues;
  }
}
