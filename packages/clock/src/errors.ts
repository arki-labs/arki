/**
 * Every failure this package raises on purpose is a {@link ClockError} with a
 * stable `code`. Match on the code, never on the message.
 */

/** Stable error codes of `@arki/clock`. */
export const CLOCK_ERROR_CODES = {
  /** `MockClock.advance` got a negative or non-finite number of milliseconds. */
  invalidAdvance: 'ARKI_CLOCK_E001',
} as const;

/** The code of a {@link ClockError}. */
export type ClockErrorCode = (typeof CLOCK_ERROR_CODES)[keyof typeof CLOCK_ERROR_CODES];

/** A coded failure of `MockClock`. */
export class ClockError extends Error {
  readonly code: ClockErrorCode;
  /** What to do about it, in one sentence. */
  readonly remediation: string;

  constructor(code: ClockErrorCode, message: string, remediation: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = 'ClockError';
    this.code = code;
    this.remediation = remediation;
  }
}
