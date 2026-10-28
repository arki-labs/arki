import { describe, expect, it, vi } from 'vitest';

import { orThrow, UnexpectedDefect } from '@arki/failure';

import {
  backoff,
  Cancelled,
  CircuitOpen,
  createCircuitBreakerPolicy,
  createResiliencePolicy,
  createTimeoutPolicy,
  noop,
  withFallback,
  wrap,
} from './index.js';

/** A call that never finishes on its own. */
const ignore = (): void => {
  // intentionally pending forever
};

const boom = (): never => {
  throw new Error('down');
};

describe('withFallback', () => {
  it('an open breaker returns its refusal without calling work or fallback', async () => {
    const breaker = createCircuitBreakerPolicy({ consecutiveFailures: 1 });
    expect(UnexpectedDefect.is(await breaker.execute(boom))).toBe(true);
    const guarded = withFallback(breaker, () => 'cached');
    const fn = vi.fn(() => 'live');

    expect(CircuitOpen.is(await guarded.execute(fn))).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('engine refusals never enter a throw fallback', async () => {
    const breaker = createCircuitBreakerPolicy({ consecutiveFailures: 1 });
    expect(UnexpectedDefect.is(await breaker.execute(boom))).toBe(true);
    const seen: unknown[] = [];
    expect(CircuitOpen.is(await withFallback(breaker, error => seen.push(error)).execute(() => 1))).toBe(true);

    expect(seen).toEqual([]);
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

  it('a selective fallback that rethrows returns the original defect', async () => {
    const selective = withFallback(noop, (error: unknown) => {
      if (!(error instanceof TypeError)) throw error;
      return 'cached';
    });
    await expect(selective.execute(() => Promise.reject(new RangeError('mine')))).resolves.toMatchObject({
      code: 'failure.unexpected_defect',
      cause: expect.any(RangeError),
    });
  });

  it('a caller abort is not hidden by the fallback', async () => {
    const fallback = vi.fn(() => 'hidden');
    const policy = withFallback(wrap(createTimeoutPolicy({ timeoutMs: 10_000 })), fallback);
    const controller = new AbortController();
    const call = policy.execute(() => new Promise<never>(ignore), controller.signal);
    controller.abort();

    await expect(call).resolves.toMatchObject({ code: Cancelled.code });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('passes the inner policy events through', async () => {
    const onSuccess = vi.fn();
    const policy = withFallback(noop, () => 1);
    policy.onSuccess(onSuccess);
    orThrow(await policy.execute(() => 2));
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});
