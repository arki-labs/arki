import { assertWait } from './errors.js';

/** A debounced or throttled function. */
export type Scheduled<A extends readonly unknown[]> = {
  (...args: A): void;
  /** Drops the pending call and resets the timers. */
  cancel(): void;
  /** Runs the pending trailing call now, if there is one. */
  flush(): void;
  /** True while a timer is running and a call may still fire. */
  readonly pending: boolean;
};

/** Options of {@link debounce}. */
export type DebounceOptions = {
  /** Call on the first call of a burst. Default `false`. */
  readonly leading?: boolean;
  /** Call after the burst ends. Default `true`. */
  readonly trailing?: boolean;
  /** Longest time a burst may delay the call. Raised to `wait` when smaller. */
  readonly maxWait?: number;
};

/** Options of {@link throttle}. */
export type ThrottleOptions = {
  /** Call on the first call of a window. Default `true`. */
  readonly leading?: boolean;
  /** Call at the end of the window with the latest arguments. Default `true`. */
  readonly trailing?: boolean;
};

/**
 * Same algorithm as lodash's debounce, so the two behave identically:
 * the latest arguments win, and a call that arrives while the timer runs
 * never starts a second timer.
 */
function schedule<A extends readonly unknown[]>(
  name: string,
  fn: (...args: A) => void,
  wait: number,
  leading: boolean,
  trailing: boolean,
  maxWait: number | undefined,
): Scheduled<A> {
  assertWait(name, 'wait', wait);
  if (maxWait !== undefined) assertWait(name, 'maxWait', maxWait);
  const longest = maxWait === undefined ? undefined : Math.max(maxWait, wait);

  let lastArgs: A | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastCallTime: number | undefined;
  let lastInvokeTime = 0;

  const invoke = (time: number): void => {
    const args = lastArgs;
    lastArgs = undefined;
    lastInvokeTime = time;
    if (args !== undefined) fn(...args);
  };

  const remaining = (time: number): number => {
    const waiting = wait - (time - (lastCallTime ?? time));
    return longest === undefined ? waiting : Math.min(waiting, longest - (time - lastInvokeTime));
  };

  const shouldInvoke = (time: number): boolean => {
    if (lastCallTime === undefined) return true;
    const sinceCall = time - lastCallTime;
    return sinceCall >= wait || sinceCall < 0 || (longest !== undefined && time - lastInvokeTime >= longest);
  };

  const trailingEdge = (time: number): void => {
    timer = undefined;
    if (trailing && lastArgs !== undefined) invoke(time);
    else lastArgs = undefined;
  };

  const expired = (): void => {
    const time = Date.now();
    if (shouldInvoke(time)) trailingEdge(time);
    else timer = setTimeout(expired, remaining(time));
  };

  const scheduled = (...args: A): void => {
    const time = Date.now();
    const invoking = shouldInvoke(time);
    lastArgs = args;
    lastCallTime = time;
    if (invoking) {
      if (timer === undefined) {
        lastInvokeTime = time;
        timer = setTimeout(expired, wait);
        if (leading) invoke(time);
        return;
      }
      if (longest !== undefined) {
        clearTimeout(timer);
        timer = setTimeout(expired, wait);
        invoke(time);
        return;
      }
    }
    timer ??= setTimeout(expired, wait);
  };

  Object.defineProperties(scheduled, {
    cancel: {
      value: (): void => {
        if (timer !== undefined) clearTimeout(timer);
        lastInvokeTime = 0;
        lastArgs = lastCallTime = timer = undefined;
      },
    },
    flush: {
      value: (): void => {
        if (timer === undefined) return;
        clearTimeout(timer);
        trailingEdge(Date.now());
      },
    },
    pending: { get: (): boolean => timer !== undefined },
  });
  if (!isScheduled<A>(scheduled)) throw new TypeError('unreachable: scheduled function is missing its controls');
  return scheduled;
}

/** Real check, so the compiler learns the shape from the runtime rather than from a cast. */
function isScheduled<A extends readonly unknown[]>(f: (...args: A) => void): f is Scheduled<A> {
  return 'cancel' in f && 'flush' in f && 'pending' in f;
}

/**
 * Delays `fn` until `wait` ms have passed without a new call. The latest
 * arguments win. Defaults: `leading: false`, `trailing: true`. Throws
 * `ARKI_ASYNC_E001` for an invalid `wait` or `maxWait`.
 */
export function debounce<A extends readonly unknown[]>(
  fn: (...args: A) => void,
  wait: number,
  options: DebounceOptions = {},
): Scheduled<A> {
  return schedule('debounce', fn, wait, options.leading ?? false, options.trailing ?? true, options.maxWait);
}

/**
 * Calls `fn` at most once per `wait` ms. It is a debounce with `maxWait = wait`.
 * Defaults: `leading: true`, `trailing: true`. Throws `ARKI_ASYNC_E001` for an invalid `wait`.
 */
export function throttle<A extends readonly unknown[]>(
  fn: (...args: A) => void,
  wait: number,
  options: ThrottleOptions = {},
): Scheduled<A> {
  return schedule('throttle', fn, wait, options.leading ?? true, options.trailing ?? true, wait);
}
