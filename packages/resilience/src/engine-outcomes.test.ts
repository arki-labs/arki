import { afterEach, expect, expectTypeOf, it, vi } from 'vitest';
import { BrokenCircuitError, BulkheadRejectedError, TaskCancelledError } from 'cockatiel';
import { MockClock } from '@arki/clock';
import { defineFailure, UnexpectedDefect } from '@arki/failure';
import type { CircuitFailure, TimeoutFailure, RetryFailure, Policy, ResilienceFailure } from './index.js';
import {
  backoff, BulkheadRejected, Cancelled, CircuitOpen, Timeout,
  createBulkheadPolicy, createCircuitBreakerPolicy, createRetryPolicy, createTimeoutPolicy,
  noop, withFallback, wrap,
} from './index.js';

afterEach(() => vi.useRealTimers());

it('SDK-looking callback throws retry and reach explicit fallback unchanged', async () => {
  const clock = new MockClock();
  for (const thrown of [new BrokenCircuitError(), new BulkheadRejectedError(1, 0), new TaskCancelledError()]) {
    const retry = createRetryPolicy({ backoff: backoff.constant(1).upTo(1), clock });
    const policy = withFallback(wrap(retry, createCircuitBreakerPolicy()), error => error);
    let attempts = 0;
    const result = policy.execute(() => { attempts++; throw thrown; });
    await clock.advanceAsync(10);
    expect(await result).toBe(thrown);
    expect(attempts).toBe(2);
  }
});

it('only the public boundary normalizes final throws, preserving private cause and observations', async () => {
  const cause = new Error('private callback');
  const retry = createRetryPolicy({ backoff: backoff.constant(1).upTo(0) });
  const breaker = createCircuitBreakerPolicy({ consecutiveFailures: 1 });
  const seen: unknown[] = [];
  breaker.onFailure(event => { if ('error' in event.reason) seen.push(event.reason.error); });
  breaker.onBreak(event => { if ('error' in event) seen.push(event.error); });
  const outcome = await wrap(retry, breaker).execute(() => { throw cause; });
  expect(UnexpectedDefect.is(outcome)).toBe(true);
  if (!UnexpectedDefect.is(outcome)) throw new Error('expected defect');
  expect(outcome.cause).toBe(cause);
  expect(JSON.stringify(outcome)).not.toContain('private callback');
  expect(seen).toEqual([cause, cause]);
  expect(CircuitOpen.is(await breaker.execute(() => 'not run'))).toBe(true);
});

it('returned engine refusals are final by default and do not open an outer breaker', async () => {
  vi.useFakeTimers();
  const outer = createCircuitBreakerPolicy({ consecutiveFailures: 1 });
  const retry = createRetryPolicy({ backoff: backoff.constant(1).upTo(2) });
  const timed = createTimeoutPolicy({ timeoutMs: 5 });
  let calls = 0;
  const result = wrap(outer, retry, timed).execute(() => { calls++; return new Promise<never>(() => { /* Work intentionally ignores cancellation. */ }); });
  await vi.advanceTimersByTimeAsync(20);
  expect(Timeout.is(await result)).toBe(true);
  expect(calls).toBe(1);
  expect(await outer.execute(() => 'healthy')).toBe('healthy');
});

it('explicit selection retries timeout values and preserves attempt context', async () => {
  vi.useFakeTimers();
  const retry = createRetryPolicy({ backoff: backoff.constant(1).upTo(1).while(Timeout) });
  const policy = wrap(retry, createTimeoutPolicy({ timeoutMs: 5 }));
  const attempts: number[] = [];
  const result = policy.execute(({ attempt }) => {
    attempts.push(attempt);
    return attempt === 0 ? new Promise<never>(() => { /* Work intentionally ignores cancellation. */ }) : 'done';
  });
  await vi.advanceTimersByTimeAsync(20);
  expect(await result).toBe('done');
  expect(attempts).toEqual([0, 1]);
});

it('timeout origin is captured before observers abort its parent, independently per call', async () => {
  vi.useFakeTimers();
  const caller = new AbortController();
  const other = new AbortController();
  const policy = createTimeoutPolicy({ timeoutMs: 5 });
  policy.onTimeout(() => caller.abort('observer'));
  const first = policy.execute(() => new Promise<never>(() => { /* Work intentionally ignores cancellation. */ }), caller.signal);
  const second = policy.execute(() => new Promise<never>(() => { /* Work intentionally ignores cancellation. */ }), other.signal);
  await vi.advanceTimersByTimeAsync(20);
  expect(Timeout.is(await first)).toBe(true);
  expect(Timeout.is(await second)).toBe(true);
  const third = policy.execute(() => new Promise<never>(() => { /* Work intentionally ignores cancellation. */ }), other.signal);
  other.abort('caller');
  expect(Cancelled.is(await third)).toBe(true);
});

