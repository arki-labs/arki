/**
 * Job retries: a job's `retry` is a `Backoff` from `@arki/resilience`. BullMQ cannot
 * store a function in Redis, so every job asks for BullMQ's custom backoff, and the
 * job's worker answers it from the `Backoff`.
 */

import type { BackoffOptions } from 'bullmq';

import type { Backoff } from '@arki/resilience';
import { backoff } from '@arki/resilience';

/** The retry of a job that sets none: 2 retries (3 tries in all), 1 s and then 2 s apart. */
export const defaultJobRetry: Backoff = backoff.exponential({ base: 1000 }).upTo(2);

/** BullMQ's `attempts`: every try, the first one included. A backoff without a limit gets the largest safe count. */
export function jobAttempts(retry: Backoff): number {
  return Number.isFinite(retry.maxRetries) ? retry.maxRetries + 1 : Number.MAX_SAFE_INTEGER;
}

/** The job option that sends every retry to the worker's `backoffStrategy`. */
export const customJobBackoff: BackoffOptions = { type: 'custom' };

/**
 * The worker's `backoffStrategy`. BullMQ passes the number of failed tries, which is the
 * number of the retry about to run; `-1` tells it to stop and fail the job.
 */
export function workerBackoffStrategy(retry: Backoff): (attemptsMade: number, type?: string, error?: Error) => number {
  return (attemptsMade, _type, error) => retry.delay(attemptsMade, error) ?? -1;
}
