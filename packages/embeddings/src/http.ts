/** The `fetch` a fetch-based provider calls. Narrower than `typeof fetch` so a test stub needs no runtime extras. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Milliseconds to wait from `retry-after-ms`, or `retry-after` as seconds or an HTTP date. */
export function retryAfterMs(read: (name: string) => string | null | undefined): number | undefined {
  const ms = Number(read('retry-after-ms') ?? Number.NaN);
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const header = read('retry-after');
  if (header === null || header === undefined) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** The longest a single provider request may take, in milliseconds. The same bound `withResilience` puts on an attempt. */
export const REQUEST_TIMEOUT_MS = 60_000;

/**
 * The signal a provider request runs under: the caller's `signal` (when given) plus a timeout. A timeout
 * does not abort the caller's signal, so the model reports it as `ModelUnavailable { reason: 'unreachable' }`
 * and a caller's abort stays `Cancelled`.
 *
 * Uses `AbortSignal.timeout` and `AbortSignal.any` where the engine has them. React Native's `AbortSignal`
 * (the `abort-controller` package) has neither, so there a controller and a timer do the same job.
 */
export function requestSignal(signal: AbortSignal | undefined, timeoutMs = REQUEST_TIMEOUT_MS): AbortSignal {
  const timeout = 'timeout' in AbortSignal ? AbortSignal.timeout(timeoutMs) : timerSignal(timeoutMs);
  if (signal === undefined) return timeout;
  return 'any' in AbortSignal ? AbortSignal.any([signal, timeout]) : firstAbort(signal, timeout);
}

/** A signal that aborts with a `TimeoutError` after `ms`, like `AbortSignal.timeout`. */
function timerSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  const reason = new Error('The operation timed out.');
  reason.name = 'TimeoutError';
  setTimeout(() => controller.abort(reason), ms);
  return controller.signal;
}

/** A signal that aborts when either input does, with that input's reason, like `AbortSignal.any`. */
function firstAbort(first: AbortSignal, second: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const settled = first.aborted ? first : second.aborted ? second : undefined;
  if (settled !== undefined) {
    controller.abort(settled.reason);
    return controller.signal;
  }
  const onFirst = (): void => follow(first);
  const onSecond = (): void => follow(second);
  function follow(source: AbortSignal): void {
    first.removeEventListener('abort', onFirst);
    second.removeEventListener('abort', onSecond);
    controller.abort(source.reason);
  }
  first.addEventListener('abort', onFirst);
  second.addEventListener('abort', onSecond);
  return controller.signal;
}
