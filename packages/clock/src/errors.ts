/**
 * Every failure this package raises on purpose is a {@link ClockError} with a
 * stable `code`. Match on the code, never on the message.
 */

/** Stable error codes of `@arki/clock`. */
export const CLOCK_ERROR_CODES = {
  /**
   * `MockClock.advance` or `advanceAsync` got a negative or non-finite number of milliseconds.
   *
   * @fix Pass a step that is zero or more. Use `setNow` to move the mock clock back.
   * @verify bun run test
   */
  invalidAdvance: 'ARKI_CLOCK_E001',
  /**
   * `setTimer` or `sleep` got a delay that is negative, not finite, or longer than a timer can hold.
   *
   * @fix Pass a finite delay from 0 up to `MAX_TIMER_MS` (about 24.8 days). Split a longer wait into steps.
   * @verify bun run test
   */
  invalidDelay: 'ARKI_CLOCK_E002',
  /**
   * A `sleep` was cut short by its `AbortSignal`. `cause` is `signal.reason`.
   *
   * @fix Catch `ClockError` with this code where you abort, or check `signal.aborted` before you sleep.
   * @verify bun run test
   */
  aborted: 'ARKI_CLOCK_E003',
} as const;

/** The code of a {@link ClockError}. */
export type ClockErrorCode = (typeof CLOCK_ERROR_CODES)[keyof typeof CLOCK_ERROR_CODES];

/** A coded failure of a clock. */
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
