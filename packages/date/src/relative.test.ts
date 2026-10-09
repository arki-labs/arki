import { describe, expect, it } from 'vitest';

import { MockClock } from '@arki/clock';

import { instant, zoned } from './core.js';
import { add, sub } from './math.js';
import { relative, relativeToNow, relativeUnit } from './relative.js';

const BUC = 'Europe/Bucharest';
const REF = instant('2026-01-15T12:00:00Z');
const UTC = { timeZone: 'UTC' } as const;

describe('relative — auto unit thresholds', () => {
  // [description, target, expected en-US text]
  const cases: readonly (readonly [string, ReturnType<typeof instant>, string])[] = [
    ['59 s later', add(REF, { seconds: 59 }), 'in 59 seconds'],
    ['60 s later', add(REF, { seconds: 60 }), 'in 1 minute'],
    ['59 min earlier', sub(REF, { minutes: 59 }), '59 minutes ago'],
    ['60 min later', add(REF, { minutes: 60 }), 'in 1 hour'],
    ['23 h 59 min later', add(REF, { hours: 23, minutes: 59 }), 'in 23 hours'],
    ['24 h later', add(REF, { hours: 24 }), 'in 1 day'],
    ['6 days later', add(REF, { hours: 6 * 24 }), 'in 6 days'],
    ['7 days later', add(REF, { hours: 7 * 24 }), 'in 1 week'],
    ['7 days earlier', sub(REF, { hours: 7 * 24 }), '1 week ago'],
    ['27 days later', add(REF, { hours: 27 * 24 }), 'in 3 weeks'],
    ['1 month later', instant('2026-02-15T12:00:00Z'), 'in 1 month'],
    ['11 months later', instant('2026-12-15T12:00:00Z'), 'in 11 months'],
    ['12 months later', instant('2027-01-15T12:00:00Z'), 'in 1 year'],
    ['3 years earlier', instant('2023-01-15T12:00:00Z'), '3 years ago'],
  ];

  it.each(cases)('%s → %s', (_label, target, expected) => {
    expect(relative(target, REF, UTC)).toBe(expected);
  });

  it('counts calendar days, not 24-hour blocks, once past 24 hours', () => {
    // 26 elapsed hours, but the target is two calendar days later.
    expect(relative(instant('2026-01-17T01:00:00Z'), instant('2026-01-15T23:00:00Z'), UTC)).toBe('in 2 days');
  });

  it('treats a 23-hour DST day as hours and the next calendar day as a day', () => {
    // Bucharest springs forward on 2026-03-29: noon to noon is only 23 elapsed hours.
    const ref = zoned({ year: 2026, month: 3, day: 28, hour: 12 }, BUC);
    expect(relative(add(ref, { days: 1 }), ref)).toBe('in 23 hours');
    expect(relative(add(ref, { hours: 24 }), ref)).toBe('in 1 day');
  });

  it('uses the target zone for calendar days unless a zone is given', () => {
    const ref = instant('2026-01-15T21:30:00Z'); // 23:30 in Bucharest, 21:30 in UTC
    const target = zoned('2026-01-17T00:30:00+02:00[Europe/Bucharest]'); // 25 h later
    expect(relative(target, ref)).toBe('in 2 days');
    expect(relative(target, ref, UTC)).toBe('in 1 day');
  });
});

describe('relative — options', () => {
  it('says yesterday / tomorrow with numeric auto', () => {
    expect(relative(add(REF, { hours: 24 }), REF, { ...UTC, numeric: 'auto' })).toBe('tomorrow');
    expect(relative(sub(REF, { hours: 24 }), REF, { ...UTC, numeric: 'auto' })).toBe('yesterday');
    expect(relative(sub(REF, { hours: 24 }), REF, UTC)).toBe('1 day ago');
  });

  it('honours a forced unit and the style', () => {
    expect(relative(add(REF, { hours: 48 }), REF, { ...UTC, unit: 'hour' })).toBe('in 48 hours');
    expect(relative(instant('2026-08-15T12:00:00Z'), REF, { ...UTC, unit: 'quarter' })).toBe('in 2 quarters');
    expect(relative(add(REF, { hours: 3 }), REF, { style: 'short' })).toBe('in 3 hr.');
  });

  it('accepts Date inputs', () => {
    expect(relative(new Date('2026-01-15T11:00:00Z'), new Date('2026-01-15T12:00:00Z'))).toBe('1 hour ago');
  });

  it('formats in the caller locale', () => {
    const ro = relative(add(REF, { hours: 72 }), REF, { ...UTC, locale: 'ro-RO' });
    expect(ro).not.toBe('');
    expect(ro).not.toBe(relative(add(REF, { hours: 72 }), REF, UTC));
  });
});

describe('relativeUnit', () => {
  it('exposes the chosen unit and the signed, truncated value', () => {
    expect(relativeUnit(add(REF, { seconds: 90 }), REF)).toEqual({ unit: 'minute', value: 1 });
    expect(relativeUnit(sub(REF, { minutes: 150 }), REF)).toEqual({ unit: 'hour', value: -2 });
    expect(relativeUnit(add(REF, { hours: 20 * 24 }), REF, UTC)).toEqual({ unit: 'week', value: 2 });
  });
});

describe('relativeToNow', () => {
  it('reads now from the given clock', () => {
    const clock = new MockClock(new Date('2026-01-15T12:00:00Z'));
    expect(relativeToNow(instant('2026-01-15T09:00:00Z'), { clock })).toBe('3 hours ago');
    clock.advance(6 * 60 * 60 * 1000);
    expect(relativeToNow(instant('2026-01-15T09:00:00Z'), { clock })).toBe('9 hours ago');
  });
});
