import {
  bulkhead,
  circuitBreaker,
  noop as cockatielNoop,
  wrap as cockatielWrap,
  ConsecutiveBreaker,
  handleAll,
  timeout,
  TimeoutStrategy,
} from 'cockatiel';

import type { Clock } from '@arki/clock';
import { SystemClock } from '@arki/clock';

import type { RetryFailure } from './errors.js';
import type { Backoff } from './backoff.js';
import type { BulkheadPolicy, CircuitBreakerPolicy, Policy, RetryPolicy, TimeoutPolicy } from './policy.js';
import { backoff } from './backoff.js';
import { engineOf, fromEngine } from './engine.js';
import { withFallback } from './fallback.js';
import { observeEvent } from './observers.js';
import { buildRetryPolicy } from './retry.js';

// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

/**
 * Turns a thrown error that reaches the caller into a value, usually a failure from
 * `@arki/failure`. Rethrow the errors it does not recognise, so they stay bugs.
 */
export type OnThrow<Mapped> = (error: unknown) => Mapped | PromiseLike<Mapped>;

export type RetryPolicyOptions<Mapped = never> = {
  /**
   * When to retry and how long to wait first. Default:
   * `backoff.exponential({ base: 100, max: 10_000, jitter: 0.25 }).upTo(3)`.
   */
  backoff?: Backoff;
  /** Whose timer the retry delay waits on. Default: the system clock. Pass a `MockClock` to make tests instant. */
  clock?: Clock;
  /**
   * Map an error that outlasts the retries, or one that is not retried, to a value. The call then
   * resolves to `T | Mapped` instead of throwing. A cancel by the caller's signal is never mapped.
   */
  onThrow?: OnThrow<Mapped>;
};

export type CircuitBreakerPolicyOptions = {
  /** Duration in milliseconds before the breaker transitions from open to half-open (default: 30_000) */
  halfOpenAfter?: number;
  /** Number of consecutive failures before the breaker opens (default: 5) */
  consecutiveFailures?: number;
};

export type TimeoutPolicyOptions = {
  /** Timeout duration in milliseconds (default: 30_000) */
  timeoutMs?: number;
};

export type BulkheadPolicyOptions = {
  /** Maximum concurrent executions (default: 10) */
  maxConcurrent?: number;
  /** Maximum queue size for pending executions (default: 100) */
  maxQueue?: number;
};

export type ResiliencePolicyOptions<Mapped = never> = {
  /** When to retry and how long to wait first. Default: the `createRetryPolicy` default. */
  retry?: Backoff;
  /** Whose timer the retry delay waits on. Default: the system clock. */
  clock?: Clock;
  circuitBreaker?: CircuitBreakerPolicyOptions;
  timeout?: TimeoutPolicyOptions;
  /**
   * Limit concurrent calls. Off unless given, so existing callers keep unlimited
   * concurrency. It wraps everything else: one logical call, retries included,
   * holds one slot.
   */
  bulkhead?: BulkheadPolicyOptions;
  /**
   * Map a thrown error that reaches the caller to a value, usually a failure from `@arki/failure`.
   * The call then resolves to `T | Mapped` instead of throwing. It wraps everything, so it also
   * sees an open circuit (`CircuitOpenError`), a deadline (`TimeoutError`) and a full bulkhead
   * (`BulkheadRejectedError`). A cancel by the caller's signal is never mapped. Rethrow the
   * errors it does not recognise, so they stay bugs.
   */
  onThrow?: OnThrow<Mapped>;
};

// ---------------------------------------------------------------------------
// Policy factories
// ---------------------------------------------------------------------------

const systemClock = new SystemClock();
const defaultRetry = backoff.exponential({ base: 100, max: 10_000, jitter: 0.25 }).upTo(3);

/**
 * Create a retry policy. It calls the function, and after each failure asks `backoff`
 * how long to wait before the next try, or whether to stop and rethrow the error.
 *
 * Default backoff: 3 retries, 100 ms doubling to at most 10 s, with 25% jitter.
 */
export function createRetryPolicy<Mapped = never>(options: RetryPolicyOptions<Mapped> = {}): RetryPolicy<Mapped> {
  const retry = buildRetryPolicy(options.backoff ?? defaultRetry, options.clock ?? systemClock);
  if (options.onThrow === undefined) return retry;
  return { ...withFallback(retry, options.onThrow), onRetry: retry.onRetry, onGiveUp: retry.onGiveUp };
}

/**
 * Create a circuit breaker policy using consecutive-failure detection.
 *
 * Defaults: 5 consecutive failures, 30 s half-open window.
 */
