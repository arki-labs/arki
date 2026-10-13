import {
  bulkhead,
  circuitBreaker,
  noop as cockatielNoop,
  wrap as cockatielWrap,
  ConsecutiveBreaker,
  ExponentialBackoff,
  handleAll,
  retry,
  timeout,
  TimeoutStrategy,
} from 'cockatiel';

import type { BulkheadPolicy, CircuitBreakerPolicy, Policy, RetryPolicy, TimeoutPolicy } from './policy.js';
import { engineOf, fromEngine } from './engine.js';

// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

export type RetryPolicyOptions = {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;
  /** Initial delay in milliseconds before the first retry (default: 100) */
  initialDelay?: number;
  /** Maximum delay in milliseconds between retries (default: 10_000) */
  maxDelay?: number;
  /** Exponent applied to the backoff calculation (default: 2) */
  exponent?: number;
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

export type ResiliencePolicyOptions = {
  retry?: RetryPolicyOptions;
  circuitBreaker?: CircuitBreakerPolicyOptions;
  timeout?: TimeoutPolicyOptions;
};

// ---------------------------------------------------------------------------
// Policy factories
// ---------------------------------------------------------------------------

/**
 * Create a retry policy with configurable exponential backoff.
 *
 * Defaults: 3 attempts, 100 ms initial delay, 10 s max delay, exponent 2.
 */
export function createRetryPolicy(options: RetryPolicyOptions = {}): RetryPolicy {
  const { maxAttempts = 3, initialDelay = 100, maxDelay = 10_000, exponent = 2 } = options;

  const engine = retry(handleAll, {
    maxAttempts,
    backoff: new ExponentialBackoff({
      initialDelay,
      maxDelay,
      exponent,
    }),
  });
  return fromEngine(engine, { onRetry: engine.onRetry, onGiveUp: engine.onGiveUp });
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
  return fromEngine(engine, { onBreak: engine.onBreak, onHalfOpen: engine.onHalfOpen, onReset: engine.onReset });
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
  return fromEngine(engine, { onTimeout: engine.onTimeout });
}

/**
 * Create a bulkhead (concurrency-limiter) policy.
 *
 * Defaults: 10 concurrent, 100 queued.
 */
export function createBulkheadPolicy(options: BulkheadPolicyOptions = {}): BulkheadPolicy {
  const { maxConcurrent = 10, maxQueue = 100 } = options;
  const engine = bulkhead(maxConcurrent, maxQueue);
  return fromEngine(engine, { onReject: engine.onReject });
}

/**
 * Compose policies from the outside in: `wrap(retry, breaker, timeout)` retries a call whose
 * every attempt goes through the breaker and then the timeout. Events on the result are
 * those of the outermost policy.
 */
export function wrap(first: Policy, ...rest: Policy[]): Policy {
  return fromEngine(cockatielWrap(engineOf(first), ...rest.map(policy => engineOf(policy))), {});
}

/** A policy that only runs the function. Useful as a default or in tests. */
export const noop: Policy = fromEngine(cockatielNoop, {});

/**
 * Create a composed resilience policy: retry -> circuit breaker -> timeout.
 *
 * The outermost policy (retry) wraps the circuit breaker which wraps the
 * timeout, so a single logical call may be retried while individual attempts
 * are protected by the breaker and the timeout.
 */
export function createResiliencePolicy(options: ResiliencePolicyOptions = {}): Policy {
  const retryPolicy = createRetryPolicy(options.retry);
  const breakerPolicy = createCircuitBreakerPolicy(options.circuitBreaker);
  const timeoutPolicy = createTimeoutPolicy(options.timeout);

  return wrap(retryPolicy, breakerPolicy, timeoutPolicy);
}
