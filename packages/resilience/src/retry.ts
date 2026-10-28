// The retry policy. It is our own loop rather than cockatiel's `retry`, for two reasons:
// cockatiel waits with its own `setTimeout`, so a `Clock` could not drive the delay, and its
// retry decision is fixed up front (attempt count, error filter), while a `Backoff` answers
// "wait this long, or stop" per attempt. Cockatiel's `wrap` still composes it with the other
// policies through `engineOf`, which adapts any `Policy`.
//
// A try fails when it throws, or when it returns a failure from `@arki/failure`. A returned
// failure is an expected outcome, so it is retried only when the backoff's `while` says
// so, and when retrying stops the caller gets the last failure back as a value.

import type { Clock } from '@arki/clock';
import { isFailure } from '@arki/failure';

import type { RetryFailure } from './errors.js';
import { Cancelled } from './errors.js';
import { superviseObserver } from './observers.js';

import type { Backoff } from './backoff.js';
import type {
  FailureEvent,
  FailureReason,
  PolicyCallback,
  PolicyEvent,
  RetryEvent,
  RetryPolicy,
  SuccessEvent,
} from './policy.js';

/** Listeners of one event. Listening is rare and emitting is per call, so a plain array. */
function createEvent<E>(): { readonly on: PolicyEvent<E>; emit(event: E): void; readonly listening: () => boolean } {
  const listeners: ((event: E) => void)[] = [];
  return {
    on(listener) {
      const supervised = superviseObserver(listener);
      listeners.push(supervised);
      return {
        dispose() {
          const index = listeners.indexOf(supervised);
          if (index !== -1) listeners.splice(index, 1);
        },
      };
    },
    emit(event) {
      // Subscription changes apply to the next emission, not to an in-flight snapshot.
      const snapshot = [...listeners];
      for (const listener of snapshot) listener(event);
    },
    listening: () => listeners.length > 0,
  };
}

/** Milliseconds since some fixed point, for event durations. */
function nowMs(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

/** A signal that never aborts, for calls made without one. */
const neverAborted = new AbortController().signal;

/** Read a new cancellation snapshot: AbortSignal's readonly getter can change after work or observers. */
function retryCancellation(signal: AbortSignal) {
  return signal.aborted ? Cancelled({ cause: signal.reason }) : undefined;
}

/**
 * @internal A retry policy: tries `fn`, then waits on `clock` as long as `backoff` says,
 * until it says stop. Then it rethrows the last error, or returns the last failure.
 */
export function buildRetryPolicy(backoff: Backoff, clock: Clock): RetryPolicy {
  const success = createEvent<SuccessEvent>();
  const failure = createEvent<FailureEvent>();
  const retry = createEvent<RetryEvent>();
  const giveUp = createEvent<FailureReason>();

  async function execute<T>(fn: PolicyCallback<T>, signal: AbortSignal = neverAborted): Promise<T | RetryFailure> {
    for (let attempt = 0; ; attempt++) {
      const beforeAttempt = retryCancellation(signal);
      if (beforeAttempt !== undefined) return beforeAttempt;
      const started = success.listening() || failure.listening() ? nowMs() : 0;
      let failed: { readonly error: unknown } | { readonly value: Awaited<T> };
      try {
        const value = await fn({ signal, attempt });
        if (!isFailure<unknown>(value)) {
          if (success.listening()) success.emit({ duration: nowMs() - started });
          return value;
        }
        failed = { value };
      } catch (error) {
        failed = { error };
      }
      const delay = signal.aborted
        ? undefined
        : backoff.delay(attempt + 1, 'error' in failed ? failed.error : failed.value);
      if (failure.listening()) {
        failure.emit({ duration: nowMs() - started, handled: delay !== undefined, reason: failed });
      }
      const afterFailure = retryCancellation(signal);
      if (afterFailure !== undefined) return 'value' in failed ? failed.value : afterFailure;
      if (delay === undefined) {
        if ('error' in failed) {
          giveUp.emit(failed);
          const afterGiveUp = retryCancellation(signal);
          if (afterGiveUp !== undefined) return afterGiveUp;
          throw failed.error;
        }
        // A failure that was never retried is simply the answer; only a retried one ran out of retries.
        if (attempt > 0) giveUp.emit(failed);
        return failed.value;
      }
      retry.emit({ ...failed, attempt: attempt + 1, delay });
      const afterRetry = retryCancellation(signal);
      if (afterRetry !== undefined) return 'value' in failed ? failed.value : afterRetry;
      const sleepResult = await clock.sleep(delay, signal);
      if (sleepResult !== undefined) return sleepResult;

    }
  }

  return {
    execute,
    onSuccess: success.on,
    onFailure: failure.on,
    onRetry: retry.on,
    onGiveUp: giveUp.on,
  };
}
