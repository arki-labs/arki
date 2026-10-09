import { wrap } from 'cockatiel';

import type { IPolicy } from 'cockatiel';

import { createResiliencePolicy, createRetryPolicy, createTimeoutPolicy } from './policies.js';

/**
 * Resilience policy tuned for external API calls (geocoding, AI providers, etc.).
 *
 * - Retry: 3 attempts, 200 ms initial, 5 s max
 * - Circuit breaker: 5 consecutive failures, 30 s half-open
 * - Timeout: 10 s per attempt
 */
export const externalApiPolicy: IPolicy = createResiliencePolicy({
  retry: {
    maxAttempts: 3,
    initialDelay: 200,
    maxDelay: 5000,
  },
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
 * - Retry: 2 attempts, 50 ms initial, 1 s max
 * - Timeout: 5 s per attempt
 */
export const databasePolicy: IPolicy = wrap(
  createRetryPolicy({
    maxAttempts: 2,
    initialDelay: 50,
    maxDelay: 1000,
  }),
  createTimeoutPolicy({
    timeoutMs: 5000,
  }),
);

/**
 * Resilience policy tuned for background job processing where higher latency
 * and more retries are acceptable.
 *
 * - Retry: 5 attempts, 500 ms initial, 30 s max
 * - Circuit breaker: 10 consecutive failures, 60 s half-open
 * - Timeout: 60 s per attempt
 */
export const backgroundJobPolicy: IPolicy = createResiliencePolicy({
  retry: {
    maxAttempts: 5,
    initialDelay: 500,
    maxDelay: 30_000,
  },
  circuitBreaker: {
    consecutiveFailures: 10,
    halfOpenAfter: 60_000,
  },
  timeout: {
    timeoutMs: 60_000,
  },
});
