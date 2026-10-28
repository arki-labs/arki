import {
  bulkhead,
  circuitBreaker,
  noop as cockatielNoop,
  wrap as cockatielWrap,
  ConsecutiveBreaker,
  CircuitState,
  handleAll,
} from 'cockatiel';

import type { Clock } from '@arki/clock';
import { MAX_TIMER_MS, SystemClock } from '@arki/clock';
import { ensure, is } from '@arki/schema';
import { z } from 'zod';
import { CircuitOpen, BulkheadRejected, Cancelled } from './errors.js';
import { timeoutPolicy } from './timeout.js';

import type { ResilienceFailure } from './errors.js';
import type { Backoff } from './backoff.js';
import type { BulkheadPolicy, CircuitBreakerPolicy, Policy, RetryPolicy, TimeoutPolicy } from './policy.js';
import { backoff } from './backoff.js';
import type { Engine } from './engine.js';
import { engineOf, fromEngine, ownedEngine, originalReason } from './engine.js';
import { withFallback } from './fallback.js';
import { observeEvent } from './observers.js';
import { recordCircuitTransition } from './telemetry.js';
import { buildRetryPolicy } from './retry.js';

// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

/**
 * Turns a thrown error that reaches the caller into a value, usually a failure from
 * `@arki/failure`. Rethrow unrecognized errors so the public boundary returns UnexpectedDefect.
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
   * Explicit fallback sees exhausted callback throws before public defect normalization.
   * Returned engine refusals and cancellation bypass it. Unmapped throws become UnexpectedDefect.
   */
  onThrow?: OnThrow<Mapped>;
};

// ---------------------------------------------------------------------------
// Policy factories
// ---------------------------------------------------------------------------

/** @internal Static options keep their source TS contracts; exact type tests bind these schemas. */
export const circuitBreakerOptionsSchema = z.object({
  halfOpenAfter: z.number().finite().nonnegative().optional(),
  consecutiveFailures: z.number().int().positive().optional(),
});
/** @internal Web timers cannot honor delays above MAX_TIMER_MS. */
export const timeoutOptionsSchema = z.object({ timeoutMs: z.number().min(0).max(MAX_TIMER_MS).optional() });
/** @internal Zero capacity with queued work can never make progress. */
export const bulkheadOptionsSchema = z.object({
  maxConcurrent: z.number().int().positive().optional(),
  maxQueue: z.number().int().nonnegative().optional(),
});

const circuitErrorSchema = z.object({ isBrokenCircuitError: z.literal(true) });
const bulkheadErrorSchema = z.object({ isBulkheadRejectedError: z.literal(true) });
const cancelledErrorSchema = z.object({ isTaskCancelledError: z.literal(true) });

const circuitStateNames = {
  [CircuitState.Closed]: 'closed',
  [CircuitState.Open]: 'open',
  [CircuitState.HalfOpen]: 'half_open',
  [CircuitState.Isolated]: 'isolated',
} as const;

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
  return Object.assign(withFallback(retry, options.onThrow), { onRetry: retry.onRetry, onGiveUp: retry.onGiveUp });
}

/**
 * Create a circuit breaker policy using consecutive-failure detection.
 *
 * Defaults: 5 consecutive failures, 30 s half-open window.
 */
export function createCircuitBreakerPolicy(options: CircuitBreakerPolicyOptions = {}): CircuitBreakerPolicy {
  const { halfOpenAfter = 30_000, consecutiveFailures = 5 } = ensure(options, circuitBreakerOptionsSchema, { at: 'circuit breaker options' });

  const engine = circuitBreaker(handleAll, {
    halfOpenAfter,
    breaker: new ConsecutiveBreaker(consecutiveFailures),
  });
  engine.onStateChange(state => recordCircuitTransition(circuitStateNames[state]));
  const policy = fromEngine(ownedEngine(engine, error => {
    if (is(error, circuitErrorSchema)) return CircuitOpen({ cause: error });
    throw error;
  }, 'resilience.circuit_breaker'), {
    onBreak: (listener: Parameters<CircuitBreakerPolicy['onBreak']>[0]) => observeEvent(engine.onBreak, engine)(event => listener(
      'isolated' in event ? event : originalReason(event),
    )),
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
  const { timeoutMs = 30_000 } = ensure(options, timeoutOptionsSchema, { at: 'timeout options' });
  return timeoutPolicy(timeoutMs);
}

/**
 * Create a bulkhead (concurrency-limiter) policy.
 *
 * Defaults: 10 concurrent, 100 queued.
 */
export function createBulkheadPolicy(options: BulkheadPolicyOptions = {}): BulkheadPolicy {
  const { maxConcurrent = 10, maxQueue = 100 } = ensure(options, bulkheadOptionsSchema, { at: 'bulkhead options' });
  const engine = bulkhead(maxConcurrent, maxQueue);
  const policy = fromEngine(ownedEngine(engine, error => {
    if (is(error, bulkheadErrorSchema)) return BulkheadRejected({ cause: error });
    if (is(error, cancelledErrorSchema)) return Cancelled({ cause: error });
    throw error;
  }, 'resilience.bulkhead'), { onReject: observeEvent(engine.onReject, engine) });
  return policy;
}

/**
 * Compose policies from the outside in: `wrap(retry, breaker, timeout)` retries a call whose
 * every attempt goes through the breaker and then the timeout. Events on the result are
 * those of the outermost policy.
 */
export function wrap<E, R extends readonly unknown[]>(first: Policy<never, E>, ...rest: { [K in keyof R]: Policy<never, R[K]> }): Policy<never, E | R[number]> {
  const engines: Engine<E | R[number]>[] = [engineOf(first), ...rest.map(policy => engineOf(policy))];
  return fromEngine(cockatielWrap(...engines), {});
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
export type ResiliencePolicy<F = never> = Policy<F, ResilienceFailure> & { readonly components: ResilienceComponents };

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
  // Outermost, before the public defect boundary; returned refusals bypass it.
  return Object.assign(withFallback(policy, options.onThrow), { components: policy.components });
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
