import { describe, expect, it } from 'vitest';

import { MockClock, SystemClock } from './clock.js';
import { CLOCK_ERROR_CODES, ClockError } from './errors.js';

describe('ClockError', () => {
  it('carries a stable code and a remediation, so callers match on the code and not the message', () => {
    const clock = new MockClock();
    try {
      clock.advance(-5);
      expect.unreachable('advance(-5) should throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ClockError);
      expect(error).toMatchObject({ code: CLOCK_ERROR_CODES.invalidAdvance, name: 'ClockError' });
      expect(error instanceof ClockError && error.remediation.length > 0).toBe(true);
    }
    expect(CLOCK_ERROR_CODES.invalidAdvance).toBe('ARKI_CLOCK_E001');
  });
});

describe('SystemClock', () => {
  it('returns the current system time within a tight window', () => {
    const clock = new SystemClock();
    const before = Date.now();
    const observed = clock.now().getTime();
    const after = Date.now();
    expect(observed).toBeGreaterThanOrEqual(before);
    expect(observed).toBeLessThanOrEqual(after);
  });

  it('returns Date instances', () => {
    expect(new SystemClock().now()).toBeInstanceOf(Date);
  });
});

describe('MockClock', () => {
  it('defaults to the Unix epoch when no initial date is provided', () => {
    const clock = new MockClock();
    expect(clock.now().getTime()).toBe(0);
  });

  it('starts at the provided initial date', () => {
    const initial = new Date('2026-01-01T00:00:00.000Z');
    const clock = new MockClock(initial);
    expect(clock.now().getTime()).toBe(initial.getTime());
  });

  it('advances by the given number of milliseconds', () => {
    const clock = new MockClock(new Date('2026-01-01T00:00:00.000Z'));
    clock.advance(60_000);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:01:00.000Z');
  });

  it('accumulates sequential advances', () => {
    const clock = new MockClock(new Date(0));
    clock.advance(1000);
    clock.advance(2000);
    expect(clock.now().getTime()).toBe(3000);
  });

  it('treats advance(0) as a no-op', () => {
    const clock = new MockClock(new Date(0));
    clock.advance(0);
    expect(clock.now().getTime()).toBe(0);
  });

  it('rejects negative advances so tests cannot silently rewind time', () => {
    const clock = new MockClock();
    expect(() => clock.advance(-1)).toThrowError(/ARKI_CLOCK_E001/);
  });

  it('rejects non-finite advances', () => {
    const clock = new MockClock();
    expect(() => clock.advance(Number.NaN)).toThrowError(/ARKI_CLOCK_E001/);
    expect(() => clock.advance(Number.POSITIVE_INFINITY)).toThrowError(/ARKI_CLOCK_E001/);
  });

  it('returns a fresh Date on every call so callers cannot mutate clock state', () => {
    const clock = new MockClock(new Date('2026-01-01T00:00:00.000Z'));
    const first = clock.now();
    first.setFullYear(1990);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });

  it('allows setNow to jump to any absolute time, including backward', () => {
    const clock = new MockClock(new Date('2026-06-01T00:00:00.000Z'));
    clock.setNow(new Date('2026-01-01T00:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('supports advancing across a 72h window deterministically', () => {
    const start = new Date('2026-04-21T12:00:00.000Z');
    const clock = new MockClock(start);
    const sevenTwoHoursMs = 72 * 60 * 60 * 1000;
    clock.advance(sevenTwoHoursMs);
    expect(clock.now().toISOString()).toBe('2026-04-24T12:00:00.000Z');
  });
});
