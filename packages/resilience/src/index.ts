// Errors
export {
  ResilienceError,
  RESILIENCE_ERROR_CODES,
  type ResilienceErrorCode,
  CircuitOpenError,
  TimeoutError,
  CancelledError,
  BulkheadRejectedError,
  RetriesExhaustedError,
  isResilienceError,
  isBrokenCircuitError,
  isBulkheadRejectedError,
} from './errors.js';

// Policy shape and event payloads
export type {
  Policy,
  PolicyContext,
  PolicyCallback,
  RetryPolicy,
  CircuitBreakerPolicy,
  TimeoutPolicy,
  BulkheadPolicy,
  PolicyEvent,
  Subscription,
  FailureReason,
  SuccessEvent,
  FailureEvent,
  RetryEvent,
  BreakEvent,
} from './policy.js';

// Policy factories and composition
export {
  createRetryPolicy,
  createCircuitBreakerPolicy,
  createTimeoutPolicy,
  createBulkheadPolicy,
  createResiliencePolicy,
  wrap,
  noop,
} from './policies.js';

export type {
  RetryPolicyOptions,
  CircuitBreakerPolicyOptions,
  TimeoutPolicyOptions,
  BulkheadPolicyOptions,
  ResiliencePolicyOptions,
} from './policies.js';

// Pre-configured presets
export { externalApiPolicy, databasePolicy, backgroundJobPolicy } from './presets.js';

// Event / observability helpers
export { attachPolicyLogger } from './events.js';

export type { PolicyLogger } from './events.js';

// Execution helpers
export { withResilience, withRetry, withTimeout } from './execute.js';
