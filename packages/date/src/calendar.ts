/**
 * Calendar facts: weekdays, week numbers, quarters, leap years, age.
 * Only the ISO 8601 (proleptic Gregorian) calendar is supported.
 */

import type { Civil, PlainDate, Weekday, WeekRules } from './types.js';
import { plainDate } from './core.js';
import { epochDaysOf, weekOfDays } from './internal/buckets.js';
import { daysBetween } from './internal/days.js';
import { startOfWeekDate } from './internal/week.js';
import { ISO_WEEK, Temporal } from './types.js';

const JDN_2000_01_01 = 2_451_545;

function isWeekdayNumber(n: number): n is Weekday {
  return n === 1 || n === 2 || n === 3 || n === 4 || n === 5 || n === 6 || n === 7;
}

/** ISO weekday, Monday = 1 … Sunday = 7. */
export function dayOfWeek(value: Civil): Weekday {
  const day = value.dayOfWeek;
  if (!isWeekdayNumber(day)) throw new RangeError('dayOfWeek is only defined for the ISO calendar');
  return day;
}

export function dayOfYear(value: Civil): number {
  return value.dayOfYear;
}

export function daysInMonth(value: Civil): number {
  return value.daysInMonth;
}

export function daysInYear(value: Civil): number {
  return value.daysInYear;
}

/** Gregorian leap-year rule, for a value or a bare year number. */
export function isLeapYear(value: Civil | number): boolean {
  if (typeof value === 'number') return Temporal.PlainDate.from({ year: value, month: 1, day: 1 }).inLeapYear;
  return value.inLeapYear;
}

export const DEFAULT_WEEKEND: readonly Weekday[] = Object.freeze([6, 7]);

export function isWeekend(value: Civil, weekend: readonly Weekday[] = DEFAULT_WEEKEND): boolean {
  return weekend.includes(dayOfWeek(value));
}

export function isWeekday(value: Civil, weekend: readonly Weekday[] = DEFAULT_WEEKEND): boolean {
  return !isWeekend(value, weekend);
}

export type WeekInfo = Readonly<{ week: number; weekYear: number }>;

function week1Start(year: number, rules: WeekRules): PlainDate {
  return startOfWeekDate(Temporal.PlainDate.from({ year, month: 1, day: rules.minimalDays }), rules);
}

/**
 * Week number and the year that week belongs to, under the given rules
 * (ISO by default). Returned together because the week-year differs from the
 * calendar year around New Year.
 */
export function weekOf(value: Civil, rules: WeekRules = ISO_WEEK): WeekInfo {
  const days = epochDaysOf(value);
  if (days !== undefined) return weekOfDays(days, rules);
  const date = plainDate(value);
  const weekStart = startOfWeekDate(date, rules);
  let weekYear = date.year + 1;
  let first = week1Start(weekYear, rules);
  if (Temporal.PlainDate.compare(weekStart, first) < 0) {
    weekYear = date.year;
    first = week1Start(weekYear, rules);
    if (Temporal.PlainDate.compare(weekStart, first) < 0) {
      weekYear = date.year - 1;
      first = week1Start(weekYear, rules);
    }
  }
  return { week: daysBetween(first, weekStart) / 7 + 1, weekYear };
}

/** ISO 8601 week and week-year. */
export function isoWeek(value: Civil): WeekInfo {
  return weekOf(value, ISO_WEEK);
}

/** 52 or 53. */
export function weeksInYear(year: number, rules: WeekRules = ISO_WEEK): number {
  return daysBetween(week1Start(year, rules), week1Start(year + 1, rules)) / 7;
}

export function quarter(value: Civil): 1 | 2 | 3 | 4 {
  const q = Math.floor((value.month - 1) / 3) + 1;
  if (q === 1 || q === 2 || q === 3 || q === 4) return q;
  throw new RangeError(`quarter: month ${String(value.month)} is outside the ISO calendar`);
}

/** Whole calendar days from `from` to `to` (negative when reversed). Counts date boundaries, not elapsed hours. */
export function calendarDaysBetween(from: PlainDate, to: PlainDate): number {
  return daysBetween(from, to);
}

export type AgeOptions = Readonly<{
  /** When a Feb 29 birthday is celebrated in common years. Default `feb28`. */
  leapDay?: 'feb28' | 'mar1';
}>;

/** Completed years between a birth date and `asOf`. Throws if `asOf` is before the birth date. */
export function age(birthDate: PlainDate, asOf: PlainDate, options?: AgeOptions): number {
  if (Temporal.PlainDate.compare(asOf, birthDate) < 0) throw new RangeError('age: asOf is before the birth date');
  let years = asOf.year - birthDate.year;
  let birthday = birthDate.with({ year: asOf.year }, { overflow: 'constrain' });
  if (options?.leapDay === 'mar1' && birthDate.month === 2 && birthDate.day === 29 && !birthday.inLeapYear) {
    birthday = birthday.add({ days: 1 });
  }
  if (Temporal.PlainDate.compare(asOf, birthday) < 0) years -= 1;
  return years;
}

function assertMonth(year: number, month: number, operation: string): void {
  if (!Number.isInteger(year)) throw new RangeError(`${operation}: year must be an integer, received ${String(year)}`);
  if (!Number.isInteger(month) || month < 1 || month > 12)
    throw new RangeError(`${operation}: month must be 1–12, received ${String(month)}`);
}

