import type { CircuitBreakerPolicy, IPolicy, RetryPolicy, TimeoutPolicy } from 'cockatiel';

// ---------------------------------------------------------------------------
// Logger interface — intentionally minimal so callers can pass any logger.
// ---------------------------------------------------------------------------

export type PolicyLogger = {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
};

// ---------------------------------------------------------------------------
// Type guards for cockatiel policy event detection
// ---------------------------------------------------------------------------

function hasRetryEvents(policy: IPolicy): policy is IPolicy & RetryPolicy {
  return 'onRetry' in policy;
}

function hasCircuitBreakerEvents(policy: IPolicy): policy is IPolicy & CircuitBreakerPolicy {
  return 'onBreak' in policy && 'onReset' in policy && 'onHalfOpen' in policy;
}

function hasTimeoutEvents(policy: IPolicy): policy is IPolicy & TimeoutPolicy {
  return 'onTimeout' in policy;
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
export function attachPolicyLogger(policy: IPolicy, logger: PolicyLogger, policyName = 'resilience'): () => void {
  const disposables: { dispose(): void }[] = [];

  // Retry events
  if (hasRetryEvents(policy)) {
    disposables.push(
      policy.onRetry(({ attempt, delay }) => {
        logger.warn(`[${policyName}] Retry attempt`, { attempt, delay });
      }),
      policy.onGiveUp(failureReason => {
        const errorMsg = 'error' in failureReason ? failureReason.error.message : String(failureReason.value);
        logger.error(`[${policyName}] All retries exhausted`, {
          error: errorMsg,
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
          const errorMsg = 'error' in failureReason ? failureReason.error.message : String(failureReason.value);
          logger.error(`[${policyName}] Circuit breaker opened`, {
            error: errorMsg,
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

  // Success / failure events (available on all IPolicy)
  disposables.push(
    policy.onSuccess(({ duration }) => {
      logger.info(`[${policyName}] Operation succeeded`, {
        durationMs: duration,
      });
    }),
    policy.onFailure(({ reason, duration }) => {
      const errorMsg = 'error' in reason ? reason.error.message : String(reason.value);
      logger.error(`[${policyName}] Operation failed`, {
        error: errorMsg,
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
