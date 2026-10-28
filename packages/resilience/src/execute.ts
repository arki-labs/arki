import type { RetryFailure, ExecutionFailure } from './errors.js';

import type { RetryPolicyOptions, TimeoutPolicyOptions } from './policies.js';
import type { Policy, PolicyCallback } from './policy.js';
import { UnexpectedDefect } from '@arki/failure';
import { createRetryPolicy, createTimeoutPolicy } from './policies.js';

/** Own synchronous and asynchronous defects from foreign execution-only policies too. */
function run<T, F, E>(policy: Policy<F, E>, fn: PolicyCallback<T>): Promise<T | F | E | ExecutionFailure> {
  try {
    return policy.execute(fn).catch(error => UnexpectedDefect({ cause: error }));
  } catch (error) {
    return Promise.resolve(UnexpectedDefect({ cause: error }));
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
export function withResilience<T, F = never, E = never>(fn: PolicyCallback<T>, policy: Policy<F, E>): Promise<T | F | E | ExecutionFailure> {
  return run(policy, fn);
}

/**
 * Execute a function with a retry policy (no circuit breaker or timeout).
 *
 * Convenience wrapper that creates an ephemeral retry policy from the provided
 * options and executes immediately.
 */
export function withRetry<T, Mapped = never>(
  fn: PolicyCallback<T>,
  options?: RetryPolicyOptions<Mapped>,
): Promise<T | Mapped | RetryFailure> {
  return run(createRetryPolicy(options), fn);
}

/**
 * Execute a function with a timeout policy.
 */
export function withTimeout<T>(fn: PolicyCallback<T>, options?: TimeoutPolicyOptions) {
  return run(createTimeoutPolicy(options), fn);
}
