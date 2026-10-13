import { describe, expect, it } from 'vitest';

import type { CalendarUnit, WeekRules } from '../types.js';
import { add, endOf, startOf, sub } from '../math.js';
import { Temporal } from '../types.js';
import { epochDay } from './days.js';
import { addPlainDate, endOfPlainDate, startOfPlainDate } from './plain.js';

// Deterministic generator so failures reproduce.
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function dates(count: number): Temporal.PlainDate[] {
  const next = random(7);
  const out: Temporal.PlainDate[] = [
    Temporal.PlainDate.from('2024-02-29'),
    Temporal.PlainDate.from('2023-01-31'),
    Temporal.PlainDate.from('0000-02-29'),
    Temporal.PlainDate.from('-000400-03-01'),
    Temporal.PlainDate.from('1969-12-31'),
  ];
  for (let index = 0; index < count; index++) {
    const year = Math.floor(next() * 4000) - 1000;
    const month = Math.floor(next() * 12) + 1;
    const day = Math.floor(next() * 31) + 1;
    out.push(Temporal.PlainDate.from({ year, month, day }));
  }
  return out;
}

const UNITS: CalendarUnit[] = ['day', 'week', 'month', 'quarter', 'year'];
const RULES: WeekRules[] = [
  { startsOn: 1, minimalDays: 4 },
  { startsOn: 7, minimalDays: 1 },
  { startsOn: 6, minimalDays: 1 },
];

describe('plain-date fast paths match Temporal', () => {
  const sample = dates(1000);

  it('epochDay counts days the way PlainDate#until does', () => {
    const epoch = Temporal.PlainDate.from('1970-01-01');
    for (const date of sample) expect(epochDay(date)).toBe(epoch.until(date, { largestUnit: 'day' }).days);
  });

  it('startOf and endOf agree with calendar reasoning for every unit and week rule', () => {
    for (const date of sample) {
      for (const unit of UNITS) {
        for (const rules of RULES) {
          const start = startOfPlainDate(date, unit, rules);
          const end = endOfPlainDate(date, unit, rules);
          expect(start).toBeDefined();
          expect(end).toBeDefined();
          if (start === undefined || end === undefined) continue;
          // The bucket holds the date and runs to the day before the next bucket.
          expect(Temporal.PlainDate.compare(start, date)).toBeLessThanOrEqual(0);
          expect(Temporal.PlainDate.compare(date, end)).toBeLessThanOrEqual(0);
          if (unit === 'day') expect(start.equals(date) && end.equals(date)).toBe(true);
          if (unit === 'week') {
            expect(start.dayOfWeek).toBe(rules.startsOn);
            expect(start.until(end).days).toBe(6);
          }
          if (unit === 'month') {
            expect(start.equals(date.with({ day: 1 }))).toBe(true);
            expect(end.equals(date.with({ day: date.daysInMonth }))).toBe(true);
          }
          if (unit === 'quarter') {
            const firstMonth = Math.floor((date.month - 1) / 3) * 3 + 1;
            expect(start.equals(date.with({ month: firstMonth, day: 1 }))).toBe(true);
            expect(end.equals(start.add({ months: 3 }).subtract({ days: 1 }))).toBe(true);
          }
          if (unit === 'year') {
            expect(start.equals(date.with({ month: 1, day: 1 }))).toBe(true);
            expect(end.equals(date.with({ month: 12, day: 31 }))).toBe(true);
          }
        }
      }
    }
  });

  it('add matches PlainDate#add for one-signed calendar amounts, with both overflow modes', () => {
    const next = random(11);
    for (const date of sample) {
      const sign = next() < 0.5 ? -1 : 1;
      const amount = {
        years: sign * Math.floor(next() * 3),
        months: sign * Math.floor(next() * 30),
        weeks: sign * Math.floor(next() * 5),
        days: sign * Math.floor(next() * 400),
      };
      expect(addPlainDate(date, amount)?.toString()).toBe(date.add(amount).toString());
      let expected: string | undefined;
      try {
        expected = date.add(amount, { overflow: 'reject' }).toString();
      } catch {
        expected = undefined;
      }
      // `undefined` from the fast path means "ask Temporal", which then throws.
      expect(addPlainDate(date, amount, 'reject')?.toString()).toBe(expected);
    }
  });

  it('declines what it does not handle, so Temporal keeps its errors and other calendars', () => {
    const date = Temporal.PlainDate.from('2024-01-31');
    expect(addPlainDate(date, { months: 1, days: -1 })).toBeUndefined();
    expect(addPlainDate(date, { hours: 1 })).toBeUndefined();
    expect(addPlainDate(date, { days: 1.5 })).toBeUndefined();
    expect(addPlainDate(date.withCalendar('gregory'), { days: 1 })).toBeUndefined();
    expect(addPlainDate(date, { days: 200_000_000 })).toBeUndefined();
    expect(() => add(date, { days: 200_000_000 })).toThrow(RangeError);
    expect(() => add(date, { months: 1, days: -1 })).toThrow(RangeError);
    expect(() => add(date, { months: 1 }, { overflow: 'reject' })).toThrow(RangeError);
  });

  it('public add, sub, startOf and endOf return the fast results', () => {
    const date = Temporal.PlainDate.from('2024-01-31');
    expect(add(date, { months: 1 }).toString()).toBe('2024-02-29');
    expect(sub(date, { months: 1, days: 1 }).toString()).toBe('2023-12-30');
    expect(startOf(date, 'quarter').toString()).toBe('2024-01-01');
    expect(endOf(date, 'month').toString()).toBe('2024-01-31');
    expect(endOf(Temporal.PlainDate.from('2024-02-10'), 'month').toString()).toBe('2024-02-29');
  });
});
