// A loop that pushes items to an API meets two kinds of trouble: an answer that is a failure
// ("token refused", "service unavailable"), and a throw that outlasted the retries (the network,
// a deadline, an open circuit). Without `onThrow` the loop needs a failure check for the first
// and a try/catch for the second. With it, the throw comes back as a failure too, so the loop
// has one error path. Errors the mapper does not recognise are rethrown, so bugs still throw.

import { describe, expect, expectTypeOf, it } from 'vitest';

import type { Failure } from '@arki/failure';
import type { SleepFailure } from '@arki/clock';
import { MockClock } from '@arki/clock';
import { defineFailure, isFailure } from '@arki/failure';

import type { Policy, ResiliencePolicy, RetryPolicy } from './index.js';
import {
  backoff,
  BulkheadRejectedError,
  CancelledError,
  CircuitOpenError,
  createResiliencePolicy,
  createRetryPolicy,
  TimeoutError,
  withRetry,
  wrap,
} from './index.js';

const Unavailable = defineFailure('push.unavailable', { status: 503 });

/** A network error that every attempt hits. */
const networkDown = (): never => {
  throw new TypeError('fetch failed');
};

/** A call that never finishes on its own. */
const pending = (): Promise<never> =>
  new Promise(() => {
    // stays pending until a timeout gives up on it
  });

describe('onThrow on createResiliencePolicy', () => {
  it('a network error that outlasts the retries comes back as the failure, so a loop has one error path', async () => {
    const clock = new MockClock();
    const policy = createResiliencePolicy({
      retry: backoff.constant(1000).upTo(2),
      clock,
      onThrow: cause => Unavailable({ cause }),
    });
    let calls = 0;

    const result = policy.execute(() => {
      calls++;
      return networkDown();
    });
    await clock.advanceAsync(5000);
    const settled = await result;

    expect(calls).toBe(3); // the retries ran first: onThrow sees only what outlasts them
    expect(Unavailable.is(settled)).toBe(true);
    expect(isFailure(settled) && settled.cause).toBeInstanceOf(TypeError);
  });

  it('a mapper that rethrows what it does not recognise keeps that error a bug', async () => {
    const policy = createResiliencePolicy({
      retry: backoff.constant(1).upTo(0),
      onThrow: cause => {
        if (cause instanceof TypeError) return Unavailable({ cause });
        throw cause;
      },
    });

    await expect(
      policy.execute(() => {
        throw new RangeError('index out of range');
      }),
    ).rejects.toThrow(RangeError);
  });

  it('an open circuit is a throw too, so it reaches onThrow', async () => {
    const policy = createResiliencePolicy({
      retry: backoff.constant(1).upTo(0),
      circuitBreaker: { consecutiveFailures: 1 },
      onThrow: cause => (cause instanceof CircuitOpenError ? 'circuit open' : 'network'),
    });

    expect(await policy.execute(networkDown)).toBe('network');
    expect(await policy.execute(() => 'never runs')).toBe('circuit open');
  });

  it('a deadline is a throw too, so it reaches onThrow', async () => {
    const policy = createResiliencePolicy({
      retry: backoff.constant(1).upTo(0),
      timeout: { timeoutMs: 5 },
      onThrow: cause => (cause instanceof TimeoutError ? 'timed out' : 'other'),
    });

    expect(await policy.execute(pending)).toBe('timed out');
  });

  it('a full bulkhead is a throw too, so it reaches onThrow', async () => {
    const policy = createResiliencePolicy({
      retry: backoff.constant(1).upTo(0),
      timeout: { timeoutMs: 50 },
      bulkhead: { maxConcurrent: 1, maxQueue: 0 },
      onThrow: cause => (cause instanceof BulkheadRejectedError ? 'full' : 'other'),
    });

    const holding = policy.execute(pending);
    expect(await policy.execute(() => 'never runs')).toBe('full');
    expect(await holding).toBe('other'); // its own deadline, mapped as well
  });

  it('a cancel is never mapped: the caller asked to stop, so nothing was unavailable', async () => {
    const controller = new AbortController();
    let mapped = 0;
    const policy = createResiliencePolicy({
      onThrow: () => {
        mapped++;
        return 'mapped';
      },
    });

    const result = policy.execute(pending, controller.signal);
    controller.abort();

    await expect(result).rejects.toBeInstanceOf(CancelledError);
    expect(mapped).toBe(0);
  });

  it('a returned failure is the answer as before; onThrow sees throws only', async () => {
    const Refused = defineFailure('push.refused', { status: 422 });
    const policy = createResiliencePolicy({ onThrow: cause => Unavailable({ cause }) });

    expect(Refused.is(await policy.execute(() => Refused()))).toBe(true);
  });

  it('keeps its components, so their events can still be heard', () => {
    const policy = createResiliencePolicy({ onThrow: () => null });

    expect(typeof policy.components.retry.onRetry).toBe('function');
    expect(typeof policy.components.circuitBreaker.onBreak).toBe('function');
  });

  it('without onThrow it still throws', async () => {
    const policy = createResiliencePolicy({ retry: backoff.constant(1).upTo(0) });

    await expect(policy.execute(networkDown)).rejects.toThrow('fetch failed');
  });
});

