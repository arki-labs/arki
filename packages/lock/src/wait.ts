/**
 * Waiting helpers: duration parsing, backoff, abort racing and the store-call
 * timeout. Portable: only `AbortSignal` and the `Scheduler` seam.
 */
import type { LockMethod } from './errors.js';
import type { Scheduler } from './scheduler.js';
import type { Duration } from './types.js';
import { LockError } from './errors.js';
import { defaultScheduler } from './scheduler.js';
import { durationSchema } from './types.js';

function noop(): void {
  // A late result is the caller's to handle; this only keeps it from being reported as unhandled.
}

const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;
const DURATION_TEXT = /^(\d+(?:\.\d+)?)(ms|[smh])$/;

/** A {@link Duration} in milliseconds. Throws `LockError{code:'config'}` for anything else. */
export function parseDuration(duration: Duration): number {
  const parsed = durationSchema.safeParse(duration);
  if (parsed.success) {
    if (typeof parsed.data === 'number') return parsed.data;
    const match = DURATION_TEXT.exec(parsed.data);
    const amount = match?.[1];
    const unit = match?.[2];
    if (amount !== undefined && (unit === 'ms' || unit === 's' || unit === 'm' || unit === 'h')) {
      return Number(amount) * UNIT_MS[unit];
    }
  }
  throw new LockError({
    code: 'config',
    message: `invalid duration ${JSON.stringify(duration)}`,
    remediation: "Use a non-negative number of milliseconds or a string like '250ms', '2s', '5m' or '1h'.",
  });
}

export const BACKOFF_FIRST_MS = 50;
export const BACKOFF_MAX_MS = 1000;

/**
 * Full-jitter backoff: a uniform delay in `[0, cap)`, with `cap` doubling from
 * 50 ms to 1 s. `attempt` counts from 0. `random` is injectable for tests.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, Math.min(attempt, 30)));
  return random() * cap;
}

function abortedError(signal: AbortSignal): LockError {
  return new LockError({
    code: 'aborted',
    message: 'the wait was aborted',
    remediation: 'Retry, or stop waiting on purpose.',
    cause: signal.reason,
  });
}

/**
 * Settle with `promise`, or reject with `LockError{code:'aborted'}` as soon as
 * `signal` aborts. The listener is removed either way. A late result of
 * `promise` is the caller's to clean up.
 */
export function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(noop);
    return Promise.reject(abortedError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortedError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        // The store's own reason passes through untouched; callers match on it.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(error);
      },
    );
  });
}

/**
 * Settle with `promise`, or reject with `LockError{code:'store', outcome:'unknown', method, timeoutMs}`
 * after `ms`. A call that timed out may still have taken the lock, so the
 * outcome is `unknown`, never "free". The caller decides what to do when
 * `promise` settles late; a late rejection is already handled here.
 */
export function withStoreTimeout<T>(
  promise: Promise<T>,
  ms: number,
  method: LockMethod,
  scheduler: Scheduler = defaultScheduler,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = scheduler.setTimeout(
      () => {
        reject(
          new LockError({
            code: 'store',
            message: `store ${method} did not answer within ${ms} ms`,
            remediation: 'Check the store, or raise storeTimeout. Ownership of the lock is unknown.',
            outcome: 'unknown',
            method,
            timeoutMs: ms,
          }),
        );
      },
      ms,
      { ref: true },
    );
    promise.then(
      value => {
        scheduler.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        scheduler.clearTimeout(timer);
        // The store's own reason passes through untouched; callers match on it.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(error);
      },
    );
  });
}
