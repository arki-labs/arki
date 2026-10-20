// The retry policy. It is our own loop rather than cockatiel's `retry`, for two reasons:
// cockatiel waits with its own `setTimeout`, so a `Clock` could not drive the delay, and its
// retry decision is fixed up front (attempt count, error filter), while a `Backoff` answers
// "wait this long, or stop" per attempt. Cockatiel's `wrap` still composes it with the other
// policies through `engineOf`, which adapts any `Policy`.
//
// A try fails when it throws, or when it returns a failure from `@arki/failure`. A returned
// failure is an expected outcome, so it is retried only when the backoff's `while` says
// so, and when retrying stops the caller gets the last failure back as a value.

import type { Clock, SleepFailure } from '@arki/clock';
import { isFailure } from '@arki/failure';

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
      listeners.push(listener);
      return {
        dispose() {
          const index = listeners.indexOf(listener);
          if (index !== -1) listeners.splice(index, 1);
        },
      };
    },
    emit(event) {
      for (const listener of listeners) listener(event);
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

/**
 * @internal A retry policy: tries `fn`, then waits on `clock` as long as `backoff` says,
 * until it says stop. Then it rethrows the last error, or returns the last failure.
 */
export function buildRetryPolicy(backoff: Backoff, clock: Clock): RetryPolicy {
  const success = createEvent<SuccessEvent>();
  const failure = createEvent<FailureEvent>();
  const retry = createEvent<RetryEvent>();
  const giveUp = createEvent<FailureReason>();

  async function execute<T>(fn: PolicyCallback<T>, signal: AbortSignal = neverAborted): Promise<T | SleepFailure> {
    for (let attempt = 0; ; attempt++) {
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
      if (delay === undefined) {
        if ('error' in failed) {
          giveUp.emit(failed);
          throw failed.error;
        }
        // A failure that was never retried is simply the answer; only a retried one ran out of retries.
        if (attempt > 0) giveUp.emit(failed);
        return failed.value;
      }
      retry.emit({ ...failed, attempt: attempt + 1, delay });
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
