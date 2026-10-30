import { describe, expect, it } from 'vitest';

import type { BusinessCalendar } from './business.js';
import type { PlainDate } from './types.js';
import {
  addBusinessDays,
  businessCalendar,
  businessDaysBetween,
  businessDaysIn,
  DEFAULT_BUSINESS_CALENDAR,
  isBusinessDay,
  nextBusinessDay,
  previousBusinessDay,
  subBusinessDays,
} from './business.js';
import { plainDate, plainDateTime, zoned } from './core.js';
import { interval } from './interval.js';

const XMAS = businessCalendar({ holidays: ['2026-12-25', plainDate('2027-01-01')] });

describe('businessCalendar', () => {
  it('defaults to a Saturday + Sunday weekend with no holidays', () => {
    expect(DEFAULT_BUSINESS_CALENDAR.weekend).toEqual([6, 7]);
    expect(DEFAULT_BUSINESS_CALENDAR.holidays.size).toBe(0);
    expect(Object.isFrozen(DEFAULT_BUSINESS_CALENDAR)).toBe(true);
  });

  it('dedupes, sorts and validates its inputs', () => {
    const cal = businessCalendar({ weekend: [7, 6, 6], holidays: ['2026-12-25', plainDate('2026-12-25')] });
    expect(cal.weekend).toEqual([6, 7]);
    expect([...cal.holidays]).toEqual(['2026-12-25']);
    // A seven-day weekend would make every business-day walk loop forever.
    expect(() => businessCalendar({ weekend: [1, 2, 3, 4, 5, 6, 7] })).toThrow(RangeError);
    expect(() => businessCalendar({ holidays: ['2026-12-25T00:00'] })).toThrow(RangeError);
    expect(() => businessCalendar({ holidays: ['2026-02-30'] })).toThrow(RangeError);
  });
});

describe('a hand-built calendar with seven weekend days', () => {
  it('throws instead of looping forever, with or without holidays', () => {
    const allOff = [1, 2, 3, 4, 5, 6, 7] as const;
    const withHolidays: BusinessCalendar = { weekend: allOff, holidays: new Set(['2026-12-25']) };
    const withoutHolidays: BusinessCalendar = { weekend: allOff, holidays: new Set() };
    const start = plainDate('2026-05-20');
    expect(() => nextBusinessDay(start, withHolidays)).toThrow(RangeError);
    expect(() => addBusinessDays(start, 3, withoutHolidays)).toThrow(RangeError);
    expect(() => subBusinessDays(start, 3, withHolidays)).toThrow(RangeError);
    expect(() => previousBusinessDay(start, withHolidays)).toThrow(RangeError);
  });
});

describe('isBusinessDay', () => {
  it('excludes weekends and holidays, judging zoned values by their own date', () => {
    expect(isBusinessDay(plainDate('2026-10-09'))).toBe(true); // Friday
    expect(isBusinessDay(plainDate('2026-10-10'))).toBe(false); // Saturday
    expect(isBusinessDay(plainDate('2026-12-25'), XMAS)).toBe(false);
    expect(isBusinessDay(plainDateTime('2026-12-25T10:00'), XMAS)).toBe(false);
    // 23:30 on Thursday in Bucharest is already Friday in UTC — the zone's own date wins.
    expect(isBusinessDay(zoned('2026-12-24T23:30+02:00[Europe/Bucharest]'), XMAS)).toBe(true);
  });
});

describe('addBusinessDays / subBusinessDays', () => {
  it('skips weekends and holidays and does not count the start day', () => {
    expect(addBusinessDays(plainDate('2026-12-24'), 2, XMAS).toString()).toBe('2026-12-29');
    expect(addBusinessDays(plainDate('2026-10-09'), 1).toString()).toBe('2026-10-12'); // Friday → Monday
    expect(addBusinessDays(plainDate('2026-10-10'), 1).toString()).toBe('2026-10-12'); // Saturday → Monday
    expect(addBusinessDays(plainDate('2026-10-05'), 10).toString()).toBe('2026-10-19');
  });

  it('walks back for negative counts and leaves zero unchanged', () => {
    expect(addBusinessDays(plainDate('2026-10-12'), -1).toString()).toBe('2026-10-09');
    expect(subBusinessDays(plainDate('2026-10-12'), 3).toString()).toBe('2026-10-07');
    expect(subBusinessDays(plainDate('2026-12-29'), 2, XMAS).toString()).toBe('2026-12-24');
    expect(addBusinessDays(plainDate('2026-10-10'), 0).toString()).toBe('2026-10-10');
    expect(subBusinessDays(plainDate('2026-10-10'), 0).toString()).toBe('2026-10-10');
    expect(() => addBusinessDays(plainDate('2026-10-10'), 1.5)).toThrow(RangeError);
    expect(() => subBusinessDays(plainDate('2026-10-10'), Number.NaN)).toThrow(RangeError);
  });

  it('keeps the wall-clock time of zoned values across a DST change', () => {
    const friday = zoned({ year: 2026, month: 3, day: 27, hour: 9, minute: 30 }, 'Europe/Bucharest');
    expect(addBusinessDays(friday, 1).toString()).toBe('2026-03-30T09:30:00+03:00[Europe/Bucharest]');
    expect(addBusinessDays(plainDateTime('2026-10-09T17:45'), 1).toString()).toBe('2026-10-12T17:45:00');
  });

  it('honours a custom Friday + Saturday weekend', () => {
    const gulf = businessCalendar({ weekend: [5, 6] });
    expect(addBusinessDays(plainDate('2026-10-08'), 1, gulf).toString()).toBe('2026-10-11'); // Thursday → Sunday
    expect(isBusinessDay(plainDate('2026-10-11'), gulf)).toBe(true);
    expect(businessDaysBetween(plainDate('2026-10-05'), plainDate('2026-10-12'), gulf)).toBe(5);
  });
});

