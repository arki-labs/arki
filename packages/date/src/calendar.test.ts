import { describe, expect, it } from 'vitest';

import {
  age,
  calendarDaysBetween,
  dayOfWeek,
  dayOfYear,
  daysInMonth,
  daysInYear,
  easter,
  isLeapYear,
  isoWeek,
  isWeekday,
  isWeekend,
  lastWeekdayOfMonth,
  nthWeekdayOfMonth,
  quarter,
  weekOf,
  weekRulesFor,
  weeksInYear,
} from './calendar.js';
import { plainDate, zoned } from './core.js';
import { ISO_WEEK, SUNDAY_WEEK } from './types.js';

describe('calendar facts', () => {
  it('reports weekday, day of year, month/year lengths and leap years', () => {
    expect(dayOfWeek(plainDate('2026-10-09'))).toBe(5);
    expect(dayOfWeek(zoned('2026-10-11T00:00:00+03:00[Europe/Bucharest]'))).toBe(7);
    expect(dayOfYear(plainDate('2026-12-31'))).toBe(365);
    expect(daysInMonth(plainDate('2024-02-01'))).toBe(29);
    expect(daysInYear(plainDate('2024-06-01'))).toBe(366);
    expect(isLeapYear(2000)).toBe(true);
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(plainDate('2026-01-01'))).toBe(false);
    expect(quarter(plainDate('2026-03-31'))).toBe(1);
    expect(quarter(plainDate('2026-04-01'))).toBe(2);
    expect(quarter(plainDate('2026-12-01'))).toBe(4);
  });

  it('knows weekends, configurable', () => {
    expect(isWeekend(plainDate('2026-10-10'))).toBe(true);
    expect(isWeekday(plainDate('2026-10-09'))).toBe(true);
    expect(isWeekend(plainDate('2026-10-09'), [5, 6])).toBe(true);
  });
});

describe('weeks', () => {
  it('computes ISO week and week-year across New Year', () => {
    expect(isoWeek(plainDate('2026-01-01'))).toEqual({ week: 1, weekYear: 2026 });
    expect(isoWeek(plainDate('2027-01-01'))).toEqual({ week: 53, weekYear: 2026 });
    expect(isoWeek(plainDate('2027-01-04'))).toEqual({ week: 1, weekYear: 2027 });
    expect(isoWeek(plainDate('2024-12-30'))).toEqual({ week: 1, weekYear: 2025 });
    expect(isoWeek(plainDate('2021-01-03'))).toEqual({ week: 53, weekYear: 2020 });
    expect(isoWeek(plainDate('2026-10-09'))).toEqual({ week: 41, weekYear: 2026 });
    expect(weeksInYear(2026)).toBe(53);
    expect(weeksInYear(2025)).toBe(52);
    expect(weeksInYear(2020)).toBe(53);
  });

  it('supports Sunday-first weeks where week 1 contains January 1', () => {
    expect(weekOf(plainDate('2026-01-01'), SUNDAY_WEEK)).toEqual({ week: 1, weekYear: 2026 });
    expect(weekOf(plainDate('2025-12-28'), SUNDAY_WEEK)).toEqual({ week: 1, weekYear: 2026 }); // Sunday starting the week of Jan 1
    expect(weekOf(plainDate('2025-12-27'), SUNDAY_WEEK)).toEqual({ week: 52, weekYear: 2025 });
    expect(weekOf(plainDate('2026-12-31'), SUNDAY_WEEK)).toEqual({ week: 1, weekYear: 2027 }); // Jan 1 2027 is a Friday; its week starts Sun Dec 27
    expect(weekOf(plainDate('2026-12-26'), SUNDAY_WEEK)).toEqual({ week: 52, weekYear: 2026 });
  });
});

