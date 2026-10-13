// The public shape of a policy. Nothing here names the underlying engine, so the
// engine can change without changing this file or anything built on it.

/** What a wrapped function receives on every call. */
export type PolicyContext = {
  /**
   * Aborted when the caller's signal aborts or when a timeout policy reaches its
   * deadline. A timeout policy also aborts it once the function has returned.
   */
  readonly signal: AbortSignal;
  /** 0 for the first call and 1 for the first retry. Always 0 when the policy has no retry. */
  readonly attempt: number;
};

/** The function a policy runs. */
export type PolicyCallback<T> = (context: PolicyContext) => PromiseLike<T> | T;

/** Returned by every event method. Call `dispose()` to stop listening. */
export type Subscription = { dispose(): void };

/** An event method: pass a listener, get a subscription back. */
export type PolicyEvent<E> = (listener: (event: E) => void) => Subscription;

/** Why a call counted as a failure: the error it threw, or the value the policy rejected. */
export type FailureReason = { error: unknown } | { value: unknown };

export type SuccessEvent = {
  /** Wall-clock time of the call in milliseconds. */
  duration: number;
};

export type FailureEvent = {
  /** Wall-clock time of the call in milliseconds. */
  duration: number;
  /** Whether the policy handled this failure (retried it, counted it, …). */
  handled: boolean;
  reason: FailureReason;
};

/** Fired before each retry, after the failed attempt and before the backoff delay. */
export type RetryEvent = FailureReason & {
  /** The retry about to run: 1 for the first retry. */
  attempt: number;
  /** Backoff delay in milliseconds before that retry. */
  delay: number;
};

/** Fired when a circuit breaker opens. `isolated` means it was opened by hand. */
export type BreakEvent = FailureReason | { isolated: true };

/** Any policy: runs a function and reports how each call ended. */
export type Policy = {
  execute<T>(fn: PolicyCallback<T>, signal?: AbortSignal): Promise<T>;
  /** Fires once per call that ends well, even when that took retries. */
  readonly onSuccess: PolicyEvent<SuccessEvent>;
  /** Fires on every failed attempt the policy sees. */
  readonly onFailure: PolicyEvent<FailureEvent>;
};

export type RetryPolicy = Policy & {
  readonly onRetry: PolicyEvent<RetryEvent>;
  /** Fires when the last attempt has failed and the error is about to reach the caller. */
  readonly onGiveUp: PolicyEvent<FailureReason>;
};

export type CircuitBreakerPolicy = Policy & {
  readonly onBreak: PolicyEvent<BreakEvent>;
  /** Fires when the breaker lets a trial call through after `halfOpenAfter`. */
  readonly onHalfOpen: PolicyEvent<void>;
  /** Fires when a trial call succeeds and the breaker closes again. */
  readonly onReset: PolicyEvent<void>;
};

export type TimeoutPolicy = Policy & {
  readonly onTimeout: PolicyEvent<void>;
};

export type BulkheadPolicy = Policy & {
  /** Fires when a call is turned away because both the slots and the queue are full. */
  readonly onReject: PolicyEvent<void>;
};
