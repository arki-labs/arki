/* eslint-disable @typescript-eslint/no-misused-promises -- Foreign observers/reporters can return promises through the void contract; these tests prove their rejections are supervised. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MockClock } from '@arki/clock';
import { defineFailure, UnexpectedDefect } from '@arki/failure';
import { getLogger } from '@arki/log';
import { fakeLog } from '@arki/log/testing';

import { describe as describeFailure } from './events.js';
import {
  attachPolicyLogger,
  backoff,
  createBulkheadPolicy,
  createCircuitBreakerPolicy,
  createResiliencePolicy,
  createRetryPolicy,
  createTimeoutPolicy,
  BulkheadRejected,
  Timeout,
  withFallback,
} from './index.js';
import { superviseObserver } from './observers.js';

const privateError = new Error('private-token');
const throwObserver = (): never => {
  throw privateError;
};
const rejectObserver = () => Promise.reject(privateError);
const pendingObserver = () =>
  new Promise<void>(() => {
    /* Intentionally pending: observation must never block execution. */
  });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('observation cannot control policy outcomes', () => {
  it('does not repeat successful work or run fallback when success reporting throws', async () => {
    const clock = new MockClock();
    const policy = createRetryPolicy({ backoff: backoff.constant(0).upTo(2), clock });
    const work = vi.fn(() => ({ saved: true }));
    const fallback = vi.fn(() => 'fallback');
    const observed = vi.fn();
    policy.onSuccess(throwObserver);
    policy.onSuccess(observed);
    const call = withFallback(policy, fallback).execute(work);
    await clock.advanceAsync(1);
    const result = await call;
    expect(result).toBe(work.mock.results[0]?.value);
    expect(work).toHaveBeenCalledTimes(1);
    expect(observed).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('keeps retry decisions and the final original throw when all failure observers throw', async () => {
    const clock = new MockClock();
    const policy = createRetryPolicy({ backoff: backoff.constant(10).upTo(1), clock });
    policy.onFailure(throwObserver);
    policy.onRetry(throwObserver);
    policy.onGiveUp(throwObserver);
    const original = new Error('application');
    const work = vi.fn(() => {
      throw original;
    });
    const outcome = policy.execute(work).catch((error: unknown) => error);
    await clock.advanceAsync(10);
    expect(await outcome).toMatchObject({ code: 'failure.unexpected_defect', cause: original });
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('keeps a returned refusal by identity without retrying or opening the breaker', async () => {
    const Refused = defineFailure('test.refused');
    const refusal = Refused();
    const policy = createResiliencePolicy({
      retry: backoff.constant(0).upTo(1),
      circuitBreaker: { consecutiveFailures: 1 },
    });
    policy.components.retry.onFailure(throwObserver);
    policy.components.circuitBreaker.onSuccess(throwObserver);
    const work = vi.fn(() => refusal);
    expect(await policy.execute(work)).toBe(refusal);
    expect(await policy.execute(() => 'next')).toBe('next');
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('preserves breaker accounting and recovery when every breaker observer throws', async () => {
    vi.useFakeTimers();
    const breaker = createCircuitBreakerPolicy({ consecutiveFailures: 1, halfOpenAfter: 10 });
    breaker.onFailure(throwObserver);
    breaker.onBreak(throwObserver);
    breaker.onHalfOpen(throwObserver);
    breaker.onSuccess(throwObserver);
    breaker.onReset(throwObserver);
    const original = new Error('down');
    await expect(
      breaker.execute(() => {
        throw original;
      }),
    ).resolves.toMatchObject({ code: 'failure.unexpected_defect', cause: original });
    await vi.advanceTimersByTimeAsync(10);
    expect(await breaker.execute(() => 'recovered')).toBe('recovered');
    expect(await breaker.execute(() => 'healthy')).toBe('healthy');
  });

  it('settles concurrent timeouts and observes late callback rejection despite failing observers', async () => {
    vi.useFakeTimers();
    const policy = createTimeoutPolicy({ timeoutMs: 10 });
    const timedOut = vi.fn();
    policy.onTimeout(throwObserver);
    policy.onTimeout(rejectObserver);
    policy.onTimeout(timedOut);
    policy.onFailure(throwObserver);
    const late = deferred<string>();
    const first = policy.execute(() => late.promise).catch((error: unknown) => error);
    const second = policy.execute(pendingObserver).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    expect(await first).toMatchObject({ code: Timeout.code });
    expect(await second).toMatchObject({ code: Timeout.code });
    expect(timedOut).toHaveBeenCalledTimes(2);
    late.reject(privateError);
    await vi.advanceTimersByTimeAsync(0);
  });

  it('preserves rejection and releases the bulkhead slot when its observer throws', async () => {
    const policy = createBulkheadPolicy({ maxConcurrent: 1, maxQueue: 0 });
    policy.onReject(throwObserver);
    const warn = vi.fn(rejectObserver);
    attachPolicyLogger(policy, { info: rejectObserver, error: rejectObserver, warn });
    const hold = deferred<string>();
    const first = policy.execute(() => hold.promise);
    const rejected = await policy.execute(() => 'unreachable').catch((error: unknown) => error);
    expect(BulkheadRejected.is(rejected)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    hold.resolve('done');
    expect(await first).toBe('done');
    expect(await policy.execute(() => 'next')).toBe('next');
  });

  it('observes rejected promises without waiting for pending reporting', async () => {
    const policy = createRetryPolicy();
    policy.onSuccess(rejectObserver);
    policy.onSuccess(pendingObserver);
    const observed = vi.fn();
    policy.onSuccess(observed);
    expect(await policy.execute(() => 42)).toBe(42);
    await Promise.resolve();
    expect(observed).toHaveBeenCalledTimes(1);
  });

  it('keeps disposal effective and does not skip another retry observer on self-disposal', async () => {
    const policy = createRetryPolicy();
    const first = policy.onSuccess(() => {
      first.dispose();
      throw privateError;
    });
    const observed = vi.fn();
    const second = policy.onSuccess(observed);
    expect(await policy.execute(() => 1)).toBe(1);
    expect(observed).toHaveBeenCalledTimes(1);
    second.dispose();
    expect(await policy.execute(() => 2)).toBe(2);
    expect(observed).toHaveBeenCalledTimes(1);
  });

  it('reports observer defects using a safe canonical code only', async () => {
    const log = fakeLog();
    try {
      const policy = createRetryPolicy();
      policy.onSuccess(throwObserver);
      expect(await policy.execute(() => 'done')).toBe('done');
      expect(log.records).toHaveLength(1);
      expect(log.records[0]?.fields).toEqual({ code: UnexpectedDefect.code });
      expect(JSON.stringify(log.records)).not.toContain('private-token');
    } finally {
      log.restore();
    }
  });

  it.each([throwObserver, rejectObserver])(
    'protects operations from a broken diagnostic reporter (%#)',
    async reporter => {
      vi.spyOn(getLogger('arki:resilience'), 'error').mockImplementation(reporter);
      const policy = createRetryPolicy();
      policy.onSuccess(throwObserver);
      expect(await policy.execute(() => 'done')).toBe('done');
      await Promise.resolve();
    },
  );

  it('does not await pending diagnostic reporting and resumes reporting after settlement', async () => {
    const pending = deferred<void>();
    const report = vi.spyOn(getLogger('arki:resilience'), 'error').mockImplementation(() => pending.promise);
    const policy = createRetryPolicy();
    policy.onSuccess(throwObserver);
    try {
      expect(await policy.execute(() => 'first')).toBe('first');
      expect(await policy.execute(() => 'second')).toBe('second');
      expect(report).toHaveBeenCalledTimes(1);
    } finally { pending.resolve(); }
    await Promise.resolve();
    expect(await policy.execute(() => 'third')).toBe('third');
    expect(report).toHaveBeenCalledTimes(2);
  });

  it('coalesces delayed defects from concurrent executions while reporting is pending', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const pending = deferred<void>();
    const report = vi.spyOn(getLogger('arki:resilience'), 'error').mockImplementation(() => pending.promise);
    const observe = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const policy = createRetryPolicy();
    policy.onSuccess(observe);
    try {
      expect(await Promise.all([policy.execute(() => 1), policy.execute(() => 2)])).toEqual([1, 2]);
      first.reject(privateError);
      await Promise.resolve();
      second.reject(privateError);
      await Promise.resolve();
      expect(report).toHaveBeenCalledTimes(1);
    } finally { pending.resolve(); }
    await Promise.resolve();
  });

  it('observes a throwing then getter without replacing the answer', async () => {
    const policy = createRetryPolicy();
    policy.onSuccess(() => ({
      // eslint-disable-next-line unicorn/no-thenable -- Exercise a broken foreign thenable's getter, not a production Promise implementation.
      get then() {
        throw privateError;
      },
    }));
    expect(await policy.execute(() => 'saved')).toBe('saved');
    await Promise.resolve();
  });

  it('does not recursively report a synchronous reporter defect', async () => {
    const observer = superviseObserver(throwObserver);
    const report = vi.spyOn(getLogger('arki:resilience'), 'error').mockImplementation(() => observer(null));
    const policy = createRetryPolicy();
    policy.onSuccess(throwObserver);
    expect(await policy.execute(() => 'saved')).toBe('saved');
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('does not recursively report a rejected observer invoked by the diagnostic reporter', async () => {
    const observer = superviseObserver(rejectObserver);
    let reports = 0;
    const report = vi.spyOn(getLogger('arki:resilience'), 'error').mockImplementation(() => {
      // Bound the broken fixture so a regression fails instead of starving the test runner.
      reports++;
      if (reports < 8) observer(null);
    });
    const policy = createRetryPolicy();
    policy.onSuccess(throwObserver);
    expect(await policy.execute(() => 'saved')).toBe('saved');
    for (let turn = 0; turn < 12; turn++) await Promise.resolve();
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('keeps diagnostic provenance after the reporter settles but its nested observer rejects later', async () => {
    const late = deferred<void>();
    const observer = superviseObserver(() => late.promise);
    let reports = 0;
    const report = vi.spyOn(getLogger('arki:resilience'), 'error').mockImplementation(() => {
      reports++;
      if (reports < 8) observer(null);
    });
    const policy = createRetryPolicy();
    policy.onSuccess(throwObserver);
    expect(await policy.execute(() => 'saved')).toBe('saved');
    late.reject(privateError);
    for (let turn = 0; turn < 12; turn++) await Promise.resolve();
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('retains reporting provenance when an async reporter invokes a rejected observer after await', async () => {
    const observer = superviseObserver(rejectObserver);
    let reports = 0;
    const report = vi.spyOn(getLogger('arki:resilience'), 'error').mockImplementation(async () => {
      reports++;
      await Promise.resolve();
      if (reports < 8) observer(null);
    });
    const policy = createRetryPolicy();
    policy.onSuccess(throwObserver);
    expect(await policy.execute(() => 'saved')).toBe('saved');
    for (let turn = 0; turn < 16; turn++) await Promise.resolve();
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('preserves custom policy event receivers through the logger adapter', async () => {
    const original = createRetryPolicy({ backoff: backoff.constant(0).upTo(0) });
    const policy = {
      ...original,
      onSuccess(listener: Parameters<typeof original.onSuccess>[0]) {
        expect(this).toBe(policy);
        return original.onSuccess(listener);
      },
      onFailure(listener: Parameters<typeof original.onFailure>[0]) {
        expect(this).toBe(policy);
        return original.onFailure(listener);
      },
    };
    const info = vi.fn();
    const error = vi.fn();
    attachPolicyLogger(policy, { info, warn: vi.fn(), error });
    expect(await policy.execute(() => 'saved')).toBe('saved');
    await expect(policy.execute(throwObserver)).resolves.toMatchObject({ code: 'failure.unexpected_defect', cause: privateError });
    expect(info).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('formats only canonical codes and never coerces private payloads', () => {
    const Refused = defineFailure('test.refused');
    const refusal = Refused({ cause: privateError });
    expect(describeFailure({ value: refusal })).toBe(Refused.code);
    expect(describeFailure({ error: refusal })).toBe(Refused.code);
    expect(describeFailure({ error: privateError })).toBe(UnexpectedDefect.code);
    expect(describeFailure({ value: { toString: throwObserver } })).toBe(UnexpectedDefect.code);
  });

  it('supervises async logger adapters and never logs private throw messages', async () => {
    const policy = createRetryPolicy({ backoff: backoff.constant(0).upTo(0) });
    const info = vi.fn(rejectObserver);
    const error = vi.fn(rejectObserver);
    attachPolicyLogger(policy, { info, error, warn: rejectObserver });
    expect(await policy.execute(() => 'done')).toBe('done');
    await expect(policy.execute(throwObserver)).resolves.toMatchObject({ code: 'failure.unexpected_defect', cause: privateError });
    expect(error.mock.calls.length).toBe(2);
    await Promise.resolve();
  });
});
