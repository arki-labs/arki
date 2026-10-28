import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MockClock } from '@arki/clock';

import { AsyncError, MAX_WAIT_MS } from './errors.js';
import { sleep } from './sleep.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const settled = async (promise: ReturnType<typeof sleep>) =>
  promise.then(
    value => value ?? ('resolved' as const),
    (error: unknown) => {
      if (error instanceof AsyncError) return error;
      throw error;
    },
  );

describe('sleep', () => {
  it('resolves after exactly the wait, not before', async () => {
    let done = false;
    void sleep(100).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(99);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it('sleep(0) still yields a macrotask: it does not resolve in the same tick', async () => {
    let done = false;
    void sleep(0).then(() => (done = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, MAX_WAIT_MS + 1])(
    'rejects an invalid wait (%s) with E001 and creates no timer',
    async ms => {
      const error = await settled(sleep(ms));
      expect(error).toBeInstanceOf(AsyncError);
      expect(error).toMatchObject({ code: 'ARKI_ASYNC_E001' });
      if (!(error instanceof AsyncError)) throw new Error('expected static delay misuse');
      expect(error.remediation).not.toBe('');
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('accepts the largest legal wait', async () => {
    const promise = sleep(MAX_WAIT_MS);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS);
    await expect(promise).resolves.toBeUndefined();
  });

  it('an already-aborted signal returns cancellation, cause = reason, and creates no timer', async () => {
    const reason = new Error('stop');
    const controller = new AbortController();
    controller.abort(reason);
    const promise = sleep(1000, { signal: controller.signal });
    expect(vi.getTimerCount()).toBe(0);
    const error = await settled(promise);
    expect(error).toMatchObject({ code: 'async.cancelled', cause: reason });
  });

  it('aborting during the wait returns cancellation and clears the timer', async () => {
    const controller = new AbortController();
    const promise = settled(sleep(1000, { signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort('because');
    expect(vi.getTimerCount()).toBe(0);
    expect(await promise).toMatchObject({ code: 'async.cancelled', cause: 'because' });
  });

  it('removes its abort listener when the wait ends normally', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const promise = sleep(50, { signal: controller.signal });
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    await expect(promise).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
    expect(remove.mock.calls[0]?.[0]).toBe('abort');
  });

  it('aborting after the wait ended does nothing', async () => {
    const controller = new AbortController();
    const promise = sleep(5, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(5);
    await expect(promise).resolves.toBeUndefined();
    controller.abort();
  });

  it('a second abort-listener never fires after settling by abort', async () => {
    const controller = new AbortController();
    const promise = settled(sleep(5, { signal: controller.signal }));
    controller.abort();
    expect(await promise).toMatchObject({ code: 'async.cancelled' });
    expect(vi.getTimerCount()).toBe(0);
  });
});

// A clock lets a caller's tests run long waits instantly, with no fake timers.
describe('sleep with a clock', () => {
  it('waits on the given clock, not on real time', async () => {
    const clock = new MockClock();
    let done = false;
    const waiting = sleep(60_000, { clock }).then(() => (done = true));
    clock.advance(59_999);
    await Promise.resolve();
    expect(done).toBe(false);
    clock.advance(1);
    await waiting;
    expect(done).toBe(true);
  });

  it('returns its canonical cancellation when the signal aborts', async () => {
    const clock = new MockClock();
    const controller = new AbortController();
    const result = settled(sleep(60_000, { clock, signal: controller.signal }));
    controller.abort('stop');
    const error = await result;
    expect(error).toMatchObject({ code: 'async.cancelled', cause: 'stop' });
    clock.advance(60_000);
  });
});
