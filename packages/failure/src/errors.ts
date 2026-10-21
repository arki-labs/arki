/**
 * Mistakes in how this package is used are thrown as a {@link FailureError}
 * with a stable `code`. Match on the code, never on the message.
 *
 * These are bugs in the calling code (a bad status, a missing handler), so
 * they are thrown, not returned. Expected failures are what `defineFailure` is for.
 */

/** Stable error codes of `@arki/failure`. */
export const FAILURE_ERROR_CODES = {
  /**
   * `defineFailure` got an empty code, or the reserved code `ok`.
   *
   * @fix Give the failure a non-empty dotted code such as `post.not_found`, and not `ok`.
   * @verify bun run test -- src/failure.test.ts
   */
  invalidCode: 'ARKI_FAILURE_E001',
  /**
   * `defineFailure` got a status that is not an integer from 400 to 599.
   *
   * @fix Pass an integer status from 400 to 599, or leave `status` out for the default 400.
   * @verify bun run test -- src/failure.test.ts
   */
  invalidStatus: 'ARKI_FAILURE_E002',
  /**
   * `match` met a failure code it has no handler for. The types stop this, so it happens only when they were bypassed.
   *
   * @fix Add a handler for the code to `match`, or fix the cast that hid it from the compiler.
   * @verify bun run test -- src/handle.test.ts
   */
  unhandledFailure: 'ARKI_FAILURE_E003',
  /**
   * `unreachable` was reached, so a value the types said could not happen did happen (often bad data from outside).
   *
   * @fix Handle the new case in the `switch`, or validate the data at the boundary.
   * @verify bun run test -- src/handle.test.ts
   */
  unreachable: 'ARKI_FAILURE_E004',
  /**
   * Two definitions with the same code were given where codes must be unique.
   *
   * @fix Give each definition its own code, or pass the definition only once.
   * @verify bun run test -- src/orpc.test.ts
   */
  duplicateCode: 'ARKI_FAILURE_E005',
  /**
   * @deprecated Retired: revival now returns InvalidEnvelope with reason invalid_data.
   *
   * @fix Check the stored data against the schema. A schema that transforms its input cannot read its own output.
   * @verify bun run test -- src/revive.test.ts
   */
  invalidData: 'ARKI_FAILURE_E006',
  /**
   * @deprecated Retired: revival now returns AsyncSchema.
   *
   * @fix Use a schema that validates synchronously for failure data.
   * @verify bun run test -- src/revive.test.ts
   */
  asyncSchema: 'ARKI_FAILURE_E007',
  /**
   * An `invariant` condition was falsy, so code relied on something that is not true.
   *
   * @fix Find the caller that broke the assumption and fix it; do not catch this error.
   * @verify bun run test -- src/handle.test.ts
   */
  invariant: 'ARKI_FAILURE_E008',
} as const;

/** The code of a {@link FailureError}. */
export type FailureErrorCode = (typeof FAILURE_ERROR_CODES)[keyof typeof FAILURE_ERROR_CODES];

/** A coded mistake in how `@arki/failure` is used. */
export class FailureError extends Error {
  readonly code: FailureErrorCode;
  /** What to do about it, in one sentence. */
  readonly remediation: string;

  constructor(code: FailureErrorCode, message: string, remediation: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = 'FailureError';
    this.code = code;
    this.remediation = remediation;
  }
}
