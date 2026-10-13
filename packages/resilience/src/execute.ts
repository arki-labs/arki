import type { IPolicy } from 'cockatiel';

import type { CircuitBreakerPolicyOptions, RetryPolicyOptions, TimeoutPolicyOptions } from './policies.js';
import { createCircuitBreakerPolicy, createRetryPolicy, createTimeoutPolicy } from './policies.js';

/**
 * Execute a function with an already-constructed resilience policy.
 *
 * @example
 * ```ts
 * const result = await withResilience(
 *   () => fetch('https://api.example.com'),
 *   externalApiPolicy,
 * );
 * ```
 */
export async function withResilience<T>(
  fn: (context: { signal: AbortSignal }) => T | Promise<T>,
  policy: IPolicy,
): Promise<T> {
  return policy.execute(fn);
}

/**
 * Execute a function with a retry policy (no circuit breaker or timeout).
 *
 * Convenience wrapper that creates an ephemeral retry policy from the provided
 * options and executes immediately.
 */
export async function withRetry<T>(
  fn: (context: { signal: AbortSignal }) => T | Promise<T>,
  options?: RetryPolicyOptions,
): Promise<T> {
  const policy = createRetryPolicy(options);
  return policy.execute(fn);
}

/**
 * Execute a function with a timeout policy.
 */
export async function withTimeout<T>(
  fn: (context: { signal: AbortSignal }) => T | Promise<T>,
  options?: TimeoutPolicyOptions,
): Promise<T> {
  const policy = createTimeoutPolicy(options);
  return policy.execute(fn);
}

/**
 * @deprecated Builds a new circuit breaker on every call, so it never
 * remembers a failure and never opens. Build one policy with
 * `createCircuitBreakerPolicy()` and pass it to `withResilience()` on each call.
 */
export async function withCircuitBreaker<T>(
  fn: (context: { signal: AbortSignal }) => T | Promise<T>,
  options?: CircuitBreakerPolicyOptions,
): Promise<T> {
  const policy = createCircuitBreakerPolicy(options);
  return policy.execute(fn);
}
