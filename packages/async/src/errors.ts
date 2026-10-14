/**
 * Every failure this package raises on purpose is an {@link AsyncError} with a
 * stable `code`. Match on the code, never on the message.
 */

/** Stable error codes of `@arki/async`. */
export const ASYNC_ERROR_CODES = {
  /** A wait is negative, `NaN`, not finite, or above {@link MAX_WAIT_MS}. */
  invalidWait: 'ARKI_ASYNC_E001',
  /** A `sleep` was cut short by its `AbortSignal`. */
  aborted: 'ARKI_ASYNC_E002',
} as const;

/** The code of an {@link AsyncError}. */
export type AsyncErrorCode = (typeof ASYNC_ERROR_CODES)[keyof typeof ASYNC_ERROR_CODES];

/** Longest wait a timer can hold: 2^31 - 1 ms (about 24.8 days). Larger values fire at once in most runtimes. */
export const MAX_WAIT_MS = 2_147_483_647;

/** A coded failure of `sleep`, `debounce` or `throttle`. */
export class AsyncError extends Error {
  readonly code: AsyncErrorCode;
  /** What to do about it, in one sentence. */
  readonly remediation: string;

  constructor(code: AsyncErrorCode, message: string, remediation: string, options?: { readonly cause?: unknown }) {
    super(`${code}: ${message}`, options);
    this.name = 'AsyncError';
    this.code = code;
    this.remediation = remediation;
  }
}

/** @internal Throws E001 unless `value` is a finite number from 0 to {@link MAX_WAIT_MS}. */
export function assertWait(fn: string, name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !isValidWait(value)) throw invalidWait(fn, name, value);
}

/** @internal NaN fails both comparisons, so it is rejected too. */
export function isValidWait(value: unknown): boolean {
  return typeof value === 'number' && value >= 0 && value <= MAX_WAIT_MS;
}

/** @internal */
export function invalidWait(fn: string, name: string, value: unknown): AsyncError {
  return new AsyncError(
    ASYNC_ERROR_CODES.invalidWait,
    `${fn}() needs ${name} to be a number from 0 to ${MAX_WAIT_MS} milliseconds, got ${String(value)}`,
    `Pass a finite ${name} between 0 and ${MAX_WAIT_MS}. For longer waits, schedule again when the timer fires.`,
  );
}
