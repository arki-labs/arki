import { describe, expect, it } from 'vitest';

import { MockClock } from '@arki/clock';

import type { CalendarUnit, WeekRules } from '../types.js';
import { weekOf } from '../calendar.js';
import { isThisMonth, isThisWeek, isThisYear, isToday, isTomorrow, isYesterday } from '../clock.js';
import { isSame } from '../compare.js';
import { Temporal } from '../types.js';

// isSame, the isToday family and weekOf answer from integer day counts for the
// ISO calendar. These tests rebuild each answer with Temporal objects, the
// way the code worked before, and require the same result.

function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

const ZONES = ['UTC', 'America/New_York', 'Pacific/Apia', 'Australia/Lord_Howe', 'Asia/Kathmandu'];
const UNITS: CalendarUnit[] = ['day', 'week', 'month', 'quarter', 'year'];

function startDate(date: Temporal.PlainDate, unit: CalendarUnit, rules: WeekRules): Temporal.PlainDate {
  if (unit === 'day') return date;
  if (unit === 'week') return date.subtract({ days: (date.dayOfWeek - rules.startsOn + 7) % 7 });
  if (unit === 'month') return date.with({ day: 1 });
  if (unit === 'quarter') return date.with({ month: Math.floor((date.month - 1) / 3) * 3 + 1, day: 1 });
  return date.with({ month: 1, day: 1 });
}

/** The pre-change weekOf, on Temporal objects. */
function referenceWeek(date: Temporal.PlainDate, rules: WeekRules): { week: number; weekYear: number } {
  const first = (year: number): Temporal.PlainDate =>
    startDate(Temporal.PlainDate.from({ year, month: 1, day: rules.minimalDays }), 'week', rules);
  const weekStart = startDate(date, 'week', rules);
  let weekYear = date.year + 1;
  let start = first(weekYear);
  if (Temporal.PlainDate.compare(weekStart, start) < 0) {
    weekYear = date.year;
    start = first(weekYear);
    if (Temporal.PlainDate.compare(weekStart, start) < 0) {
      weekYear = date.year - 1;
      start = first(weekYear);
    }
  }
  return { week: start.until(weekStart, { largestUnit: 'day' }).days / 7 + 1, weekYear };
}

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

describe('integer buckets', () => {
  it('weekOf equals the Temporal computation for every week rule', () => {
    const next = random(3);
    for (let index = 0; index < 3000; index++) {
      const date = Temporal.PlainDate.from('1900-01-01').add({ days: Math.floor(next() * 80_000) });
      const rules: WeekRules = {
        startsOn: WEEKDAYS[index % 7] ?? 1,
        minimalDays: WEEKDAYS[Math.floor(next() * 7)] ?? 1,
      };
      expect([date.toString(), rules, weekOf(date, rules)]).toEqual([
        date.toString(),
        rules,
        referenceWeek(date, rules),
      ]);
    }
  });

  it('isSame equals comparing Temporal boundaries, for zoned values, instants and plain dates', () => {
    const next = random(9);
    for (let index = 0; index < 4000; index++) {
      const zone = ZONES[index % ZONES.length] ?? 'UTC';
      const unit = UNITS[index % UNITS.length] ?? 'day';
      const rules: WeekRules = { startsOn: WEEKDAYS[index % 7] ?? 1, minimalDays: 4 };
      const ms = Math.floor((next() - 0.2) * 4e12);
      const a = new Temporal.ZonedDateTime(BigInt(ms) * 1_000_000n, zone);
      const b = a.add({ hours: Math.floor((next() - 0.5) * 24 * 120) });
      const expected = startDate(a.toPlainDate(), unit, rules).equals(startDate(b.toPlainDate(), unit, rules));
      expect([a.toString(), b.toString(), unit, isSame(a, b, unit, { week: rules })]).toEqual([
        a.toString(),
        b.toString(),
        unit,
        expected,
      ]);
      expect(isSame(a.toInstant(), b.toInstant(), unit, { week: rules, timeZone: zone })).toBe(expected);
      expect(isSame(a.toPlainDate(), b.toPlainDate(), unit, { week: rules })).toBe(expected);
    }
  });

  it('the isToday family equals comparing with Temporal today, at a fixed clock', () => {
    const next = random(21);
    const checks = [
      [isToday, 'day', 0],
      [isTomorrow, 'day', 1],
      [isYesterday, 'day', -1],
      [isThisWeek, 'week', 0],
      [isThisMonth, 'month', 0],
      [isThisYear, 'year', 0],
    ] as const;
    for (let index = 0; index < 2000; index++) {
      const zone = ZONES[index % ZONES.length] ?? 'UTC';
      const nowMs = Math.floor(next() * 4e12);
      const clock = new MockClock(new Date(nowMs));
      const value = new Temporal.ZonedDateTime(BigInt(nowMs + Math.floor((next() - 0.5) * 9e9)) * 1_000_000n, zone);
      const today = Temporal.Instant.fromEpochMilliseconds(nowMs).toZonedDateTimeISO(zone).toPlainDate();
      for (const [check, unit, shift] of checks) {
        const base = startDate(today, unit, { startsOn: 1, minimalDays: 4 });
        const target = shift === 0 ? base : base.add({ [`${unit}s`]: shift });
        const expected = startDate(value.toPlainDate(), unit, { startsOn: 1, minimalDays: 4 }).equals(target);
        expect([value.toString(), unit, shift, check(value, { clock })]).toEqual([
          value.toString(),
          unit,
          shift,
          expected,
        ]);
        expect(check(value.toInstant(), { clock, timeZone: zone })).toBe(expected);
      }
    }
  });
});
