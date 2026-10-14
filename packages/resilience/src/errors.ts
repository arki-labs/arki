/** Stable error codes of `@arki/resilience`. Match on the code, never on the message. */
export const RESILIENCE_ERROR_CODES = {
  /** The circuit breaker is open and rejected the call. */
  circuitOpen: 'ARKI_RESILIENCE_E001',
  /** A timeout policy reached its deadline. */
  timeout: 'ARKI_RESILIENCE_E002',
  /** The caller's own signal aborted the call. */
  cancelled: 'ARKI_RESILIENCE_E003',
  /** A bulkhead had no free execution or queue slot. */
  bulkheadRejected: 'ARKI_RESILIENCE_E004',
  /** Every retry attempt failed. */
  retriesExhausted: 'ARKI_RESILIENCE_E005',
} as const;

/** The code of a {@link ResilienceError}. */
export type ResilienceErrorCode = (typeof RESILIENCE_ERROR_CODES)[keyof typeof RESILIENCE_ERROR_CODES];

/** Base class of every error the policies raise themselves. Errors thrown by your function pass through untouched. */
export abstract class ResilienceError extends Error {
  /** Stable machine-readable code, `ARKI_RESILIENCE_E<nnn>`. */
  abstract readonly code: ResilienceErrorCode;
  /** What to do about it, in one sentence. */
  abstract readonly remediation: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The circuit breaker is open: the call was rejected without running the function. */
export class CircuitOpenError extends ResilienceError {
  readonly code = RESILIENCE_ERROR_CODES.circuitOpen;
  readonly remediation = 'Wait for the breaker to half-open and try again, or serve a fallback while it is open.';

  constructor(message = 'Circuit breaker is open', options?: ErrorOptions) {
    super(message, options);
    this.name = 'CircuitOpenError';
  }
}

/** A timeout policy reached its deadline before the function returned. */
export class TimeoutError extends ResilienceError {
  readonly code = RESILIENCE_ERROR_CODES.timeout;
  readonly remediation = 'Raise the timeout, or make the operation faster.';

  constructor(message = 'Operation timed out', options?: ErrorOptions) {
    super(message, options);
    this.name = 'TimeoutError';
  }
}

/** The caller's own signal aborted while the call was in flight. `cause` is the signal's reason. */
export class CancelledError extends ResilienceError {
  readonly code = RESILIENCE_ERROR_CODES.cancelled;
  readonly remediation = 'Check signal.aborted before you start, or catch CancelledError where you abort.';

  constructor(message = 'Operation cancelled', options?: ErrorOptions) {
    super(message, options);
    this.name = 'CancelledError';
  }
}

/** A bulkhead turned the call away: every execution slot and queue slot was taken. */
export class BulkheadRejectedError extends ResilienceError {
  readonly code = RESILIENCE_ERROR_CODES.bulkheadRejected;
  readonly remediation = 'Retry later, raise the bulkhead limits, or shed load before the call.';

  constructor(message = 'Bulkhead capacity exceeded', options?: ErrorOptions) {
    super(message, options);
    this.name = 'BulkheadRejectedError';
  }
}

/**
 * Thrown when all retry attempts have been exhausted without a successful result.
 */
export class RetriesExhaustedError extends ResilienceError {
  readonly code = RESILIENCE_ERROR_CODES.retriesExhausted;
  readonly remediation = 'Read lastError for the real cause, or raise the attempt limit.';

  public readonly attempts: number;
  public readonly lastError: Error | undefined;

  constructor(attempts: number, lastError?: Error) {
    super(`All ${attempts} retry attempts exhausted${lastError ? `: ${lastError.message}` : ''}`, {
      cause: lastError,
    });
    this.name = 'RetriesExhaustedError';
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

/** True for every error raised by the resilience layer itself. */
export function isResilienceError(error: unknown): error is ResilienceError {
  return error instanceof ResilienceError;
}

export function isBrokenCircuitError(error: unknown): error is CircuitOpenError {
  return error instanceof CircuitOpenError;
}

export function isBulkheadRejectedError(error: unknown): error is BulkheadRejectedError {
  return error instanceof BulkheadRejectedError;
}
