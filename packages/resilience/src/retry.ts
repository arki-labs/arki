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
import { MAX_TIMER_MS, SLEEP_FAILURES } from '@arki/clock';
import { is } from '@arki/schema';
import { z } from 'zod';
import { isFailure, UnexpectedDefect } from '@arki/failure';

import type { RetryFailure } from './errors.js';
import { Cancelled } from './errors.js';
import { createEvent } from './event.js';
import { ownPolicy } from './engine.js';
import { withPolicySpan } from './telemetry.js';
import { startTiming, elapsedTime } from './timing.js';

import type { Backoff } from './backoff.js';
import type {
  FailureEvent,
  FailureReason,
  PolicyCallback,
  RetryEvent,
  RetryPolicy,
  SuccessEvent,
} from './policy.js';

/** @internal The canonical Clock definitions own the accepted wait outcomes. */
export const clockSleepOutcomeSchema = z.union([
  z.void(), z.custom<SleepFailure>(value => SLEEP_FAILURES.some(definition => definition.is(value))),
]);
/** @internal A foreign Backoff must return an actual bounded delay or stop. */
export const retryDelaySchema = z.number().min(0).max(MAX_TIMER_MS).optional();
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
      const started = success.listening() || failure.listening() ? startTiming() : undefined;
      // Instrumentation may synchronously cancel after the loop preflight.
      const call = () => retryCancellation(signal) ?? fn({ signal, attempt });
      let failed: { readonly error: unknown } | { readonly value: Awaited<ReturnType<typeof call>> };
      try {
        const value = await withPolicySpan('resilience.attempt', call, { 'resilience.attempt': attempt });
        if (!isFailure<unknown>(value)) {
          if (success.listening()) {
            const elapsed = elapsedTime(started);
            if (elapsed !== undefined) success.emit({ duration: elapsed });
          }
          return value;
        }
        failed = { value };
      } catch (error) {
        failed = { error };
      }
      let delay: ReturnType<Backoff['delay']>;
      try {
        const provided: unknown = signal.aborted ? undefined : backoff.delay(attempt + 1, 'error' in failed ? failed.error : failed.value);
        if (!is(provided, retryDelaySchema)) {
          void Promise.resolve(provided).catch(() => { /* A synchronous protocol cannot return a rejected promise. */ });
          return UnexpectedDefect({ cause: provided });
        }
        delay = provided;
      } catch (error) {
        return UnexpectedDefect({ cause: error });
      }
      if (failure.listening()) {
        const elapsed = elapsedTime(started);
        if (elapsed !== undefined) failure.emit({ duration: elapsed, handled: delay !== undefined, reason: failed });
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
      try {
        const sleepResult = await withPolicySpan('resilience.wait', async () => {
          const beforeWait = retryCancellation(signal);
          if (beforeWait !== undefined) return 'value' in failed ? failed.value : beforeWait;
          const outcome: unknown = await clock.sleep(delay, signal);
          return is(outcome, clockSleepOutcomeSchema) ? outcome : UnexpectedDefect({ cause: outcome });
        }, {
          'resilience.attempt': attempt + 1,
          'resilience.delay_ms': delay,
        });
        if (sleepResult !== undefined) return sleepResult;
      } catch (error) {
        return UnexpectedDefect({ cause: error });
      }
    }
  }

  const policy: RetryPolicy = { execute, onSuccess: success.on, onFailure: failure.on, onRetry: retry.on, onGiveUp: giveUp.on };
  return Object.assign(ownPolicy(policy), {
    onRetry: retry.on,
    onGiveUp: giveUp.on,
  });
}
