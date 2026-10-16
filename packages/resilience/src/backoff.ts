// One retry schedule for every package that retries: the resilience policies, `@arki/queue`
// jobs and `@arki/journal` effects all take the same `Backoff` value.

import { MAX_TIMER_MS } from '@arki/clock';

import { InvalidBackoffError } from './errors.js';

/**
 * How long to wait before each retry, and when to stop. Immutable: `upTo` and `while`
 * return a new backoff. Each call narrows the backoff; none widens it.
 */
export type Backoff = {
  /**
   * The wait in milliseconds before retry number `attempt` (1 for the first retry) after
   * `error` failed the previous try. `undefined` means stop: do not retry. Throws
   * `InvalidBackoffError` when `attempt` is not a whole number from 1.
   */
  delay(attempt: number, error: unknown): number | undefined;
  /** The most retries this backoff allows: what `upTo` set, or `Infinity`. */
  readonly maxRetries: number;
  /** The same backoff, stopping after at most `retries` retries. `upTo(0)` never retries. */
  upTo(retries: number): Backoff;
  /** The same backoff, retrying only errors for which `predicate` returns true. */
  while(predicate: (error: unknown) => boolean): Backoff;
};

/** Options of {@link backoff.exponential}. */
export type ExponentialBackoffOptions = {
  /** The wait before the first retry, in milliseconds. Each later wait doubles. */
  readonly base: number;
  /** The longest wait, in milliseconds. Default and upper bound: `MAX_TIMER_MS` (about 24.8 days). */
  readonly max?: number;
  /**
   * How much each wait may vary, from 0 (the default: exact) to 1. With `0.25` a wait is
   * picked at random from 75% to 125% of its exact value, then capped at `max`. Spreads
   * the retries of many clients so they do not hit a recovering service at once.
   */
  readonly jitter?: number;
  /**
   * Where jitter gets its randomness: a function returning a number in [0, 1), like the
   * default `Math.random`. Pass a fixed one to make jittered waits deterministic in tests.
   */
  readonly random?: () => number;
};

function invalid(message: string): InvalidBackoffError {
  return new InvalidBackoffError(message);
}

function assertMs(name: string, value: number): void {
  if (!(Number.isFinite(value) && value >= 0 && value <= MAX_TIMER_MS)) {
    throw invalid(
      `backoff: ${name} must be a number of milliseconds from 0 to ${String(MAX_TIMER_MS)}, got ${String(value)}`,
    );
  }
}

function assertAttempt(attempt: number): void {
  if (!(Number.isInteger(attempt) && attempt >= 1)) {
    throw invalid(`backoff: delay(attempt) needs a whole number from 1, got ${String(attempt)}`);
  }
}

/** Builds a backoff from its exact wait per retry, its retry limit and its error filter. */
function create(
  wait: (attempt: number) => number,
  maxRetries: number,
  retryable?: (error: unknown) => boolean,
): Backoff {
  return {
    maxRetries,
    delay(attempt, error) {
      assertAttempt(attempt);
      if (attempt > maxRetries) return;
      if (retryable !== undefined && !retryable(error)) return;
      return wait(attempt);
    },
    upTo(retries) {
      if (!(Number.isInteger(retries) && retries >= 0)) {
        throw invalid(`backoff: upTo(retries) needs a whole number from 0, got ${String(retries)}`);
      }
      return create(wait, Math.min(maxRetries, retries), retryable);
    },
    while(predicate) {
      return create(
        wait,
        maxRetries,
        retryable === undefined ? predicate : error => retryable(error) && predicate(error),
      );
    },
  };
}

/** Builders of a {@link Backoff}. Every builder retries forever until `upTo` limits it. */
export const backoff = {
  /**
   * Waits `base`, then twice as long before each later retry: `base * 2^(attempt - 1)`,
   * capped at `max`, varied by `jitter`.
   *
   * @example backoff.exponential({ base: 200, max: 5000, jitter: 0.25 }).upTo(3)
   */
  exponential(options: ExponentialBackoffOptions): Backoff {
    const { base, max = MAX_TIMER_MS, jitter = 0, random = Math.random } = options;
    assertMs('base', base);
    assertMs('max', max);
    if (!(jitter >= 0 && jitter <= 1)) throw invalid(`backoff: jitter must be from 0 to 1, got ${String(jitter)}`);
    return create(attempt => {
      const exact = Math.min(max, base * 2 ** Math.min(attempt - 1, 1023));
      if (jitter === 0) return exact;
      return Math.min(max, Math.round(exact * (1 + jitter * (2 * random() - 1))));
    }, Infinity);
  },

  /**
   * Waits the same `ms` before every retry.
   *
   * @example backoff.constant(60_000).upTo(1)
   */
  constant(ms: number): Backoff {
    assertMs('ms', ms);
    return create(() => ms, Infinity);
  },
};
