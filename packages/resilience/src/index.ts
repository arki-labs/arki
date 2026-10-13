// Errors
export {
  CircuitOpenError,
  TimeoutError,
  RetriesExhaustedError,
  isResilienceError,
  isBrokenCircuitError,
  isBulkheadRejectedError,
} from './errors.js';

// Policy factories
export {
  createRetryPolicy,
  createCircuitBreakerPolicy,
  createTimeoutPolicy,
  createBulkheadPolicy,
  createResiliencePolicy,
} from './policies.js';

export type {
  RetryPolicyOptions,
  CircuitBreakerPolicyOptions,
  TimeoutPolicyOptions,
  BulkheadPolicyOptions,
  ResiliencePolicyOptions,
} from './policies.js';

// Pre-configured presets
export {
  externalApiPolicy,
  databasePolicy,
  backgroundJobPolicy,
} from './presets.js';

// Event / observability helpers
export { attachPolicyLogger } from './events.js';

export type { PolicyLogger } from './events.js';

// Execution helpers
export {
  withResilience,
  withRetry,
  withTimeout,
  withCircuitBreaker,
} from './execute.js';

// Re-export key cockatiel types for consumers who need to type policy references
export type { IPolicy } from 'cockatiel';
export { wrap, noop } from 'cockatiel';