/**
 * The n-th `weekday` of a month: `nthWeekdayOfMonth(2026, 5, 2, 5)` is the
 * second Friday of May 2026. Negative `n` counts from the end (`-1` = last).
 * A `RangeError` when the month has no such day (a fifth Monday, say).
 */
export function nthWeekdayOfMonth(year: number, month: number, n: number, weekday: Weekday): PlainDate {
  assertMonth(year, month, 'nthWeekdayOfMonth');
  if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 5)
    throw new RangeError(`nthWeekdayOfMonth: n must be 1–5 or -1…-5, received ${String(n)}`);
  if (!isWeekdayNumber(weekday)) throw new RangeError(`nthWeekdayOfMonth: ${String(weekday)} is not an ISO weekday`);
  const first = Temporal.PlainDate.from({ year, month, day: 1 });
  const last = first.with({ day: first.daysInMonth });
  const anchor = n > 0 ? first : last;
  const forward = n > 0 ? (weekday - anchor.dayOfWeek + 7) % 7 : -((anchor.dayOfWeek - weekday + 7) % 7);
  const result = anchor.add({ days: forward + (Math.abs(n) - 1) * 7 * Math.sign(n) });
  if (result.month !== month || result.year !== year) {
    throw new RangeError(
      `nthWeekdayOfMonth: ${year}-${String(month).padStart(2, '0')} has no weekday ${weekday} number ${n}`,
    );
  }
  return result;
}

/** The last `weekday` of a month: `nthWeekdayOfMonth(year, month, -1, weekday)`. */
export function lastWeekdayOfMonth(year: number, month: number, weekday: Weekday): PlainDate {
  return nthWeekdayOfMonth(year, month, -1, weekday);
}

/** `'western'` (Gregorian computus) or `'orthodox'` (Julian computus, shown on the ISO calendar). */
export type EasterRite = 'western' | 'orthodox';

/** Julian Day Number of a date on the Julian calendar (integer division truncates toward zero). */
function julianDayNumber(year: number, month: number, day: number): number {
  return (
    367 * year -
    Math.trunc((7 * (year + 5001 + Math.trunc((month - 9) / 7))) / 4) +
    Math.trunc((275 * month) / 9) +
    day +
    1_729_777
  );
}

/**
 * Easter Sunday of a year. `'western'` is the Gregorian computus (Meeus/
 * Jones/Butcher); `'orthodox'` is the Julian computus (Meeus) converted to the
 * ISO calendar, so both results are dates you can compare and add to directly.
 * Movable feasts are offsets: Good Friday is `-2` days, Pentecost `+49`.
 */
export function easter(year: number, rite: EasterRite = 'western'): PlainDate {
  if (!Number.isInteger(year) || year < 1583)
    throw new RangeError(`easter: year must be an integer ≥ 1583, received ${String(year)}`);
  if (rite === 'orthodox') {
    const a = year % 4;
    const b = year % 7;
    const c = year % 19;
    const d = (19 * c + 15) % 30;
    const e = (2 * a + 4 * b - d + 34) % 7;
    const month = Math.trunc((d + e + 114) / 31);
    const day = ((d + e + 114) % 31) + 1;
    return Temporal.PlainDate.from('2000-01-01').add({ days: julianDayNumber(year, month, day) - JDN_2000_01_01 });
  }
  const a = year % 19;
  const b = Math.trunc(year / 100);
  const c = year % 100;
  const d = Math.trunc(b / 4);
  const e = b % 4;
  const f = Math.trunc((b + 8) / 25);
  const g = Math.trunc((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.trunc(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.trunc((a + 11 * h + 22 * l) / 451);
  const month = Math.trunc((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return Temporal.PlainDate.from({ year, month, day });
}

function isMinimalDays(n: number): n is WeekRules['minimalDays'] {
  return isWeekdayNumber(n);
}

/**
 * The week rules a locale uses, from `Intl.Locale` week info (`en-US` →
 * Sunday start, week 1 holds January 1; `de-DE` → ISO). Runtimes without week
 * info (Node ≤ 22, Hermes) get `fallback`, ISO weeks by default.
 */
export function weekRulesFor(locale: string, fallback: WeekRules = ISO_WEEK): WeekRules {
  const tag = new Intl.Locale(locale);
  // `getWeekInfo()` is the standard method; JavaScriptCore shipped it first as a `weekInfo` accessor.
  const info: unknown = typeof tag.getWeekInfo === 'function' ? tag.getWeekInfo() : Reflect.get(tag, 'weekInfo');
  if (typeof info !== 'object' || info === null) return fallback;
  const firstDay = Reflect.get(info, 'firstDay');
  if (typeof firstDay !== 'number' || !isWeekdayNumber(firstDay)) return fallback;
  // JavaScriptCore omits `minimalDays`; CLDR pairs a Monday start with 4 and other starts with 1.
  const reported = Reflect.get(info, 'minimalDays');
  const minimalDays = typeof reported === 'number' && isMinimalDays(reported) ? reported : firstDay === 1 ? 4 : 1;
  return Object.freeze({ startsOn: firstDay, minimalDays });
}
