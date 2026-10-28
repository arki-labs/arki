import type { ExecutionFailure } from './errors.js';
import { expect, expectTypeOf, it, vi } from 'vitest';

import { MockClock, SleepCancelled } from '@arki/clock';
import { defineFailure } from '@arki/failure';

import type { RetryFailure } from './index.js';
import { backoff, Cancelled, createRetryPolicy, noop, RETRY_FAILURES, withFallback, wrap } from './index.js';

const Refused = defineFailure('retry_test.refused', { message: 'Refused', remediation: 'Choose another operation.' });

it('refuses a pre-aborted retry before any application work or timer is started', async () => {
  const controller = new AbortController();
  controller.abort('private reason');
  const clock = new MockClock();
  const sleep = vi.spyOn(clock, 'sleep');
  const work = vi.fn(() => 'side effect');
  const policy = createRetryPolicy({ clock, backoff: backoff.constant(1).upTo(1) });
  const result = await policy.execute(work, controller.signal);
  expect(result).toMatchObject({ code: 'resilience.cancelled' });
  expect(work).not.toHaveBeenCalled();
  expect(sleep).not.toHaveBeenCalled();
});

it('returns a private canonical cancellation after callback rejection, without a throw fallback', async () => {
  const controller = new AbortController();
  const reason = new Error('private cancellation');
  const onThrow = vi.fn(() => 'fallback');
  const policy = createRetryPolicy({ backoff: backoff.constant(1).upTo(3), onThrow });
  const gaveUp = vi.fn();
  policy.onGiveUp(gaveUp);
  const result = await policy.execute(() => {
    controller.abort(reason);
    return Promise.reject(new Error('private callback error'));
  }, controller.signal);
  expect(Cancelled.is(result)).toBe(true);
  if (!Cancelled.is(result)) throw new Error('Expected retry cancellation');
  expect(result.cause).toBe(reason);
  expect(result.data).toBeUndefined();
  expect(result.status).toBe(499);
  expect(result.remediation).toBeTruthy();
  expect(JSON.stringify(result)).not.toContain('private');
  expect(onThrow).not.toHaveBeenCalled();
  expect(gaveUp).not.toHaveBeenCalled();
});

it('preserves completed successes and canonical refusals even when their callback aborts', async () => {
  const answer = { saved: true };
  const refusal = Refused();
  for (const value of [answer, refusal]) {
    const controller = new AbortController();
    const clock = new MockClock();
    const sleep = vi.spyOn(clock, 'sleep');
    const work = vi.fn(() => {
      controller.abort();
      return value;
    });
    const policy = createRetryPolicy({ clock, backoff: backoff.constant(1).upTo(3).while(Refused) });
    expect(await policy.execute(work, controller.signal)).toBe(value);
    expect(work).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  }
});

it.each([
  ['onFailure', 1],
  ['onRetry', 1],
  ['onGiveUp', 0],
] as const)('observes cancellation in %s before more retry work or throw recovery', async (event, attempts) => {
  const controller = new AbortController();
  const clock = new MockClock();
  const sleep = vi.spyOn(clock, 'sleep');
  const onThrow = vi.fn(() => 'fallback');
  const inner = createRetryPolicy({ clock, backoff: backoff.constant(1).upTo(attempts) });
  inner[event](() => controller.abort());
  const work = vi.fn(() => {
    throw new Error('operation failed');
  });
  const result = await withFallback(inner, onThrow).execute(work, controller.signal);
  expect(Cancelled.is(result)).toBe(true);
  expect(work).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
  expect(onThrow).not.toHaveBeenCalled();
});

it.each(['onFailure', 'onRetry', 'onGiveUp'] as const)('preserves a refusal when %s cancels', async event => {
  const controller = new AbortController();
  const clock = new MockClock();
  const sleep = vi.spyOn(clock, 'sleep');
  const refusal = Refused();
  const work = vi.fn(() => refusal);
  const policy = createRetryPolicy({ clock, backoff: backoff.constant(1).upTo(1).while(Refused) });
  policy[event](() => controller.abort());
  const call = policy.execute(work, controller.signal);
  await clock.advanceAsync(1);
  expect(await call).toBe(refusal);
  expect(work).toHaveBeenCalledTimes(event === 'onGiveUp' ? 2 : 1);
  expect(sleep).toHaveBeenCalledTimes(event === 'onGiveUp' ? 1 : 0);
});

it('does not schedule a wait when the retry predicate cancels', async () => {
  const controller = new AbortController();
  const clock = new MockClock();
  const sleep = vi.spyOn(clock, 'sleep');
  const policy = createRetryPolicy({
    clock,
    backoff: backoff
      .constant(1)
      .upTo(1)
      .while(() => {
        controller.abort();
        return true;
      }),
  });
  const result = await policy.execute(() => {
    throw new Error('failed');
  }, controller.signal);
  expect(Cancelled.is(result)).toBe(true);
  expect(sleep).not.toHaveBeenCalled();
});

it('checks cancellation again after a custom clock completes without reporting abort', async () => {
  const controller = new AbortController();
  const clock = new MockClock();
  vi.spyOn(clock, 'sleep').mockImplementation(() => {
    controller.abort();
    return Promise.resolve();
  });
  const work = vi.fn(() => {
    throw new Error('failed');
  });
  const result = await createRetryPolicy({ clock, backoff: backoff.constant(1).upTo(1) }).execute(
    work,
    controller.signal,
  );
  expect(Cancelled.is(result)).toBe(true);
  expect(work).toHaveBeenCalledTimes(1);
});

it('preserves the clock outcome identity rather than relabelling a cancelled wait', async () => {
  const clock = new MockClock();
  const cancellation = SleepCancelled({ cause: new Error('private wait') });
  vi.spyOn(clock, 'sleep').mockResolvedValue(cancellation);
  const result = await createRetryPolicy({ clock, backoff: backoff.constant(1).upTo(1) }).execute(() => {
    throw new Error('failed');
  });
  expect(result).toBe(cancellation);
});

it('infers retry outcomes through composition without widening ordinary policies', async () => {
  const controller = new AbortController();
  controller.abort();
  const retry = createRetryPolicy();
  const work = vi.fn(() => 'done' as const);
  const result = wrap(noop, retry).execute(work, controller.signal);
  expectTypeOf(result).toEqualTypeOf<Promise<'done' | RetryFailure>>();
  expectTypeOf(noop.execute(() => 42)).toEqualTypeOf<Promise<number | ExecutionFailure>>();
  expectTypeOf<RetryFailure>().toEqualTypeOf<ReturnType<(typeof RETRY_FAILURES)[number]>>();
  expect(RETRY_FAILURES).toContain(Cancelled);
  expect(RETRY_FAILURES).toContain(SleepCancelled);
  expect(Cancelled.is(await result)).toBe(true);
  expect(work).not.toHaveBeenCalled();
});

it('does not announce a retry after a failure observer cancels the execution', async () => {
  const controller = new AbortController();
  const policy = createRetryPolicy({ backoff: backoff.constant(1).upTo(1) });
  const onRetry = vi.fn();
  const onGiveUp = vi.fn();
  policy.onFailure(() => controller.abort());
  policy.onRetry(onRetry);
  policy.onGiveUp(onGiveUp);
  const result = await policy.execute(() => {
    throw new Error('failed');
  }, controller.signal);
  expect(Cancelled.is(result)).toBe(true);
  expect(onRetry).not.toHaveBeenCalled();
  expect(onGiveUp).not.toHaveBeenCalled();
});