it('pre-aborted calls never invoke any owned operation or fallback', async () => {
  const controller = new AbortController(); controller.abort();
  let effects = 0;
  const policies: Policy<never, ResilienceFailure>[] = [noop, createCircuitBreakerPolicy(), createTimeoutPolicy(), createBulkheadPolicy()];
  for (const policy of policies) {
    const outcome = await withFallback(policy, () => { effects++; return 'fallback'; }).execute(() => { effects++; return 'work'; }, controller.signal);
    expect(Cancelled.is(outcome)).toBe(true);
  }
  expect(effects).toBe(0);
});

it('bulkhead refusal bypasses fallback while the admitted operation retains its answer', async () => {
  const policy = withFallback(createBulkheadPolicy({ maxConcurrent: 1, maxQueue: 0 }), () => 'fallback');
  let release!: (value: string) => void;
  const first = policy.execute(() => new Promise<string>(resolve => { release = resolve; }));
  expect(BulkheadRejected.is(await policy.execute(() => 'not run'))).toBe(true);
  release('done'); expect(await first).toBe('done');
});

it('heterogeneous composition preserves only the exact original outcome definitions', () => {
  const Refused = defineFailure('test.refused');
  const policy = wrap(createCircuitBreakerPolicy(), createTimeoutPolicy(), createRetryPolicy());
  const result = policy.execute(() => Refused());
  expectTypeOf(result).toEqualTypeOf<Promise<ReturnType<typeof Refused> | CircuitFailure | TimeoutFailure | RetryFailure>>();
  expectTypeOf(result).not.toEqualTypeOf<Promise<unknown>>();
});

it('custom clock and predicate defects cannot enter callback fallback or repeat work', async () => {
  const cause = new Error('private policy defect');
  class BrokenClock extends MockClock {
    override sleep(): ReturnType<MockClock['sleep']> { return Promise.reject(cause); }
  }
  const policies = [
    createRetryPolicy({ clock: new BrokenClock(), backoff: backoff.constant(1).upTo(2) }),
    createRetryPolicy({ backoff: backoff.constant(1).upTo(2).while(() => { throw cause; }) }),
  ];
  let fallbacks = 0;
  for (const policy of policies) {
    let calls = 0;
    const outcome = await withFallback(policy, () => { fallbacks++; return 'fallback'; }).execute(() => {
      calls++; throw new Error('callback');
    });
    expect(UnexpectedDefect.is(outcome)).toBe(true);
    if (!UnexpectedDefect.is(outcome)) throw new Error('expected defect');
    expect(outcome.cause).toBe(cause);
    expect(calls).toBe(1);
  }
  expect(fallbacks).toBe(0);
});

it('execution-only fallback preserves raw errors and cancellation without requiring event methods', async () => {
  const cause = new Error('raw');
  const execution = { execute: noop.execute };
  // Foreign execution has already normalized its outcome: fallback must not undo that refusal.
  expect(UnexpectedDefect.is(await withFallback(execution, () => 'hidden').execute(() => { throw cause; }))).toBe(true);
  const controller = new AbortController();
  const foreign = { execute() { controller.abort('caller'); return Promise.reject(cause); } };
  expect(Cancelled.is(await withFallback(foreign, () => 'hidden').execute(() => 1, controller.signal))).toBe(true);
});

it('composition and fallback preserve foreign event method receivers', async () => {
  const receiverPolicy = {
    subscriptions: 0,
    onSuccess() { this.subscriptions++; return { dispose() { /* No retained resources. */ } }; },
    onFailure() { this.subscriptions++; return { dispose() { /* No retained resources. */ } }; },
    execute: noop.execute,
  };
  const wrapped = wrap(receiverPolicy, noop);
  wrapped.onSuccess(() => { /* Subscription only. */ });
  wrapped.onFailure(() => { /* Subscription only. */ });
  const fallback = withFallback(receiverPolicy, () => 'cached');
  fallback.onSuccess(() => { /* Subscription only. */ });
  fallback.onFailure(() => { /* Subscription only. */ });
  expect(receiverPolicy.subscriptions).toBe(4);
  expect(await wrapped.execute(() => 'done')).toBe('done');
});

it('an unavailable deadline provider is an engine defect, not a callback fallback', async () => {
  const cause = new Error('timer unavailable');
  let calls = 0;
  let fallbacks = 0;
  const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => { throw cause; });
  try {
    const result = await withFallback(createTimeoutPolicy(), () => { fallbacks++; return 'cached'; }).execute(() => {
      calls++; return 'work';
    });
    expect(UnexpectedDefect.is(result)).toBe(true);
    if (!UnexpectedDefect.is(result)) throw new Error('expected deadline provider defect');
    expect(result.cause).toBe(cause);
    expect(calls).toBe(0);
    expect(fallbacks).toBe(0);
  } finally {
    timer.mockRestore();
  }
});
