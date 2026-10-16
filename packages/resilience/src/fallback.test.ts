import { describe, expect, it, vi } from 'vitest';

import {
  backoff,
  CancelledError,
  CircuitOpenError,
  createCircuitBreakerPolicy,
  createResiliencePolicy,
  createTimeoutPolicy,
  isBrokenCircuitError,
  noop,
  withFallback,
  wrap,
} from './index.js';

/** A call that never finishes on its own. */
const ignore = (): void => {
  // intentionally pending forever
};

/** Passed to `.catch` where the test only needs the call to settle. */
function swallow(): void {
  // the failure is expected
}

const boom = (): never => {
  throw new Error('down');
};

describe('withFallback', () => {
  it('an open breaker serves the fallback without calling the function', async () => {
    const breaker = createCircuitBreakerPolicy({ consecutiveFailures: 1 });
    await breaker.execute(boom).catch(swallow);
    const guarded = withFallback(breaker, () => 'cached');
    const fn = vi.fn(() => 'live');

    expect(await guarded.execute(fn)).toBe('cached');
    expect(fn).not.toHaveBeenCalled();
  });

  it('the fallback receives the policy error, so callers can decide by error type', async () => {
    const breaker = createCircuitBreakerPolicy({ consecutiveFailures: 1 });
    await breaker.execute(boom).catch(swallow);
    const seen: unknown[] = [];
    await withFallback(breaker, error => seen.push(error)).execute(() => 1);

    expect(seen[0]).toBeInstanceOf(CircuitOpenError);
  });

  it('runs once after the retries are used up, not once per attempt', async () => {
    const policy = createResiliencePolicy({ retry: backoff.constant(1).upTo(2) });
    const fallback = vi.fn(() => 'last answer');
    const fn = vi.fn(boom);

    expect(await withFallback(policy, fallback).execute(fn)).toBe('last answer');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('never runs on success, and awaits an async fallback', async () => {
    const fallback = vi.fn(() => Promise.resolve('x'));
    expect(await withFallback(noop, fallback).execute(() => 'own')).toBe('own');
    expect(fallback).not.toHaveBeenCalled();
    expect(await withFallback(noop, fallback).execute(boom)).toBe('x');
  });

  it('a synchronous throw in the function reaches the fallback', async () => {
    expect(await withFallback(noop, () => 0).execute(boom)).toBe(0);
  });

  it('a fallback that throws lets its error through (the selective pattern)', async () => {
    const selective = withFallback(noop, (error: unknown) => {
      if (!isBrokenCircuitError(error)) throw error;
      return 'cached';
    });
    await expect(selective.execute(() => Promise.reject(new RangeError('mine')))).rejects.toBeInstanceOf(RangeError);
  });

  it('a caller abort is not hidden by the fallback', async () => {
    const fallback = vi.fn(() => 'hidden');
    const policy = withFallback(wrap(createTimeoutPolicy({ timeoutMs: 10_000 })), fallback);
    const controller = new AbortController();
    const call = policy.execute(() => new Promise<never>(ignore), controller.signal);
    controller.abort();

    await expect(call).rejects.toBeInstanceOf(CancelledError);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('passes the inner policy events through', async () => {
    const onSuccess = vi.fn();
    const policy = withFallback(noop, () => 1);
    policy.onSuccess(onSuccess);
    await policy.execute(() => 2);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});
