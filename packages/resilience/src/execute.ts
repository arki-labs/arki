import type { CircuitBreakerPolicyOptions, RetryPolicyOptions, TimeoutPolicyOptions } from './policies.js';
import type { Policy, PolicyCallback } from './policy.js';
import { createCircuitBreakerPolicy, createRetryPolicy, createTimeoutPolicy } from './policies.js';

/**
 * Return the policy's own promise instead of awaiting it inside an `async` function, which would
 * wrap it in a second promise and add microtask hops to every call. A policy that throws instead of
 * rejecting still yields a rejected promise, as an `async` function would.
 */
function run<T>(policy: Policy, fn: PolicyCallback<T>): Promise<T> {
  try {
    return policy.execute(fn);
  } catch (error) {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- passes the thrown value through unchanged, as an `async` function would
    return Promise.reject(error);
  }
}

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
export function withResilience<T>(fn: PolicyCallback<T>, policy: Policy): Promise<T> {
  return run(policy, fn);
}

/**
 * Execute a function with a retry policy (no circuit breaker or timeout).
 *
 * Convenience wrapper that creates an ephemeral retry policy from the provided
 * options and executes immediately.
 */
export function withRetry<T>(fn: PolicyCallback<T>, options?: RetryPolicyOptions): Promise<T> {
  return run(createRetryPolicy(options), fn);
}

/**
 * Execute a function with a timeout policy.
 */
export function withTimeout<T>(fn: PolicyCallback<T>, options?: TimeoutPolicyOptions): Promise<T> {
  return run(createTimeoutPolicy(options), fn);
}

/**
 * @deprecated Builds a new circuit breaker on every call, so it never
 * remembers a failure and never opens. Build one policy with
 * `createCircuitBreakerPolicy()` and pass it to `withResilience()` on each call.
 */
export function withCircuitBreaker<T>(fn: PolicyCallback<T>, options?: CircuitBreakerPolicyOptions): Promise<T> {
  return run(createCircuitBreakerPolicy(options), fn);
}