describe('calendarDaysBetween / age', () => {
  it('counts date boundaries, signed', () => {
    expect(calendarDaysBetween(plainDate('2026-01-01'), plainDate('2026-03-01'))).toBe(59);
    expect(calendarDaysBetween(plainDate('2026-03-01'), plainDate('2026-01-01'))).toBe(-59);
  });

  it('returns completed years with a leap-day policy', () => {
    expect(age(plainDate('2000-05-20'), plainDate('2026-05-19'))).toBe(25);
    expect(age(plainDate('2000-05-20'), plainDate('2026-05-20'))).toBe(26);
    expect(age(plainDate('2000-02-29'), plainDate('2026-02-28'))).toBe(26);
    expect(age(plainDate('2000-02-29'), plainDate('2026-02-28'), { leapDay: 'mar1' })).toBe(25);
    expect(age(plainDate('2000-02-29'), plainDate('2026-03-01'), { leapDay: 'mar1' })).toBe(26);
    expect(age(plainDate('2000-02-29'), plainDate('2024-02-29'))).toBe(24);
    expect(() => age(plainDate('2026-01-01'), plainDate('2025-12-31'))).toThrow(RangeError);
  });
});

describe('nthWeekdayOfMonth / lastWeekdayOfMonth', () => {
  it('counts from the start and from the end', () => {
    expect(nthWeekdayOfMonth(2026, 5, 1, 5).toString()).toBe('2026-05-01'); // May 1 2026 is a Friday
    expect(nthWeekdayOfMonth(2026, 5, 2, 5).toString()).toBe('2026-05-08');
    expect(nthWeekdayOfMonth(2026, 5, 1, 1).toString()).toBe('2026-05-04');
    expect(nthWeekdayOfMonth(2026, 5, -1, 7).toString()).toBe('2026-05-31');
    expect(lastWeekdayOfMonth(2026, 2, 5).toString()).toBe('2026-02-27');
    expect(nthWeekdayOfMonth(2026, 5, 5, 5).toString()).toBe('2026-05-29'); // five Fridays in May 2026
  });

  it('rejects a weekday the month does not have that many of', () => {
    expect(() => nthWeekdayOfMonth(2026, 5, 5, 1)).toThrow(/no weekday 1 number 5/);
    expect(() => nthWeekdayOfMonth(2026, 13, 1, 1)).toThrow(RangeError);
    expect(() => nthWeekdayOfMonth(2026, 5, 0, 1)).toThrow(RangeError);
  });
});

describe('easter', () => {
  it.each([
    [2024, '2024-03-31', '2024-05-05'],
    [2025, '2025-04-20', '2025-04-20'],
    [2026, '2026-04-05', '2026-04-12'],
    [2027, '2027-03-28', '2027-05-02'],
    [2030, '2030-04-21', '2030-04-28'],
    [2100, '2100-03-28', '2100-05-02'],
  ])('%d: western %s, orthodox %s', (year, western, orthodox) => {
    expect(easter(year).toString()).toBe(western);
    expect(easter(year, 'orthodox').toString()).toBe(orthodox);
  });

  it('rejects years before the Gregorian reform', () => {
    expect(() => easter(1500)).toThrow(RangeError);
  });
});

describe('weekRulesFor', () => {
  it('returns the fallback when the runtime has no Intl.Locale at all (Hermes), instead of crashing', () => {
    const real = Reflect.get(Intl, 'Locale');
    Reflect.set(Intl, 'Locale', undefined);
    try {
      expect(weekRulesFor('en-US')).toEqual({ startsOn: 1, minimalDays: 4 });
    } finally {
      Reflect.set(Intl, 'Locale', real);
    }
  });

  it('reads Intl week info and falls back for unknown runtimes', () => {
    const us = weekRulesFor('en-US');
    const de = weekRulesFor('de-DE');
    // Engines with week info agree on these two; without it both are the fallback.
    const hasWeekInfo =
      typeof new Intl.Locale('en-US').getWeekInfo === 'function' || 'weekInfo' in new Intl.Locale('en-US');
    if (hasWeekInfo) {
      expect(us).toEqual({ startsOn: 7, minimalDays: 1 });
      expect(de).toEqual({ startsOn: 1, minimalDays: 4 });
    } else {
      expect(us).toBe(ISO_WEEK);
    }
    expect(weekRulesFor('en-US', SUNDAY_WEEK).startsOn).toBe(7);
  });
});

describe('weekRulesFor with a malformed tag', () => {
  it('reads it as the default locale instead of throwing', () => {
    expect(weekRulesFor('not a locale!')).toEqual(weekRulesFor('en-US'));
  });
});
