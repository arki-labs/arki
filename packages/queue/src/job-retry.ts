/**
 * Job retries: a job's `retry` is a `Backoff` from `@arki/resilience`. BullMQ cannot
 * store a function in Redis, so every job asks for BullMQ's custom backoff, and the
 * job's worker answers it from the `Backoff`.
 *
 * A handler that returns a failure from `@arki/failure` fails its job. BullMQ fails only
 * a job that throws, so the worker throws a `ReturnedFailureError` carrying the failure,
 * and the backoff judges the failure itself: by default it is not retried.
 */

import type { BackoffOptions } from 'bullmq';

import type { Failure } from '@arki/failure';
import type { Backoff } from '@arki/resilience';
import { isFailure, UnexpectedFailure } from '@arki/failure';
import { backoff } from '@arki/resilience';

/** The retry of a job that sets none: 2 retries (3 tries in all), 1 s and then 2 s apart. */
export const defaultJobRetry: Backoff = backoff.exponential({ base: 1000 }).upTo(2);

/** BullMQ's `attempts`: every try, the first one included. A backoff without a limit gets the largest safe count. */
export function jobAttempts(retry: Backoff): number {
  return Number.isFinite(retry.maxRetries) ? retry.maxRetries + 1 : Number.MAX_SAFE_INTEGER;
}

/** The job option that sends every retry to the worker's `backoffStrategy`. */
export const customJobBackoff: BackoffOptions = { type: 'custom' };

/** Only public fields cross persisted/provider boundaries; private causes stay in process. */
export function jobFailureEnvelope<F extends Failure>(failure: F) {
  return {
    code: failure.code,
    status: failure.status,
    message: failure.message,
    data: failure.data,
    ...(failure.remediation === undefined ? {} : { remediation: failure.remediation }),
  };
}

/**
 * A job whose handler returned a failure. The message is the failure as JSON, so BullMQ's
 * `failedReason`, the board and the foreman keep its code, message, status and data.
 */
export class ReturnedFailureError<F extends Failure = Failure> extends Error {
  readonly failure: F;

  constructor(failure: F) {
    super(JSON.stringify(jobFailureEnvelope(failure)));
    this.name = 'ReturnedFailureError';
    this.failure = failure;
  }
}

/** Throws a `ReturnedFailureError` when a handler's result is a failure, so its job fails. */
export function throwIfReturnedFailure(result: unknown): void {
  if (isFailure(result)) throw new ReturnedFailureError(result);
}

/**
 * The worker's `backoffStrategy`. BullMQ passes the number of failed tries, which is the
 * number of the retry about to run; `-1` tells it to stop and fail the job. A returned
 * failure reaches the backoff as the failure, not as the error that carried it.
 */
export function workerBackoffStrategy(retry: Backoff): (attemptsMade: number, type?: string, error?: Error) => number {
  return (attemptsMade, _type, error) =>
    retry.delay(
      attemptsMade,
      error instanceof ReturnedFailureError || error instanceof UnexpectedFailure ? error.failure : error,
    ) ?? -1;
}
