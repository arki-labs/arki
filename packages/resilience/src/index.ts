// Errors
export {
  CircuitOpenError,
  TimeoutError,
  RetriesExhaustedError,
  isResilienceError,
  isBrokenCircuitError,
  isBulkheadRejectedError,
} from './errors';

// Policy factories
export {
  createRetryPolicy,
  createCircuitBreakerPolicy,
  createTimeoutPolicy,
  createBulkheadPolicy,
  createResiliencePolicy,
} from './policies';

export type {
  RetryPolicyOptions,
  CircuitBreakerPolicyOptions,
  TimeoutPolicyOptions,
  BulkheadPolicyOptions,
  ResiliencePolicyOptions,
} from './policies';

// Pre-configured presets
export {
  externalApiPolicy,
  databasePolicy,
  backgroundJobPolicy,
} from './presets';

// Event / observability helpers
export { attachPolicyLogger } from './events';

export type { PolicyLogger } from './events';

// Execution helpers
export {
  withResilience,
  withRetry,
  withTimeout,
  withCircuitBreaker,
} from './execute';

// Re-export key cockatiel types for consumers who need to type policy references
export type { IPolicy } from 'cockatiel';
export { wrap, noop } from 'cockatiel';
