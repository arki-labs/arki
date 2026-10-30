import { debounce as debounceLodash, throttle as throttleLodash } from 'lodash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MockClock } from '@arki/clock';

import { AsyncError, MAX_WAIT_MS } from './errors.js';
import { debounce, throttle } from './schedule.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

const tick = (ms: number): void => {
  vi.advanceTimersByTime(ms);
};

describe('debounce', () => {
  it('trailing only (default): fires once, after the burst, with the latest arguments', () => {
    const fn = vi.fn<(n: number) => void>();
    const d = debounce(fn, 100);
    d(1);
    tick(50);
    d(2);
    tick(50);
    d(3);
    tick(99);
    expect(fn).not.toHaveBeenCalled();
    tick(1);
    expect(fn.mock.calls).toEqual([[3]]);
    tick(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('leading only: fires on the first call, ignores the rest of the burst, fires again after a quiet wait', () => {
    const fn = vi.fn<(n: number) => void>();
    const d = debounce(fn, 100, { leading: true, trailing: false });
    d(1);
    expect(fn.mock.calls).toEqual([[1]]);
    tick(50);
    d(2);
    tick(60);
    d(3);
    expect(fn).toHaveBeenCalledTimes(1);
    tick(100);
    expect(fn).toHaveBeenCalledTimes(1);
    d(4);
    expect(fn.mock.calls).toEqual([[1], [4]]);
  });

  it('leading and trailing: a single call fires once; a burst fires first and last', () => {
    const fn = vi.fn<(n: number) => void>();
    const d = debounce(fn, 100, { leading: true });
    d(1);
    tick(200);
    expect(fn.mock.calls).toEqual([[1]]);
    d(2);
    tick(30);
    d(3);
    tick(30);
    d(4);
    tick(100);
    expect(fn.mock.calls).toEqual([[1], [2], [4]]);
  });

  it('neither leading nor trailing never fires', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100, { leading: false, trailing: false });
    d();
    tick(500);
    expect(fn).not.toHaveBeenCalled();
  });

  it('maxWait: a never-ending burst still fires at least every maxWait', () => {
    const fn = vi.fn<(n: number) => void>();
    const d = debounce(fn, 100, { maxWait: 250 });
    for (let i = 1; i <= 20; i++) {
      d(i);
      tick(40);
    }
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(3);
    const times = fn.mock.calls.length;
    tick(100);
    expect(fn.mock.calls.length).toBe(times + 1);
    expect(fn.mock.calls.at(-1)).toEqual([20]);
  });

  it('without maxWait the same endless burst never fires', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    for (let i = 0; i < 20; i++) {
      d();
      tick(40);
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it('maxWait below wait is raised to wait', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100, { maxWait: 10 });
    d();
    tick(99);
    expect(fn).not.toHaveBeenCalled();
    tick(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('cancel drops the pending call and allows a fresh leading call', () => {
    const fn = vi.fn<(n: number) => void>();
    const d = debounce(fn, 100, { leading: true });
    d(1);
    d(2);
    expect(d.pending).toBe(true);
    d.cancel();
    expect(d.pending).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    tick(500);
    expect(fn.mock.calls).toEqual([[1]]);
    d(3);
    expect(fn.mock.calls).toEqual([[1], [3]]);
  });

  it('flush runs the pending trailing call now, once', () => {
    const fn = vi.fn<(n: number) => void>();
    const d = debounce(fn, 100);
    d(1);
    d(2);
    d.flush();
    expect(fn.mock.calls).toEqual([[2]]);
    expect(d.pending).toBe(false);
    tick(500);
    expect(fn).toHaveBeenCalledTimes(1);
    d.flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('flush does not call anything when only the leading edge ran', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100, { leading: true, trailing: false });
    d();
    d.flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('pending is true from the first call until the trailing edge', () => {
    const d = debounce(vi.fn(), 100);
    expect(d.pending).toBe(false);
    d();
    expect(d.pending).toBe(true);
    tick(100);
    expect(d.pending).toBe(false);
  });

  it('works detached from any object: no `this` needed', () => {
    const seen: string[] = [];
    const log = (s: string): void => void seen.push(s);
    const { d } = { d: debounce(log, 10) };
    d('a');
    tick(10);
    expect(seen).toEqual(['a']);
  });

  it('wait 0 still fires on a timer, not synchronously', () => {
    const fn = vi.fn();
    const d = debounce(fn, 0);
    d();
    expect(fn).not.toHaveBeenCalled();
    tick(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, MAX_WAIT_MS + 1])('throws E001 for wait %s', wait => {
    expect(() => debounce(vi.fn(), wait)).toThrowError(AsyncError);
    expect(() => debounce(vi.fn(), wait)).toThrowError(/ARKI_ASYNC_E001/);
  });

  it('throws E001 for an invalid maxWait', () => {
    expect(() => debounce(vi.fn(), 10, { maxWait: -5 })).toThrowError(/ARKI_ASYNC_E001/);
  });
});

describe('throttle', () => {
  it('defaults: fires at once, then at the end of the window with the latest arguments', () => {
    const fn = vi.fn<(n: number) => void>();
    const t = throttle(fn, 100);
    t(1);
    expect(fn.mock.calls).toEqual([[1]]);
    tick(30);
    t(2);
    tick(30);
    t(3);
    tick(30);
    t(4);
    expect(fn).toHaveBeenCalledTimes(1);
    tick(10);
    expect(fn.mock.calls).toEqual([[1], [4]]);
  });

  it('a single call fires once and nothing trails', () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);
    t();
    tick(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('leading only: drops calls inside the window', () => {
    const fn = vi.fn<(n: number) => void>();
    const t = throttle(fn, 100, { trailing: false });
    t(1);
    tick(50);
    t(2);
    tick(60);
    expect(fn.mock.calls).toEqual([[1]]);
    t(3);
    expect(fn.mock.calls).toEqual([[1], [3]]);
  });

  it('trailing only: first fire is at the end of the window', () => {
    const fn = vi.fn<(n: number) => void>();
    const t = throttle(fn, 100, { leading: false });
    t(1);
    tick(40);
    t(2);
    expect(fn).not.toHaveBeenCalled();
    tick(60);
    expect(fn.mock.calls).toEqual([[2]]);
  });

  it('a steady stream fires once per window', () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);
    for (let i = 0; i < 100; i++) {
      t();
      tick(10);
    }
    // 1000 ms of calls at 10 ms apart: about one fire per 100 ms, never one per call.
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(9);
    expect(fn.mock.calls.length).toBeLessThanOrEqual(11);
  });

  it('cancel, flush and pending work like debounce', () => {
    const fn = vi.fn<(n: number) => void>();
    const t = throttle(fn, 100);
    t(1);
    t(2);
    expect(t.pending).toBe(true);
    t.flush();
    expect(fn.mock.calls).toEqual([[1], [2]]);
    t(3);
    t.cancel();
    expect(t.pending).toBe(false);
    tick(500);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it.each([-1, Number.NaN, MAX_WAIT_MS + 1])('throws E001 for wait %s', wait => {
    expect(() => throttle(vi.fn(), wait)).toThrowError(/ARKI_ASYNC_E001/);
  });
});

/**
 * The contract is "the familiar lodash one". These tests replay the same random
 * call schedule against lodash 4.18 and require the same calls at the same
 * times, so any drift in semantics fails here. (The standalone `lodash.debounce`
 * 4.0.8 leaves an orphan timer after a maxWait call; that is its bug, not the contract.)
 */
const rng = (start: number) => {
  let seed = start;
  return () => {
    seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return seed / 4_294_967_296;
  };
};

describe('matches lodash on random schedules', () => {
  type Make = (fn: (n: number) => void) => (n: number) => void;
  const record = (make: Make, gaps: readonly number[]): string => {
    vi.setSystemTime(0);
    const out: string[] = [];
    const wrapped = make(n => void out.push(`${Date.now()}:${n}`));
    for (const [i, gap] of gaps.entries()) {
      wrapped(i);
      vi.advanceTimersByTime(gap);
    }
    vi.advanceTimersByTime(10_000);
    return out.join(',');
  };

  const schedules = Array.from({ length: 60 }, (_, seed) => {
    const next = rng(seed + 1);
    return Array.from({ length: 25 }, () => Math.floor(next() * next() * 260));
  });

  const options = [
    { leading: false, trailing: true },
    { leading: true, trailing: false },
    { leading: true, trailing: true },
    { leading: false, trailing: true, maxWait: 250 },
    { leading: true, trailing: true, maxWait: 130 },
  ] as const;

  for (const option of options) {
    it(`debounce ${JSON.stringify(option)}`, () => {
      for (const gaps of schedules) {
        const ours = record(fn => debounce(fn, 100, option), gaps);
        const theirs = record(fn => debounceLodash(fn, 100, option), gaps);
        expect(ours).toBe(theirs);
      }
    });
  }

  for (const option of [
    { leading: true, trailing: true },
    { leading: true, trailing: false },
    { leading: false, trailing: true },
  ] as const) {
    it(`throttle ${JSON.stringify(option)}`, () => {
      for (const gaps of schedules) {
        const ours = record(fn => throttle(fn, 100, option), gaps);
        const theirs = record(fn => throttleLodash(fn, 100, option), gaps);
        expect(ours).toBe(theirs);
      }
    });
  }
});

// With a clock, debounce and throttle follow its time and timers, so a test
// drives them with `advance` and needs no fake timers.
describe('debounce and throttle with a clock', () => {
  it('debounce reads the clock for both time and timers', () => {
    vi.useRealTimers();
    const clock = new MockClock();
    const fn = vi.fn<(n: number) => void>();
    const d = debounce(fn, 30_000, { clock });
    d(1);
    clock.advance(20_000);
    d(2);
    clock.advance(29_999);
    expect(fn).not.toHaveBeenCalled();
    clock.advance(1);
    expect(fn).toHaveBeenCalledExactlyOnceWith(2);
    expect(d.pending).toBe(false);
  });

  it('throttle with maxWait semantics fires leading and trailing on the clock', () => {
    vi.useRealTimers();
    const clock = new MockClock();
    const fn = vi.fn<(n: number) => void>();
    const t = throttle(fn, 60_000, { clock });
    t(1);
    clock.advance(10_000);
    t(2);
    clock.advance(10_000);
    t(3);
    expect(fn.mock.calls).toEqual([[1]]);
    clock.advance(40_000);
    expect(fn.mock.calls).toEqual([[1], [3]]);
  });

  it('cancel drops the clock timer', () => {
    vi.useRealTimers();
    const clock = new MockClock();
    const fn = vi.fn();
    const d = debounce(fn, 1000, { clock });
    d();
    d.cancel();
    clock.advance(5000);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('errors from the callback', () => {
  it('debounce hands a thrown error to onError and stays usable', () => {
    const onError = vi.fn();
    const boom = new Error('boom');
    const calls: number[] = [];
    const d = debounce(
      (n: number) => {
        calls.push(n);
        if (n === 1) throw boom;
      },
      10,
      { onError },
    );
    d(1);
    tick(10);
    expect(onError).toHaveBeenCalledExactlyOnceWith(boom);
    expect(d.pending).toBe(false);
    d(2);
    tick(10);
    expect(calls).toEqual([1, 2]);
  });

  it('a throw on the leading edge does not reach the caller of the scheduled function', () => {
    const onError = vi.fn();
    const t = throttle(
      () => {
        throw new Error('leading');
      },
      10,
      { onError },
    );
    expect(() => t()).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(t.pending).toBe(true);
  });

  it('a rejected promise from an async callback goes to onError', async () => {
    vi.useRealTimers();
    const errors: unknown[] = [];
    const reason = new Error('rejected');
    // The callback type says void; an async callback still fits it, and that is the case under test.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    const d = debounce(() => Promise.reject(reason), 1, { onError: error => errors.push(error) });
    d();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(errors).toEqual([reason]);
  });
});
