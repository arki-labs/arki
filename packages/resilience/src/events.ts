import { isFailure, UnexpectedDefect } from '@arki/failure';

import type {
  BulkheadPolicy,
  CircuitBreakerPolicy,
  FailureReason,
  Policy,
  RetryPolicy,
  TimeoutPolicy,
} from './policy.js';
import { observeEvent } from './observers.js';

// ---------------------------------------------------------------------------
// Logger interface — intentionally minimal so callers can pass any logger.
// ---------------------------------------------------------------------------

export type PolicyLogger = {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
};

/** Optional event capabilities come from the original policy declarations. */
type ObservablePolicy = Policy<unknown, unknown> &
  Partial<
    Pick<RetryPolicy, 'onRetry' | 'onGiveUp'> &
      Pick<CircuitBreakerPolicy, 'onBreak' | 'onHalfOpen' | 'onReset'> &
      Pick<TimeoutPolicy, 'onTimeout'> &
      Pick<BulkheadPolicy, 'onReject'>
  >;

/** Default diagnostics expose codes, never callback messages or payloads. @internal */
export function describe(reason: FailureReason): string {
  const outcome = 'error' in reason ? reason.error : reason.value;
  return isFailure(outcome) ? outcome.code : UnexpectedDefect.code;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attach structured logging to a resilience policy. Subscribes to retry,
 * circuit breaker, timeout, success, and failure events when available.
 *
 * Returns a cleanup function that disposes all subscriptions.
 */
export function attachPolicyLogger(
  policy: ObservablePolicy,
  logger: PolicyLogger,
  policyName = 'resilience',
): () => void {
  const disposables: { dispose(): void }[] = [];

  // Retry events
  if (policy.onRetry) {
    disposables.push(
      observeEvent(policy.onRetry, policy)(({ attempt, delay }) => {
        return logger.warn(`[${policyName}] Retry attempt`, { attempt, delay });
      }),
    );
  }
  if (policy.onGiveUp) {
    disposables.push(
      observeEvent(policy.onGiveUp, policy)(failureReason => {
        return logger.error(`[${policyName}] All retries exhausted`, {
          error: describe(failureReason),
        });
      }),
    );
  }

  // Circuit breaker events
  if (policy.onBreak) {
    disposables.push(
      observeEvent(policy.onBreak, policy)(failureReason => {
        if ('isolated' in failureReason) {
          return logger.error(`[${policyName}] Circuit breaker opened (isolated)`);
        } else {
          return logger.error(`[${policyName}] Circuit breaker opened`, {
            error: describe(failureReason),
          });
        }
      }),
    );
  }
  if (policy.onHalfOpen) {
    disposables.push(
      observeEvent(policy.onHalfOpen, policy)(() => {
        return logger.info(`[${policyName}] Circuit breaker half-open`);
      }),
    );
  }
  if (policy.onReset) {
    disposables.push(
      observeEvent(policy.onReset, policy)(() => {
        return logger.info(`[${policyName}] Circuit breaker closed`);
      }),
    );
  }

  // Timeout events
  if (policy.onTimeout) {
    disposables.push(
      observeEvent(policy.onTimeout, policy)(() => {
        return logger.warn(`[${policyName}] Operation timed out`);
      }),
    );
  }

  if (policy.onReject) {
    disposables.push(
      observeEvent(policy.onReject, policy)(() => {
        return logger.warn(`[${policyName}] Bulkhead full, call rejected`);
      }),
    );
  }

  // Success / failure events (available on every policy)
  disposables.push(
    observeEvent(policy.onSuccess, policy)(({ duration }) => {
      return logger.info(`[${policyName}] Operation succeeded`, {
        durationMs: duration,
      });
    }),
    observeEvent(policy.onFailure, policy)(({ reason, duration }) => {
      return logger.error(`[${policyName}] Operation failed`, {
        error: describe(reason),
        durationMs: duration,
      });
    }),
  );

  return () => {
    for (const d of disposables) {
      d.dispose();
    }
  };
}
