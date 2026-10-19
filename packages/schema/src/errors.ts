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
} as const;

/** The code of a {@link SchemaRunError}. */
export type SchemaRunErrorCode = (typeof SCHEMA_ERROR_CODES)[keyof typeof SCHEMA_ERROR_CODES];

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
