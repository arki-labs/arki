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
  InvalidBackoffError,
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

// Retry schedules, shared with @arki/queue and @arki/journal
export { backoff } from './backoff.js';
export type { Backoff, ExponentialBackoffOptions } from './backoff.js';

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

// A last answer when a policy gives up
export { withFallback } from './fallback.js';

export type {
  RetryPolicyOptions,
  OnThrow,
  CircuitBreakerPolicyOptions,
  TimeoutPolicyOptions,
  BulkheadPolicyOptions,
  ResiliencePolicyOptions,
  ResiliencePolicy,
  ResilienceComponents,
} from './policies.js';

// Pre-configured presets
export { externalApiPolicy, databasePolicy, backgroundJobPolicy, definePresets } from './presets.js';
export type { Presets } from './presets.js';

// Event / observability helpers
export { attachPolicyLogger } from './events.js';

export type { PolicyLogger } from './events.js';

// Execution helpers
export { withResilience, withRetry, withTimeout } from './execute.js';
