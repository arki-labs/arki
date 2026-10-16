import type { Policy } from './policy.js';
import { backoff } from './backoff.js';
import { createResiliencePolicy, createRetryPolicy, createTimeoutPolicy, wrap } from './policies.js';

/**
 * Resilience policy tuned for external API calls (geocoding, AI providers, etc.).
 *
 * - Retry: 3 retries, 200 ms doubling to at most 5 s, 25% jitter
 * - Circuit breaker: 5 consecutive failures, 30 s half-open
 * - Timeout: 10 s per attempt
 */
export const externalApiPolicy: Policy = createResiliencePolicy({
  retry: backoff.exponential({ base: 200, max: 5000, jitter: 0.25 }).upTo(3),
  circuitBreaker: {
    consecutiveFailures: 5,
    halfOpenAfter: 30_000,
  },
  timeout: {
    timeoutMs: 10_000,
  },
});

/**
 * Resilience policy tuned for database operations.
 *
 * Skips the circuit breaker because database connection pools already handle
 * connection-level health checks.
 *
 * - Retry: 2 retries, 50 ms doubling to at most 1 s, 25% jitter
 * - Timeout: 5 s per attempt
 */
export const databasePolicy: Policy = wrap(
  createRetryPolicy({ backoff: backoff.exponential({ base: 50, max: 1000, jitter: 0.25 }).upTo(2) }),
  createTimeoutPolicy({
    timeoutMs: 5000,
  }),
);

/**
 * Resilience policy tuned for background job processing where higher latency
 * and more retries are acceptable.
 *
 * - Retry: 5 retries, 500 ms doubling to at most 30 s, 25% jitter
 * - Circuit breaker: 10 consecutive failures, 60 s half-open
 * - Timeout: 60 s per attempt
 */
export const backgroundJobPolicy: Policy = createResiliencePolicy({
  retry: backoff.exponential({ base: 500, max: 30_000, jitter: 0.25 }).upTo(5),
  circuitBreaker: {
    consecutiveFailures: 10,
    halfOpenAfter: 60_000,
  },
  timeout: {
    timeoutMs: 60_000,
  },
});