describe('onThrow on createRetryPolicy and withRetry', () => {
  it('maps the error the retries gave up on, and keeps the retry events', async () => {
    const clock = new MockClock();
    const policy = createRetryPolicy({
      backoff: backoff.constant(1000).upTo(1),
      clock,
      onThrow: cause => Unavailable({ cause }),
    });
    const retries: number[] = [];
    policy.onRetry(event => retries.push(event.attempt));

    const result = policy.execute(networkDown);
    await clock.advanceAsync(1000);

    expect(Unavailable.is(await result)).toBe(true);
    expect(retries).toEqual([1]);
  });

  it('withRetry takes onThrow too', async () => {
    const result = await withRetry(networkDown, {
      backoff: backoff.constant(1).upTo(0),
      onThrow: () => 'offline' as const,
    });

    expect(result).toBe('offline');
  });
});

describe('onThrow types', () => {
  it('adds what the mapper returns to the result: T | Mapped', () => {
    const policy = createResiliencePolicy({ onThrow: cause => Unavailable({ cause }) });

    expectTypeOf(policy).toEqualTypeOf<ResiliencePolicy<Failure<'push.unavailable', undefined>>>();
    expectTypeOf(policy.execute(() => 42)).toEqualTypeOf<Promise<number | Failure<'push.unavailable', undefined> | SleepFailure>>();
  });

  it('an async mapper unwraps, and a rethrowing branch adds nothing', () => {
    const policy = createRetryPolicy({
      onThrow: (cause: unknown) => {
        if (cause instanceof RangeError) throw cause;
        return Promise.resolve('cached' as const);
      },
    });

    expectTypeOf(policy).toEqualTypeOf<RetryPolicy<'cached'>>();
  });

  it('without onThrow nothing is added, and the policy is a plain Policy that wrap accepts', () => {
    const plain = createResiliencePolicy();

    expectTypeOf(plain.execute(() => 42)).toEqualTypeOf<Promise<number | SleepFailure>>();
    expectTypeOf(plain).toExtend<Policy<never, SleepFailure>>();
    expectTypeOf(createRetryPolicy()).toEqualTypeOf<RetryPolicy>();
  });

  it('a policy with onThrow is not a plain Policy: inside wrap it would hide the errors the retry needs', () => {
    const mapped = createRetryPolicy({ onThrow: () => null });
    // @ts-expect-error -- it can resolve a value the function never returned
    const plain: Policy = mapped;
    void plain;
    // @ts-expect-error -- not accepted inside wrap
    const wrapped = wrap(createRetryPolicy(), mapped);
    void wrapped;
  });
});
