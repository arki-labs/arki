/**
 * Mistakes in how this package is used are thrown as a {@link FailureError}
 * with a stable `code`. Match on the code, never on the message.
 *
 * These are bugs in the calling code (a bad status, a missing handler), so
 * they are thrown, not returned. Expected failures are what `defineFailure` is for.
 */

/** Stable error codes of `@arki/failure`. */
export const FAILURE_ERROR_CODES = {
  /** `defineFailure` got an empty code, or the reserved code `ok`. */
  invalidCode: 'ARKI_FAILURE_E001',
  /** `defineFailure` got a status that is not an integer from 400 to 599. */
  invalidStatus: 'ARKI_FAILURE_E002',
  /** `match` met a failure code it has no handler for. */
  unhandledFailure: 'ARKI_FAILURE_E003',
  /** `assertNever` was reached. */
  unreachable: 'ARKI_FAILURE_E004',
  /** Two definitions with the same code were given where codes must be unique. */
  duplicateCode: 'ARKI_FAILURE_E005',
  /** `revive` found a failure whose data does not match its definition's schema. */
  invalidData: 'ARKI_FAILURE_E006',
  /** `revive` got a schema that validates asynchronously. */
  asyncSchema: 'ARKI_FAILURE_E007',
} as const;

/** The code of a {@link FailureError}. */
export type FailureErrorCode = (typeof FAILURE_ERROR_CODES)[keyof typeof FAILURE_ERROR_CODES];

/** A coded mistake in how `@arki/failure` is used. */
export class FailureError extends Error {
  readonly code: FailureErrorCode;
  /** What to do about it, in one sentence. */
  readonly remediation: string;

  constructor(code: FailureErrorCode, message: string, remediation: string) {
    super(`${code}: ${message}`);
    this.name = 'FailureError';
    this.code = code;
    this.remediation = remediation;
  }
}