describe('nextBusinessDay / previousBusinessDay', () => {
  it('is strictly after or before the input', () => {
    expect(nextBusinessDay(plainDate('2026-10-07')).toString()).toBe('2026-10-08');
    expect(nextBusinessDay(plainDate('2026-12-24'), XMAS).toString()).toBe('2026-12-28');
    expect(previousBusinessDay(plainDate('2026-10-12')).toString()).toBe('2026-10-09');
    expect(previousBusinessDay(plainDate('2027-01-04'), XMAS).toString()).toBe('2026-12-31');
  });
});

describe('businessDaysBetween / businessDaysIn', () => {
  it('counts the half-open range and negates when reversed', () => {
    const monday = plainDate('2026-10-05');
    const nextMonday = plainDate('2026-10-12');
    expect(businessDaysBetween(monday, nextMonday)).toBe(5);
    expect(businessDaysBetween(nextMonday, monday)).toBe(-5);
    expect(businessDaysBetween(monday, monday)).toBe(0);
    expect(Object.is(businessDaysBetween(plainDate('2026-10-11'), plainDate('2026-10-10')), 0)).toBe(true);
    expect(businessDaysBetween(plainDate('2026-12-21'), plainDate('2027-01-04'), XMAS)).toBe(8);
    expect(businessDaysIn(interval(plainDate('2026-12-21'), plainDate('2027-01-04')), XMAS)).toBe(8);
  });

  it('agrees with addBusinessDays and with a day-by-day count', () => {
    let state = 42;
    const next = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 2 ** 32;
    };
    const base = plainDate('2026-11-01');
    for (let run = 0; run < 100; run++) {
      const from = base.add({ days: Math.floor(next() * 90) });
      const to = from.add({ days: Math.floor(next() * 40) });
      let expected = 0;
      for (let day = from; plainDate(day).until(to).days > 0; day = day.add({ days: 1 })) {
        if (isBusinessDay(day, XMAS)) expected++;
      }
      expect(businessDaysBetween(from, to, XMAS)).toBe(expected);
      expect(businessDaysBetween(to, from, XMAS)).toBe(expected === 0 ? 0 : -expected);
      if (isBusinessDay(from, XMAS) && expected > 0) {
        // Moving n business days from a business day lands on the (n+1)-th business day of the range.
        const landed = addBusinessDays(from, expected - 1, XMAS);
        expect(businessDaysBetween(from, landed.add({ days: 1 }), XMAS)).toBe(expected);
      }
    }
  });
});

describe('zones that skip a calendar day', () => {
  // Samoa jumped from 2011-12-29 straight to 2011-12-31: Friday the 30th never happened.
  it('walks past the missing day in both directions', () => {
    expect(addBusinessDays(zoned('2011-12-29T09:00[Pacific/Apia]'), 1).toString()).toBe(
      '2012-01-02T09:00:00+14:00[Pacific/Apia]',
    );
    expect(addBusinessDays(zoned('2012-01-03T09:00[Pacific/Apia]'), -2).toString()).toBe(
      '2011-12-29T09:00:00-10:00[Pacific/Apia]',
    );
  });
});

function walkDays(start: PlainDate, count: number, calendar: BusinessCalendar): PlainDate {
  let cursor = start;
  for (let left = Math.abs(count); left > 0;) {
    cursor = cursor.add({ days: Math.sign(count) });
    if (isBusinessDay(cursor, calendar)) left--;
  }
  return cursor;
}

describe('week jumps agree with a day-by-day walk', () => {
  const calendars = [
    businessCalendar(),
    businessCalendar({ weekend: [5, 6] }),
    businessCalendar({ weekend: [7] }),
    businessCalendar({ weekend: [1, 2, 3, 4, 5, 6] }),
    businessCalendar({ holidays: ['2026-05-01', '2026-06-01', '2026-06-08'] }),
  ];
  it.each([-61, -14, -1, 0, 1, 5, 13, 30, 61, 200])('for %d business days', count => {
    for (const calendar of calendars) {
      for (let offset = 0; offset < 7; offset++) {
        const start = plainDate('2026-04-27').add({ days: offset });
        expect(addBusinessDays(start, count, calendar).toString()).toBe(walkDays(start, count, calendar).toString());
      }
    }
  });
});
