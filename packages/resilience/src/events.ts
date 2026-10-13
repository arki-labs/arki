import type { CircuitBreakerPolicy, FailureReason, Policy, RetryPolicy, TimeoutPolicy } from './policy.js';

// ---------------------------------------------------------------------------
// Logger interface — intentionally minimal so callers can pass any logger.
// ---------------------------------------------------------------------------

export type PolicyLogger = {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
};

// ---------------------------------------------------------------------------
// Type guards for policy event detection
// ---------------------------------------------------------------------------

function hasRetryEvents(policy: Policy): policy is RetryPolicy {
  return 'onRetry' in policy;
}

function hasCircuitBreakerEvents(policy: Policy): policy is CircuitBreakerPolicy {
  return 'onBreak' in policy && 'onReset' in policy && 'onHalfOpen' in policy;
}

function hasTimeoutEvents(policy: Policy): policy is TimeoutPolicy {
  return 'onTimeout' in policy;
}

/** One line of text for a failure, whatever was thrown. */
function describe(reason: FailureReason): string {
  if ('error' in reason) {
    return reason.error instanceof Error ? reason.error.message : String(reason.error);
  }
  return String(reason.value);
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
export function attachPolicyLogger(policy: Policy, logger: PolicyLogger, policyName = 'resilience'): () => void {
  const disposables: { dispose(): void }[] = [];

  // Retry events
  if (hasRetryEvents(policy)) {
    disposables.push(
      policy.onRetry(({ attempt, delay }) => {
        logger.warn(`[${policyName}] Retry attempt`, { attempt, delay });
      }),
      policy.onGiveUp(failureReason => {
        logger.error(`[${policyName}] All retries exhausted`, {
          error: describe(failureReason),
        });
      }),
    );
  }

  // Circuit breaker events
  if (hasCircuitBreakerEvents(policy)) {
    disposables.push(
      policy.onBreak(failureReason => {
        if ('isolated' in failureReason) {
          logger.error(`[${policyName}] Circuit breaker opened (isolated)`);
        } else {
          logger.error(`[${policyName}] Circuit breaker opened`, {
            error: describe(failureReason),
          });
        }
      }),
      policy.onHalfOpen(() => {
        logger.info(`[${policyName}] Circuit breaker half-open`);
      }),
      policy.onReset(() => {
        logger.info(`[${policyName}] Circuit breaker closed`);
      }),
    );
  }

  // Timeout events
  if (hasTimeoutEvents(policy)) {
    disposables.push(
      policy.onTimeout(() => {
        logger.warn(`[${policyName}] Operation timed out`);
      }),
    );
  }

  // Success / failure events (available on every policy)
  disposables.push(
    policy.onSuccess(({ duration }) => {
      logger.info(`[${policyName}] Operation succeeded`, {
        durationMs: duration,
      });
    }),
    policy.onFailure(({ reason, duration }) => {
      logger.error(`[${policyName}] Operation failed`, {
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
