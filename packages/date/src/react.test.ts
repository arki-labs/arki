// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MockClock } from '@arki/clock';

import { instant } from './core.js';
import { useNow, useRelativeTime, useToday } from './react.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function tick(clock: MockClock, ms: number): void {
  act(() => {
    clock.advance(ms);
    vi.advanceTimersByTime(ms);
  });
}

describe('useNow', () => {
  it('reads the clock on first render and re-reads every second by default', () => {
    const clock = new MockClock(new Date('2026-10-09T09:00:00Z'));
    const { result } = renderHook(() => useNow({ clock }));
    expect(result.current.toString()).toBe('2026-10-09T09:00:00Z');
    tick(clock, 1000);
    expect(result.current.toString()).toBe('2026-10-09T09:00:01Z');
  });
  it('honours `every` and never ticks for 0 or Infinity', () => {
    const clock = new MockClock(new Date('2026-10-09T09:00:00Z'));
    const slow = renderHook(() => useNow({ clock, every: 5000 }));
    tick(clock, 4000);
    expect(slow.result.current.toString()).toBe('2026-10-09T09:00:00Z');
    tick(clock, 1000);
    expect(slow.result.current.toString()).toBe('2026-10-09T09:00:05Z');
    for (const every of [0, Infinity]) {
      const still = renderHook(() => useNow({ clock, every }));
      const first = still.result.current;
      tick(clock, 60_000);
      expect(still.result.current).toBe(first);
    }
  });
  it('stops its timer on unmount', () => {
    const clock = new MockClock(new Date('2026-10-09T09:00:00Z'));
    const { unmount } = renderHook(() => useNow({ clock }));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('useToday', () => {
  it('keeps the same object until the date changes', () => {
    const clock = new MockClock(new Date('2026-10-09T10:00:00Z'));
    const { result } = renderHook(() => useToday({ clock, timeZone: 'UTC' }));
    const first = result.current;
    expect(first.toString()).toBe('2026-10-09');
    tick(clock, 60_000);
    expect(result.current).toBe(first);
    tick(clock, 14 * 60 * 60 * 1000);
    expect(result.current.toString()).toBe('2026-10-10');
  });
  it('uses the given zone', () => {
    const clock = new MockClock(new Date('2026-10-09T20:00:00Z'));
    const { result } = renderHook(() => useToday({ clock, timeZone: 'Asia/Tokyo' }));
    expect(result.current.toString()).toBe('2026-10-10');
  });
});

describe('useRelativeTime', () => {
  it('refreshes the text as the clock moves', () => {
    const clock = new MockClock(new Date('2026-10-09T09:00:00Z'));
    const target = instant('2026-10-09T09:05:00Z');
    const { result } = renderHook(() => useRelativeTime(target, { clock }));
    expect(result.current).toBe('in 5 minutes');
    tick(clock, 60_000);
    expect(result.current).toBe('in 4 minutes');
  });
  it('passes formatting options through', () => {
    const clock = new MockClock(new Date('2026-10-09T09:00:00Z'));
    const { result } = renderHook(() => useRelativeTime(new Date('2026-10-09T08:55:00Z'), { clock, style: 'short' }));
    expect(result.current).toBe('5 min. ago');
  });
});
