import type { Clock } from '@arki/clock';

import { abortedError, invalidWait, isValidWait } from './errors.js';
import { systemClock } from './system-clock.js';

/** Options of {@link sleep}. */
export type SleepOptions = {
  /** Cuts the wait short. The promise rejects with `ARKI_ASYNC_E002`, and `cause` is `signal.reason`. */
  readonly signal?: AbortSignal;
  /** Whose timer to wait on. Default: the system clock. Pass a `MockClock` to make tests instant. */
  readonly clock?: Clock;
};

/**
 * Resolves after `ms` milliseconds. `0` still waits for the next macrotask.
 *
 * Never throws synchronously: an invalid `ms` (`ARKI_ASYNC_E001`) or an abort
 * (`ARKI_ASYNC_E002`) rejects the returned promise. An already-aborted signal
 * rejects without creating a timer. Settling clears the timer and the abort
 * listener, so nothing stays alive.
 */
export function sleep(ms: number, options: SleepOptions = {}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!isValidWait(ms)) {
      const failure = invalidWait('sleep', 'ms', ms);
      reject(failure);
      return;
    }
    const { signal, clock = systemClock } = options;
    if (signal?.aborted) {
      reject(abortedError('sleep()', signal.reason));
      return;
    }
    if (signal === undefined) {
      clock.setTimer(resolve, ms);
      return;
    }
    const onAbort = (): void => {
      cancel();
      reject(abortedError('sleep()', signal.reason));
    };
    const cancel = clock.setTimer(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
