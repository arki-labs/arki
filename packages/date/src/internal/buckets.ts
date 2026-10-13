/**
 * Calendar buckets (day, week, month, quarter, year) on integer day counts.
 *
 * Comparing buckets through Temporal builds a PlainDate and a boundary per
 * value; these helpers read one day count per value instead. They cover the
 * ISO calendar; `epochDaysOf` returns `undefined` for anything else, and the
 * caller then uses Temporal.
 */

import type { CalendarUnit, Point, WeekRules } from '../types.js';
import { isInstant, isZonedDateTime } from '../types.js';
import { civilFromDays, daysFromCivil, MS_PER_DAY, weekdayOfDays } from './civil.js';
import { offsetAt } from './offsets.js';

/** The day count of an exact moment's date in `zone`. */
export function zonedDays(epochMs: number, zone: string): number {
  return Math.floor((epochMs + offsetAt(zone, epochMs)) / MS_PER_DAY);
}

/**
 * The day count of a point's date: an instant in `timeZone`, a zoned value in
 * `timeZone` or its own zone, a plain value as it is. `undefined` for an
 * instant without a zone or a non-ISO calendar.
 */
export function epochDaysOf(value: Point, timeZone?: string): number | undefined {
  if (isInstant(value)) return timeZone === undefined ? undefined : zonedDays(value.epochMilliseconds, timeZone);
  if (value.calendarId !== 'iso8601') return undefined;
  if (isZonedDateTime(value)) return zonedDays(value.epochMilliseconds, timeZone ?? value.timeZoneId);
  return daysFromCivil(value.year, value.month, value.day);
}

function weekStart(days: number, rules: WeekRules): number {
  return days - ((weekdayOfDays(days) - rules.startsOn + 7) % 7);
}

/** The first day of the bucket holding `days`. */
export function bucketStart(days: number, unit: CalendarUnit, rules: WeekRules): number {
  switch (unit) {
    case 'day': {
      return days;
    }
    case 'week': {
      return weekStart(days, rules);
    }
    default: {
      const { year, month } = civilFromDays(days);
      if (unit === 'month') return daysFromCivil(year, month, 1);
      if (unit === 'quarter') return daysFromCivil(year, Math.floor((month - 1) / 3) * 3 + 1, 1);
      return daysFromCivil(year, 1, 1);
    }
  }
}

/** The first day of the bucket `count` buckets after the one starting on `start`. */
export function shiftBucket(start: number, unit: CalendarUnit, count: number): number {
  if (count === 0) return start;
  if (unit === 'day') return start + count;
  if (unit === 'week') return start + count * 7;
  const { year, month } = civilFromDays(start);
  const months = unit === 'year' ? count * 12 : unit === 'quarter' ? count * 3 : count;
  const total = year * 12 + month - 1 + months;
  const shiftedYear = Math.floor(total / 12);
  return daysFromCivil(shiftedYear, total - shiftedYear * 12 + 1, 1);
}

/** Week number and week-year of a day count under `rules` (ISO: Monday start, 4 minimal days). */
export function weekOfDays(days: number, rules: WeekRules): { week: number; weekYear: number } {
  const start = weekStart(days, rules);
  const year = civilFromDays(days).year;
  const firstWeek = (weekYear: number): number => weekStart(daysFromCivil(weekYear, 1, rules.minimalDays), rules);
  let weekYear = year + 1;
  let first = firstWeek(weekYear);
  if (start < first) {
    weekYear = year;
    first = firstWeek(weekYear);
    if (start < first) {
      weekYear = year - 1;
      first = firstWeek(weekYear);
    }
  }
  return { week: (start - first) / 7 + 1, weekYear };
}
