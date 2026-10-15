/**
 * Every failure this package raises on purpose is an {@link AsyncError} with a
 * stable `code`. Match on the code, never on the message.
 */

/** Stable error codes of `@arki/async`. */
export const ASYNC_ERROR_CODES = {
  /** A wait is negative, `NaN`, not finite, or above {@link MAX_WAIT_MS}. */
  invalidWait: 'ARKI_ASYNC_E001',
  /**
   * Work was cut short by its `AbortSignal` before it finished: a `sleep`, a
   * `scoped` body, or an `all` / `mapConcurrent` / `race` / `timeout` call.
   * `cause` is `signal.reason`.
   */
  aborted: 'ARKI_ASYNC_E002',
  /** One or more `scoped` finalizers threw. `errors` holds them; `cause` is the body error, if any. */
  cleanupFailed: 'ARKI_ASYNC_E003',
  /** A `timeout` deadline passed before the task finished. */
  timedOut: 'ARKI_ASYNC_E004',
  /** A `concurrency` limit is not a positive integer or `Infinity`. */
  invalidConcurrency: 'ARKI_ASYNC_E005',
} as const;

/** The code of an {@link AsyncError}. */
export type AsyncErrorCode = (typeof ASYNC_ERROR_CODES)[keyof typeof ASYNC_ERROR_CODES];

/** Longest wait a timer can hold: 2^31 - 1 ms (about 24.8 days). Larger values fire at once in most runtimes. */
export const MAX_WAIT_MS = 2_147_483_647;

/** A coded failure of any `@arki/async` helper. */
export class AsyncError extends Error {
  readonly code: AsyncErrorCode;
  /** What to do about it, in one sentence. */
  readonly remediation: string;
  /** The finalizer errors of an `ARKI_ASYNC_E003`, in the order the finalizers ran. Empty for every other code. */
  readonly errors: readonly unknown[];

  constructor(
    code: AsyncErrorCode,
    message: string,
    remediation: string,
    options?: { readonly cause?: unknown; readonly errors?: readonly unknown[] },
  ) {
    super(`${code}: ${message}`, options);
    this.name = 'AsyncError';
    this.code = code;
    this.remediation = remediation;
    this.errors = Object.freeze([...(options?.errors ?? [])]);
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

/** @internal E002: `what` was cut short by its signal; `cause` is the signal's reason. */
export function abortedError(what: string, reason: unknown): AsyncError {
  return new AsyncError(
    ASYNC_ERROR_CODES.aborted,
    `${what} was aborted before it finished`,
    'Catch AsyncError with code ARKI_ASYNC_E002 where you abort, or check signal.aborted before you start the work.',
    { cause: reason },
  );
}

/** @internal E003: finalizers threw; `cause` is the body error (undefined when the body succeeded). */
export function cleanupFailed(bodyError: unknown, errors: readonly unknown[]): AsyncError {
  return new AsyncError(
    ASYNC_ERROR_CODES.cleanupFailed,
    `scoped() cleanup failed: ${errors.length} finalizer${errors.length === 1 ? '' : 's'} threw`,
    'Read error.errors for each finalizer failure and error.cause for the body failure, then make the failing finalizer safe to run.',
    { cause: bodyError, errors },
  );
}

/** @internal E004: the `timeout` deadline of `ms` passed. */
export function timedOut(ms: number): AsyncError {
  return new AsyncError(
    ASYNC_ERROR_CODES.timedOut,
    `timeout() deadline of ${ms} ms passed before the task finished`,
    'Raise the deadline or speed up the task, and make the task honor its signal so it stops at the deadline.',
  );
}

/** @internal NaN, 0, negatives and fractions fail; `Infinity` means no limit. */
export function isValidConcurrency(value: unknown): value is number {
  return typeof value === 'number' && (value === Number.POSITIVE_INFINITY || (Number.isInteger(value) && value >= 1));
}

/** @internal E005: `concurrency` is not a positive integer or `Infinity`. */
export function invalidConcurrency(fn: string, value: unknown): AsyncError {
  return new AsyncError(
    ASYNC_ERROR_CODES.invalidConcurrency,
    `${fn}() needs concurrency to be a positive integer or Infinity, got ${String(value)}`,
    'Pass a whole number of at least 1, or Infinity (the default) for no limit.',
  );
}
