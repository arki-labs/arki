import { abortedError, invalidWait, isValidWait } from './errors.js';

/** Options of {@link sleep}. */
export type SleepOptions = {
  /** Cuts the wait short. The promise rejects with `ARKI_ASYNC_E002`, and `cause` is `signal.reason`. */
  readonly signal?: AbortSignal;
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
    const { signal } = options;
    if (signal?.aborted) {
      reject(abortedError('sleep()', signal.reason));
      return;
    }
    if (signal === undefined) {
      setTimeout(resolve, ms);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortedError('sleep()', signal.reason));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
