import { describe, expect, it, vi } from 'vitest';

import type { Scheduler, SchedulerHandle } from './scheduler.js';
import { LockError } from './errors.js';
import { defaultScheduler } from './scheduler.js';
import { backoffDelay, parseDuration, raceSignal, withStoreTimeout } from './wait.js';

const TOP = () => 0.999_999;

function noop(): void {
  // Intentionally empty.
}

describe('parseDuration', () => {
  it.each([
    [0, 0],
    [250, 250],
    ['250ms', 250],
    ['2s', 2000],
    ['1.5s', 1500],
    ['5m', 300_000],
    ['1h', 3_600_000],
  ] as const)('%j is %d ms', (input, ms) => {
    expect(parseDuration(input)).toBe(ms);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, '-1s', '1d', '1w', 's', '', '1 s'])('rejects %j', input => {
    // Runtime input is untrusted; the type already forbids most of these.
    // @ts-expect-error not a Duration
    expect(() => parseDuration(input)).toThrow(LockError);
  });
});

describe('backoffDelay', () => {
  it('caps at 50 ms, doubling to 1 s, with full jitter', () => {
    const top = TOP;
    expect(backoffDelay(0, top)).toBeLessThan(50);
    expect(backoffDelay(1, top)).toBeLessThan(100);
    expect(backoffDelay(3, top)).toBeLessThan(400);
    expect(backoffDelay(10, top)).toBeLessThan(1000);
    expect(backoffDelay(10, top)).toBeGreaterThan(990);
    expect(backoffDelay(1000, top)).toBeLessThan(1000);
  });

  it('spreads over the whole range', () => {
    expect(backoffDelay(4, () => 0)).toBe(0);
    expect(backoffDelay(4, () => 0.5)).toBe(400);
  });
});

describe('raceSignal', () => {
  it('passes the value through and removes its listener', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await expect(raceSignal(Promise.resolve(7), controller.signal)).resolves.toBe(7);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('passes a rejection through', async () => {
    const boom = new Error('boom');
    await expect(raceSignal(Promise.reject(boom), new AbortController().signal)).rejects.toBe(boom);
  });

  it('rejects with aborted, carrying the reason, when the signal fires first', async () => {
    const controller = new AbortController();
    const pending = raceSignal(new Promise<number>(noop), controller.signal);
    controller.abort('stop');
    await expect(pending).rejects.toMatchObject({ code: 'aborted', cause: 'stop' });
  });

  it('rejects at once when already aborted, even if the promise is ready', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(raceSignal(Promise.resolve(1), controller.signal)).rejects.toMatchObject({ code: 'aborted' });
  });
});

/** A scheduler whose timers fire only when the test says so. */
function stepScheduler() {
  const timers = new Map<number, () => unknown>();
  let next = 0;
  const scheduler: Scheduler = {
    now: () => 0,
    setTimeout(cb) {
      const id = next++;
      timers.set(id, cb);
      return { id };
    },
    clearTimeout(handle: SchedulerHandle) {
      timers.delete(handle.id);
    },
  };
  return {
    scheduler,
    timers,
    fireAll: () => {
      for (const cb of timers.values()) void cb();
    },
  };
}

describe('withStoreTimeout', () => {
  it('returns the value and clears its timer', async () => {
    const { scheduler, timers } = stepScheduler();
    await expect(withStoreTimeout(Promise.resolve('ok'), 10, 'acquire', scheduler)).resolves.toBe('ok');
    expect(timers.size).toBe(0);
  });

  it('passes a store error through and clears its timer', async () => {
    const { scheduler, timers } = stepScheduler();
    const boom = new Error('boom');
    await expect(withStoreTimeout(Promise.reject(boom), 10, 'release', scheduler)).rejects.toBe(boom);
    expect(timers.size).toBe(0);
  });

  it('rejects store / unknown with method and timeoutMs when the store hangs', async () => {
    const { scheduler, fireAll } = stepScheduler();
    const pending = withStoreTimeout(new Promise<never>(noop), 25, 'extend', scheduler);
    fireAll();
    await expect(pending).rejects.toMatchObject({
      code: 'store',
      errorCode: 'ARKI_LOCK_E004',
      outcome: 'unknown',
      method: 'extend',
      timeoutMs: 25,
    });
  });

  it('lets the caller see a late settlement and does not leak a late rejection', async () => {
    const { scheduler, fireAll } = stepScheduler();
    let settle: (value: string) => void = noop;
    const late = new Promise<string>(resolve => {
      settle = resolve;
    });
    const pending = withStoreTimeout(late, 5, 'acquire', scheduler);
    fireAll();
    await expect(pending).rejects.toBeInstanceOf(LockError);
    settle('granted late');
    await expect(late).resolves.toBe('granted late');
  });

  it('uses the real timer by default', async () => {
    await expect(withStoreTimeout(new Promise<never>(noop), 5, 'acquire')).rejects.toMatchObject({
      timeoutMs: 5,
    });
  });
});

describe('defaultScheduler', () => {
  it('fires a timer, never fires a cleared one, and reads a monotonic clock', async () => {
    const fired: string[] = [];
    const before = defaultScheduler.now();
    defaultScheduler.setTimeout(() => fired.push('kept'), 5, { ref: true });
    const cleared = defaultScheduler.setTimeout(() => fired.push('cleared'), 5);
    defaultScheduler.clearTimeout(cleared);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(fired).toEqual(['kept']);
    expect(defaultScheduler.now()).toBeGreaterThanOrEqual(before);
  });
});
