import { afterEach, describe, expect, it, vi } from 'vitest';

import { isFailure, orThrow } from '@arki/failure';

import type { Policy } from './index.js';
import {
  backoff,
  Cancelled,
  createBulkheadPolicy,
  createCircuitBreakerPolicy,
  createResiliencePolicy,
  createRetryPolicy,
  createTimeoutPolicy,
  CircuitOpen,
  BulkheadRejected,
  noop,
  Timeout,
  wrap,
} from './index.js';

/** A promise the test settles by hand, so a call can be held open for as long as the test needs. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A call that never finishes and ignores every signal. */
const ignore = (): void => {
  // intentionally pending forever
};
const never = () => new Promise<never>(ignore);

/** A promise that never settles on its own but rejects when the signal aborts. */
function hangUntilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('fn saw the abort')), { once: true });
  });
}

/** Lets pending promise chains run; under fake timers it also fires 0 ms timers. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('createRetryPolicy', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls the function once plus maxAttempts retries, then returns the last error as a private defect cause', async () => {
    vi.useFakeTimers();
    const policy = createRetryPolicy({ backoff: backoff.exponential({ base: 1, max: 2 }).upTo(3) });
    const errors: Error[] = [];
    const call = policy.execute(() => {
      const error = new Error(`failure ${errors.length + 1}`);
      errors.push(error);
      throw error;
    });
    const result = call.catch((error: unknown) => error);
    await vi.runAllTimersAsync();

    expect(errors).toHaveLength(4);
    await expect(result).resolves.toMatchObject({ code: 'failure.unexpected_defect', cause: errors[3] });
  });

  it('gives the function its attempt number, starting at 0 for the first call', async () => {
    vi.useFakeTimers();
    const policy = createRetryPolicy({ backoff: backoff.exponential({ base: 1, max: 2 }).upTo(2) });
    const attempts: number[] = [];
    const call = policy.execute(({ attempt }) => {
      attempts.push(attempt);
      if (attempt < 2) throw new Error('not yet');
      return 'done';
    });
    await vi.runAllTimersAsync();

    await expect(call).resolves.toBe('done');
    expect(attempts).toEqual([0, 1, 2]);
  });

  it('spaces retries by a backoff that never exceeds maxDelay and reports each retry', async () => {
    vi.useFakeTimers();
    // A large initial delay and a small cap: every delay must be clamped to the cap.
    const policy = createRetryPolicy({ backoff: backoff.exponential({ base: 1000, max: 5 }).upTo(4) });
    const retries: { attempt: number; delay: number }[] = [];
    policy.onRetry(({ attempt, delay }) => retries.push({ attempt, delay }));
    const gaveUp = vi.fn();
    policy.onGiveUp(gaveUp);

    const call = policy.execute(() => {
      throw new Error('always');
    });
    const result = call.catch((error: unknown) => error);
    await vi.runAllTimersAsync();

    await expect(result).resolves.toMatchObject({ code: 'failure.unexpected_defect', cause: expect.any(Error) });
    expect(retries.map(r => r.attempt)).toEqual([1, 2, 3, 4]);
    for (const { delay } of retries) {
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(5);
    }
    expect(gaveUp).toHaveBeenCalledTimes(1);
  });

  it('does not retry once the caller aborts', async () => {
    vi.useFakeTimers();
    const policy = createRetryPolicy({ backoff: backoff.exponential({ base: 1, max: 2 }).upTo(5) });
    const controller = new AbortController();
    let calls = 0;
    const call = policy.execute(() => {
      calls += 1;
      controller.abort();
      throw new Error('fails after aborting');
    }, controller.signal);
    const result = call.catch((error: unknown) => error);
    await vi.runAllTimersAsync();

    await expect(result).resolves.toMatchObject({ code: 'resilience.cancelled' });
    expect(calls).toBe(1);
  });
});

const fail = () => {
  throw new Error('flaky');
};

describe('createCircuitBreakerPolicy', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens after N failures in a row and rejects without calling the function', async () => {
    const breaker = createCircuitBreakerPolicy({ consecutiveFailures: 3, halfOpenAfter: 1000 });
    const broke = vi.fn();
    breaker.onBreak(broke);
    let calls = 0;
    const failing = () => {
      calls += 1;
      throw new Error('downstream down');
    };

    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failing)).resolves.toMatchObject({ code: 'failure.unexpected_defect', cause: new Error('downstream down') });
    }
    const fourth = await breaker.execute(failing).catch((error: unknown) => error);

    expect(calls).toBe(3);
    expect(CircuitOpen.is(fourth)).toBe(true);
    expect(isFailure(fourth)).toBe(true);
    expect(broke).toHaveBeenCalledTimes(1);
    expect(broke.mock.calls[0]?.[0]).toMatchObject({ error: { message: 'downstream down' } });
  });

  it('counts only consecutive failures: a success resets the count', async () => {
    const breaker = createCircuitBreakerPolicy({ consecutiveFailures: 3, halfOpenAfter: 1000 });

    await expect(breaker.execute(fail)).resolves.toMatchObject({ code: 'failure.unexpected_defect', cause: new Error('flaky') });
    await expect(breaker.execute(fail)).resolves.toMatchObject({ code: 'failure.unexpected_defect', cause: new Error('flaky') });
    await expect(breaker.execute(() => 'ok')).resolves.toBe('ok');
    await expect(breaker.execute(fail)).resolves.toMatchObject({ code: 'failure.unexpected_defect', cause: new Error('flaky') });
    await expect(breaker.execute(fail)).resolves.toMatchObject({ code: 'failure.unexpected_defect', cause: new Error('flaky') });
    // Still closed: the fifth failure overall is only the second in a row.
    await expect(breaker.execute(() => 'still closed')).resolves.toBe('still closed');
  });

  it('goes half-open after halfOpenAfter, lets one trial call through, and closes on success', async () => {
    vi.useFakeTimers();
    const breaker = createCircuitBreakerPolicy({ consecutiveFailures: 1, halfOpenAfter: 1000 });
    const halfOpen = vi.fn();
    const reset = vi.fn();
    breaker.onHalfOpen(halfOpen);
    breaker.onReset(reset);

    await expect(
      breaker.execute(() => {
        throw new Error('first');
      }),
    ).resolves.toMatchObject({ code: 'failure.unexpected_defect', cause: new Error('first') });
    expect(CircuitOpen.is(await breaker.execute(() => 'x').catch((error: unknown) => error))).toBe(true);

    vi.advanceTimersByTime(999);
    expect(CircuitOpen.is(await breaker.execute(() => 'x').catch((error: unknown) => error))).toBe(true);
    expect(halfOpen).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    const trial = deferred<string>();
    let trialCalls = 0;
    const first = breaker.execute(() => {
      trialCalls += 1;
      return trial.promise;
    });
    // A second call during the trial must wait for the trial, not run a second probe.
    const second = breaker.execute(() => {
      trialCalls += 1;
      return 'second';
    });
    await settle();
    expect(halfOpen).toHaveBeenCalledTimes(1);
    expect(trialCalls).toBe(1);

    trial.resolve('trial ok');
    await expect(first).resolves.toBe('trial ok');
    await expect(second).resolves.toBe('second');
    expect(reset).toHaveBeenCalledTimes(1);
    expect(trialCalls).toBe(2);
  });

  it('re-opens when the half-open trial call fails', async () => {
    vi.useFakeTimers();
    const breaker = createCircuitBreakerPolicy({ consecutiveFailures: 1, halfOpenAfter: 1000 });
    const broke = vi.fn();
    breaker.onBreak(broke);

    await expect(breaker.execute(fail)).resolves.toMatchObject({ code: 'failure.unexpected_defect', cause: new Error('flaky') });
    vi.advanceTimersByTime(1000);
    await expect(breaker.execute(fail)).resolves.toMatchObject({ code: 'failure.unexpected_defect', cause: new Error('flaky') });
    expect(broke).toHaveBeenCalledTimes(2);
    expect(CircuitOpen.is(await breaker.execute(fail).catch((error: unknown) => error))).toBe(true);
  });
});

describe('createTimeoutPolicy (aggressive)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects at the deadline even when the function ignores its signal, and aborts that signal', async () => {
    vi.useFakeTimers();
    const policy = createTimeoutPolicy({ timeoutMs: 50 });
    const timedOut = vi.fn();
    policy.onTimeout(timedOut);
    let seen: AbortSignal | undefined;

    const call = policy.execute(({ signal }) => {
      seen = signal;
      return never();
    });
    const result = call.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(49);
    expect(seen?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const error = await result;
    expect(error).toMatchObject({ code: Timeout.code });
    expect(isFailure(error)).toBe(true);
    expect(seen?.aborted).toBe(true);
    expect(timedOut).toHaveBeenCalledTimes(1);
  });

  it('aborts the signal after the function returns in time', async () => {
    const policy = createTimeoutPolicy({ timeoutMs: 1000 });
    let seen: AbortSignal | undefined;

    await expect(
      policy.execute(({ signal }) => {
        seen = signal;
        return 'fast';
      }),
    ).resolves.toBe('fast');
    expect(seen?.aborted).toBe(true);
  });
});

describe('wrap and cancellation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('composes retry around breaker around timeout, so the breaker stops the retries', async () => {
    // One logical call: the function fails twice, the breaker opens, and the remaining
    // retries are rejected by the breaker without reaching the function.
    const policy = createResiliencePolicy({
      retry: backoff.exponential({ base: 1, max: 2 }).upTo(5),
      circuitBreaker: { consecutiveFailures: 2, halfOpenAfter: 60_000 },
      timeout: { timeoutMs: 1000 },
    });
    let calls = 0;
    const error = await policy
      .execute(() => {
        calls += 1;
        throw new Error('down');
      })
      .catch((error_: unknown) => error_);

    expect(calls).toBe(2);
    expect(CircuitOpen.is(error)).toBe(true);
  });

  it('with a bulkhead, one logical call holds one slot for all its retries and extra calls are rejected', async () => {
    // Why: the README promised a bulkhead in the composite; without it a burst of calls
    // to a slow dependency would all run at once.
    const policy = createResiliencePolicy({
      retry: backoff.exponential({ base: 1, max: 2 }).upTo(3),
      bulkhead: { maxConcurrent: 1, maxQueue: 0 },
    });
    const held = deferred<string>();
    let attempts = 0;
    const first = policy.execute(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('flaky'); // the retry must not need a second slot
      return held.promise;
    });
    await vi.waitFor(() => {
      expect(attempts).toBe(2);
    });

    const second = await policy.execute(() => 'second').catch((error_: unknown) => error_);
    expect(BulkheadRejected.is(second)).toBe(true);

    held.resolve('first');
    await expect(first).resolves.toBe('first');
    await expect(policy.execute(() => 'third')).resolves.toBe('third');
  });

  it('passes a parent signal through wrap down to the function and cancels a function that ignores it', async () => {
    const policy = wrap(
      createRetryPolicy({ backoff: backoff.exponential({ base: 1, max: 2 }).upTo(3) }),
      createCircuitBreakerPolicy(),
      createTimeoutPolicy({ timeoutMs: 60_000 }),
    );
    vi.useFakeTimers();
    const controller = new AbortController();
    let calls = 0;
    let seen: AbortSignal | undefined;
    const call = policy.execute(({ signal }) => {
      calls += 1;
      seen = signal;
      return never();
    }, controller.signal);
    await settle();
    expect(seen?.aborted).toBe(false);

    const reason = new Error('user navigated away');
    controller.abort(reason);
    const error = await call.catch((error_: unknown) => error_);

    expect(seen?.aborted).toBe(true);
    expect(Cancelled.is(error)).toBe(true);
    expect(error).not.toMatchObject({ code: Timeout.code });
    expect(error).toMatchObject({ cause: reason });
    expect(calls).toBe(1);
  });

  it('gives attempt 0 to the function under policies without retry', async () => {
    const attempts: number[] = [];
    const record = ({ attempt }: { attempt: number }) => {
      attempts.push(attempt);
      return attempt;
    };

    orThrow(await noop.execute(record));
    orThrow(await createTimeoutPolicy().execute(record));
    orThrow(await createCircuitBreakerPolicy().execute(record));
    orThrow(await createBulkheadPolicy().execute(record));
    orThrow(await wrap(createCircuitBreakerPolicy(), createTimeoutPolicy()).execute(record));

    expect(attempts).toEqual([0, 0, 0, 0, 0]);
  });

  it('keeps the retry attempt in the context through wrap', async () => {
    vi.useFakeTimers();
    const policy = wrap(
      createRetryPolicy({ backoff: backoff.exponential({ base: 1, max: 2 }).upTo(2) }),
      createCircuitBreakerPolicy(),
      createTimeoutPolicy(),
    );
    const attempts: number[] = [];
    const call = policy.execute(({ attempt }) => {
      attempts.push(attempt);
      if (attempt < 2) throw new Error('again');
      return attempt;
    });
    await vi.runAllTimersAsync();

    await expect(call).resolves.toBe(2);
    expect(attempts).toEqual([0, 1, 2]);
  });

  it('composes a policy that was not created by this package', async () => {
    const seen: string[] = [];
    const foreign: Policy = {
      onSuccess: noop.onSuccess,
      onFailure: noop.onFailure,
      async execute(fn, signal) {
        seen.push('foreign');
        return fn({ signal: signal ?? new AbortController().signal, attempt: 0 });
      },
    };

    const result = await wrap(createRetryPolicy(), foreign, createTimeoutPolicy()).execute(({ attempt }) => {
      seen.push(`fn ${attempt}`);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(seen).toEqual(['foreign', 'fn 0']);
  });

  it('returns cancellation when a cooperative function rejects after abort', async () => {
    const policy = wrap(
      createRetryPolicy({ backoff: backoff.exponential({ base: 1, max: 2 }).upTo(3) }),
      createTimeoutPolicy({ timeoutMs: 60_000 }),
    );
    vi.useFakeTimers();
    const controller = new AbortController();
    let calls = 0;
    const call = policy.execute(({ signal }) => {
      calls += 1;
      return hangUntilAborted(signal);
    }, controller.signal);
    await settle();

    controller.abort();

    expect(Cancelled.is(await call)).toBe(true);
    expect(calls).toBe(1);
  });

  it('noop runs the function as is', async () => {
    await expect(noop.execute(() => 'plain')).resolves.toBe('plain');
    await expect(
      noop.execute(() => {
        throw new Error('plain failure');
      }),
    ).resolves.toMatchObject({ code: 'failure.unexpected_defect', cause: new Error('plain failure') });
  });
});

describe('createBulkheadPolicy', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs maxConcurrent calls at once, queues maxQueue more, and rejects the rest', async () => {
    vi.useFakeTimers();
    const bulkhead = createBulkheadPolicy({ maxConcurrent: 2, maxQueue: 1 });
    const rejected = vi.fn();
    bulkhead.onReject(rejected);
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    let started = 0;
    const start = (i: number) =>
      bulkhead.execute(() => {
        started += 1;
        return gates[i]?.promise;
      });

    const first = start(0);
    const second = start(1);
    const third = start(2);
    const fourth = await bulkhead.execute(() => 'never').catch((error: unknown) => error);
    await settle();

    expect(started).toBe(2);
    expect(BulkheadRejected.is(fourth)).toBe(true);
    expect(isFailure(fourth)).toBe(true);
    expect(rejected).toHaveBeenCalledTimes(1);

    gates[0]?.resolve('a');
    await expect(first).resolves.toBe('a');
    await settle();
    expect(started).toBe(3);

    gates[1]?.resolve('b');
    gates[2]?.resolve('c');
    await expect(second).resolves.toBe('b');
    await expect(third).resolves.toBe('c');
  });
});