export function createCircuitBreakerPolicy(options: CircuitBreakerPolicyOptions = {}): CircuitBreakerPolicy {
  const { halfOpenAfter = 30_000, consecutiveFailures = 5 } = options;

  const engine = circuitBreaker(handleAll, {
    halfOpenAfter,
    breaker: new ConsecutiveBreaker(consecutiveFailures),
  });
  const policy = fromEngine(engine, {
    onBreak: observeEvent(engine.onBreak, engine),
    onHalfOpen: observeEvent(engine.onHalfOpen, engine),
    onReset: observeEvent(engine.onReset, engine),
  });
  return policy;
}

/**
 * Create a timeout policy that aggressively cancels the operation when the
 * deadline is exceeded.
 *
 * Default: 30 s.
 */
export function createTimeoutPolicy(options: TimeoutPolicyOptions = {}): TimeoutPolicy {
  const { timeoutMs = 30_000 } = options;
  const engine = timeout(timeoutMs, TimeoutStrategy.Aggressive);
  const policy = fromEngine(engine, { onTimeout: observeEvent(engine.onTimeout, engine) });
  return policy;
}

/**
 * Create a bulkhead (concurrency-limiter) policy.
 *
 * Defaults: 10 concurrent, 100 queued.
 */
export function createBulkheadPolicy(options: BulkheadPolicyOptions = {}): BulkheadPolicy {
  const { maxConcurrent = 10, maxQueue = 100 } = options;
  const engine = bulkhead(maxConcurrent, maxQueue);
  const policy = fromEngine(engine, { onReject: observeEvent(engine.onReject, engine) });
  return policy;
}

/**
 * Compose policies from the outside in: `wrap(retry, breaker, timeout)` retries a call whose
 * every attempt goes through the breaker and then the timeout. Events on the result are
 * those of the outermost policy.
 */
export function wrap<E = never>(first: Policy<never, E>, ...rest: Policy<never, E>[]): Policy<never, E> {
  return fromEngine(cockatielWrap(engineOf(first), ...rest.map(policy => engineOf(policy))), {});
}

/** A policy that only runs the function. Useful as a default or in tests. */
export const noop: Policy = fromEngine(cockatielNoop, {});

/** The parts a composed resilience policy runs. Their events fire on every composed call. */
export type ResilienceComponents = {
  readonly retry: RetryPolicy;
  readonly circuitBreaker: CircuitBreakerPolicy;
  readonly timeout: TimeoutPolicy;
  /** Set only when the `bulkhead` option was given. */
  readonly bulkhead?: BulkheadPolicy;
};

/**
 * What `createResiliencePolicy` returns: the composed policy plus the parts it runs. `F` is what
 * its `onThrow` may answer instead of the function's own `T`; `never` without one.
 */
export type ResiliencePolicy<F = never> = Policy<F, RetryFailure> & { readonly components: ResilienceComponents };

/**
 * Create a composed resilience policy: [bulkhead ->] retry -> circuit breaker -> timeout.
 *
 * Retry wraps the circuit breaker which wraps the timeout, so a single logical
 * call may be retried while individual attempts are protected by the breaker
 * and the timeout. With `bulkhead`, the bulkhead wraps all of it, so one
 * logical call holds one slot for all its attempts.
 *
 * `components` holds the parts it runs, so you can listen to their events.
 */
export function createResiliencePolicy<Mapped = never>(
  options: ResiliencePolicyOptions<Mapped> = {},
): ResiliencePolicy<Mapped> {
  const policy = composeResiliencePolicy(options);
  if (options.onThrow === undefined) return policy;
  // Outermost, so an open circuit, a deadline and a full bulkhead reach it too.
  return { ...withFallback(policy, options.onThrow), components: policy.components };
}

/** [bulkhead ->] retry -> circuit breaker -> timeout, without `onThrow`. */
function composeResiliencePolicy(options: ResiliencePolicyOptions<unknown>): ResiliencePolicy {
  const retry = createRetryPolicy({ backoff: options.retry, clock: options.clock });
  const circuitBreaker = createCircuitBreakerPolicy(options.circuitBreaker);
  const timeoutPolicy = createTimeoutPolicy(options.timeout);

  if (options.bulkhead === undefined) {
    return fromEngine(cockatielWrap(engineOf(retry), engineOf(circuitBreaker), engineOf(timeoutPolicy)), {
      components: { retry, circuitBreaker, timeout: timeoutPolicy },
    });
  }
  const bulkhead = createBulkheadPolicy(options.bulkhead);
  return fromEngine(
    cockatielWrap(engineOf(bulkhead), engineOf(retry), engineOf(circuitBreaker), engineOf(timeoutPolicy)),
    { components: { retry, circuitBreaker, timeout: timeoutPolicy, bulkhead } },
  );
}
