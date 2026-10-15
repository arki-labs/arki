import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultScheduler } from './scheduler.js';

const MAX_TIMER_MS = 2 ** 31 - 1;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

describe('defaultScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits the full delay past the 2^31-1 ms timer limit, because a 30-day holdAtLeast or deadline firing at once would let a second replica run', () => {
    const fired = vi.fn();
    defaultScheduler.setTimeout(fired, THIRTY_DAYS_MS);
    vi.advanceTimersByTime(1000);
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(THIRTY_DAYS_MS - 1001);
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('fires a delay of exactly the limit once and on time, so chunking never adds a stray wake-up', () => {
    const fired = vi.fn();
    defaultScheduler.setTimeout(fired, MAX_TIMER_MS);
    vi.advanceTimersByTime(MAX_TIMER_MS - 1);
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a long timer after it has rolled into a later chunk, because a released lock must not fire its old deadline', () => {
    const fired = vi.fn();
    const handle = defaultScheduler.setTimeout(fired, THIRTY_DAYS_MS);
    vi.advanceTimersByTime(MAX_TIMER_MS + 1000);
    defaultScheduler.clearTimeout(handle);
    vi.advanceTimersByTime(THIRTY_DAYS_MS);
    expect(fired).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
