import {
  ExponentialBackoff,
  retry,
  handleAll,
  circuitBreaker,
  ConsecutiveBreaker,
  timeout,
  TimeoutStrategy,
  bulkhead,
  wrap,
} from 'cockatiel';

import type { IPolicy } from 'cockatiel';

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
}

export type CircuitBreakerPolicyOptions = {
  /** Duration in milliseconds before the breaker transitions from open to half-open (default: 30_000) */
  halfOpenAfter?: number;
  /** Number of consecutive failures before the breaker opens (default: 5) */
  consecutiveFailures?: number;
}

export type TimeoutPolicyOptions = {
  /** Timeout duration in milliseconds (default: 30_000) */
  timeoutMs?: number;
}

export type BulkheadPolicyOptions = {
  /** Maximum concurrent executions (default: 10) */
  maxConcurrent?: number;
  /** Maximum queue size for pending executions (default: 100) */
  maxQueue?: number;
}

export type ResiliencePolicyOptions = {
  retry?: RetryPolicyOptions;
  circuitBreaker?: CircuitBreakerPolicyOptions;
  timeout?: TimeoutPolicyOptions;
}

// ---------------------------------------------------------------------------
// Policy factories
// ---------------------------------------------------------------------------

/**
 * Create a retry policy with configurable exponential backoff.
 *
 * Defaults: 3 attempts, 100 ms initial delay, 10 s max delay, exponent 2.
 */
export function createRetryPolicy(options: RetryPolicyOptions = {}) {
  const {
    maxAttempts = 3,
    initialDelay = 100,
    maxDelay = 10_000,
    exponent = 2,
  } = options;

  return retry(handleAll, {
    maxAttempts,
    backoff: new ExponentialBackoff({
      initialDelay,
      maxDelay,
      exponent,
    }),
  });
}

/**
 * Create a circuit breaker policy using consecutive-failure detection.
 *
 * Defaults: 5 consecutive failures, 30 s half-open window.
 */
export function createCircuitBreakerPolicy(
  options: CircuitBreakerPolicyOptions = {},
) {
  const { halfOpenAfter = 30_000, consecutiveFailures = 5 } = options;

  return circuitBreaker(handleAll, {
    halfOpenAfter,
    breaker: new ConsecutiveBreaker(consecutiveFailures),
  });
}

/**
 * Create a timeout policy that aggressively cancels the operation when the
 * deadline is exceeded.
 *
 * Default: 30 s.
 */
export function createTimeoutPolicy(options: TimeoutPolicyOptions = {}) {
  const { timeoutMs = 30_000 } = options;
  return timeout(timeoutMs, TimeoutStrategy.Aggressive);
}

/**
 * Create a bulkhead (concurrency-limiter) policy.
 *
 * Defaults: 10 concurrent, 100 queued.
 */
export function createBulkheadPolicy(options: BulkheadPolicyOptions = {}) {
  const { maxConcurrent = 10, maxQueue = 100 } = options;
  return bulkhead(maxConcurrent, maxQueue);
}

/**
 * Create a composed resilience policy: retry -> circuit breaker -> timeout.
 *
 * The outermost policy (retry) wraps the circuit breaker which wraps the
 * timeout, so a single logical call may be retried while individual attempts
 * are protected by the breaker and the timeout.
 */
export function createResiliencePolicy(
  options: ResiliencePolicyOptions = {},
): IPolicy {
  const retryPolicy = createRetryPolicy(options.retry);
  const breakerPolicy = createCircuitBreakerPolicy(options.circuitBreaker);
  const timeoutPolicy = createTimeoutPolicy(options.timeout);

  return wrap(retryPolicy, breakerPolicy, timeoutPolicy);
}
