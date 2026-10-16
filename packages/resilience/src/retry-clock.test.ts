// The reason retry takes a clock: a retry with real-size delays (seconds) must be testable
// without waiting those seconds and without faking the global timers.

import { describe, expect, it } from 'vitest';

import { MockClock } from '@arki/clock';

import { backoff, CancelledError, createResiliencePolicy, createRetryPolicy, withRetry } from './index.js';

/** A function that fails `failures` times, then returns 'ok'. Records the clock time of each call. */
function flaky(clock: MockClock, failures: number) {
  const calledAt: number[] = [];
  const fn = () => {
    calledAt.push(clock.now().getTime());
    if (calledAt.length <= failures) throw new Error(`failure ${String(calledAt.length)}`);
    return 'ok';
  };
  return { fn, calledAt };
}

describe('retry delays on a MockClock', () => {
  it('waits 1 s, 2 s and 4 s of clock time between tries, and finishes without real waiting', async () => {
    const clock = new MockClock();
    const { fn, calledAt } = flaky(clock, 3);
    const policy = createRetryPolicy({ backoff: backoff.exponential({ base: 1000 }).upTo(3), clock });
    const started = Date.now();

    const result = policy.execute(fn);
    await clock.advanceAsync(10_000);

    await expect(result).resolves.toBe('ok');
    expect(calledAt).toEqual([0, 1000, 3000, 7000]);
    // Seven seconds of retry delay took far less than one real second.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('does not retry before the delay is over on the clock', async () => {
    const clock = new MockClock();
    const { fn, calledAt } = flaky(clock, 1);
    const result = withRetry(fn, { backoff: backoff.constant(30_000).upTo(1), clock });

    await clock.advanceAsync(29_999);
    expect(calledAt).toEqual([0]);
    await clock.advanceAsync(1);
    await expect(result).resolves.toBe('ok');
    expect(calledAt).toEqual([0, 30_000]);
  });

  it('gives up after upTo retries and rethrows the last error', async () => {
    const clock = new MockClock();
    const { fn, calledAt } = flaky(clock, 10);
    const result = createRetryPolicy({ backoff: backoff.constant(5000).upTo(2), clock }).execute(fn);
    const settled = result.catch((error: unknown) => error);

    await clock.advanceAsync(60_000);

    await expect(settled).resolves.toMatchObject({ message: 'failure 3' });
    expect(calledAt).toEqual([0, 5000, 10_000]);
  });

  it('stops at once for an error that while() rejects', async () => {
    const clock = new MockClock();
    let calls = 0;
    const policy = createRetryPolicy({
      backoff: backoff
        .constant(1000)
        .upTo(5)
        .while(error => !(error instanceof RangeError)),
      clock,
    });
    const result = policy.execute(() => {
      calls += 1;
      throw new RangeError('bad input, retrying will not help');
    });

    await expect(result).rejects.toBeInstanceOf(RangeError);
    expect(calls).toBe(1);
  });

  it('reports the backoff delay in onRetry', async () => {
    const clock = new MockClock();
    const { fn } = flaky(clock, 2);
    const policy = createRetryPolicy({ backoff: backoff.exponential({ base: 2000 }).upTo(2), clock });
    const delays: number[] = [];
    policy.onRetry(({ delay }) => delays.push(delay));

    const result = policy.execute(fn);
    await clock.advanceAsync(10_000);

    await expect(result).resolves.toBe('ok');
    expect(delays).toEqual([2000, 4000]);
  });

  it('an abort during the delay ends the call with CancelledError, without another try', async () => {
    const clock = new MockClock();
    const { fn, calledAt } = flaky(clock, 5);
    const controller = new AbortController();
    const result = createRetryPolicy({ backoff: backoff.constant(60_000).upTo(5), clock }).execute(
      fn,
      controller.signal,
    );
    const settled = result.catch((error: unknown) => error);

    await clock.advanceAsync(1000);
    controller.abort();

    await expect(settled).resolves.toBeInstanceOf(CancelledError);
    expect(calledAt).toEqual([0]);
  });

  it('createResiliencePolicy uses the clock for its retry delay too', async () => {
    const clock = new MockClock();
    const { fn, calledAt } = flaky(clock, 2);
    const policy = createResiliencePolicy({ retry: backoff.exponential({ base: 1500 }).upTo(2), clock });

    const result = policy.execute(fn);
    await clock.advanceAsync(5000);

    await expect(result).resolves.toBe('ok');
    expect(calledAt).toEqual([0, 1500, 4500]);
  });
});
