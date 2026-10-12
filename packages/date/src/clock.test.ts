import { describe, expect, it } from 'vitest';

import { MockClock } from '@arki/clock';

import {
  isFuture,
  isPast,
  isThisMonth,
  isThisWeek,
  isThisYear,
  isToday,
  isTomorrow,
  isYesterday,
  now,
  nowIn,
  today,
} from './clock.js';
import { instant, plainDate, plainDateTime, zoned } from './core.js';

const clock = new MockClock(new Date('2026-10-09T22:30:00Z')); // Fri 22:30 UTC = Sat 01:30 in Bucharest
const buc = { clock, timeZone: 'Europe/Bucharest' };
const utc = { clock, timeZone: 'UTC' };

describe('now / today', () => {
  it('reads the injected clock once and never leaks a Date', () => {
    expect(now({ clock }).toString()).toBe('2026-10-09T22:30:00Z');
    expect(nowIn({ timeZone: 'Europe/Bucharest', clock }).toString()).toBe(
      '2026-10-10T01:30:00+03:00[Europe/Bucharest]',
    );
    expect(today(buc).toString()).toBe('2026-10-10');
    expect(today(utc).toString()).toBe('2026-10-09');
    clock.advance(60_000);
    expect(now({ clock }).toString()).toBe('2026-10-09T22:31:00Z');
    clock.setNow(new Date('2026-10-09T22:30:00Z'));
    expect(() => now()).not.toThrow();
  });
});

describe('current-period predicates', () => {
  it('depend on the comparison zone', () => {
    expect(isToday(plainDate('2026-10-10'), buc)).toBe(true);
    expect(isToday(plainDate('2026-10-10'), utc)).toBe(false);
    expect(isYesterday(plainDate('2026-10-09'), buc)).toBe(true);
    expect(isTomorrow(plainDate('2026-10-11'), buc)).toBe(true);
    expect(isToday(plainDateTime('2026-10-10T23:59'), buc)).toBe(true);
  });

  it('project instants into the zone and keep a zoned value in its own zone', () => {
    const i = instant('2026-10-10T00:30:00Z'); // 03:30 Oct 10 in Bucharest; clock says 22:30Z Oct 9 = Oct 10 in Bucharest
    expect(isToday(i, buc)).toBe(true);
    expect(isToday(i, utc)).toBe(false);
    expect(isTomorrow(i, utc)).toBe(true);
    expect(isToday(zoned(i, 'Europe/Bucharest'), { clock })).toBe(true);
    expect(isToday(zoned(i, 'Europe/Bucharest'), utc)).toBe(false); // explicit zone re-projects: 00:30Z is Oct 10 in UTC, UTC clock says Oct 9
    expect(isYesterday(zoned(i, 'Europe/Bucharest'), { clock })).toBe(false);
  });

  it('cover week, month and year with ISO weeks', () => {
    expect(isThisWeek(plainDate('2026-10-05'), buc)).toBe(true); // Mon of the week containing Sat Oct 10
    expect(isThisWeek(plainDate('2026-10-12'), buc)).toBe(false);
    expect(isThisWeek(plainDate('2026-10-11'), buc)).toBe(true);
    expect(isThisMonth(plainDate('2026-10-31'), buc)).toBe(true);
    expect(isThisMonth(plainDate('2026-11-01'), buc)).toBe(false);
    expect(isThisYear(plainDate('2026-01-01'), buc)).toBe(true);
    expect(isThisYear(plainDate('2027-01-01'), buc)).toBe(false);
  });

  it('isPast / isFuture are strict', () => {
    expect(isPast(instant('2026-10-09T22:29:59Z'), { clock })).toBe(true);
    expect(isPast(instant('2026-10-09T22:30:00Z'), { clock })).toBe(false);
    expect(isFuture(instant('2026-10-09T22:30:00Z'), { clock })).toBe(false);
    expect(isFuture(new Date('2026-10-09T22:30:01Z'), { clock })).toBe(true);
  });
});
