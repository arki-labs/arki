/**
 * Business-day arithmetic: weekends and holidays.
 *
 * Policies (one for the whole package):
 * - A business day is a date that is neither a weekend day nor a holiday of
 *   the `BusinessCalendar` (default: Saturday + Sunday off, no holidays).
 * - Zoned values are judged by their date in their own zone, and moving them
 *   is a calendar move (`{ days: 1 }`), so the wall-clock time is kept.
 * - Counting is half-open: `businessDaysBetween(from, to)` counts `[from, to)`.
 */

import type { Interval } from './interval.js';
import type { Civil, PlainDate, Weekday } from './types.js';
import { dayOfWeek } from './calendar.js';
import { plainDate } from './core.js';
import { add } from './math.js';
import { Temporal } from './types.js';

/**
 * Which weekdays are off and which dates are holidays. `holidays` holds ISO
 * `YYYY-MM-DD` strings. The record and its `weekend` list are frozen; build a
 * new calendar with `businessCalendar()` rather than changing one.
 */
export type BusinessCalendar = Readonly<{ weekend: readonly Weekday[]; holidays: ReadonlySet<string> }>;

export type BusinessCalendarOptions = Readonly<{
  /** ISO weekdays that are off (Monday = 1 … Sunday = 7). Default `[6, 7]`. */
  weekend?: readonly Weekday[];
  /** Days off, as `PlainDate`s or `YYYY-MM-DD` strings. */
  holidays?: Iterable<PlainDate | string>;
}>;

function isWeekdayNumber(value: number): value is Weekday {
  return Number.isInteger(value) && value >= 1 && value <= 7;
}

function dateKey(value: Civil): string {
  return plainDate(value).withCalendar('iso8601').toString();
}

/**
 * A validated business calendar. Weekend days are deduplicated and sorted; a
 * weekend of all seven days is a `RangeError` (no day could ever be a business
 * day). Holiday strings must be `YYYY-MM-DD` (validated with `plainDate()`).
 */
export function businessCalendar(options?: BusinessCalendarOptions): BusinessCalendar {
  const requested: readonly Weekday[] = options?.weekend ?? [6, 7];
  const weekend = [...new Set(requested)].toSorted((a, b) => a - b);
  for (const day of weekend) {
    if (!isWeekdayNumber(day)) throw new RangeError(`businessCalendar: ${String(day)} is not an ISO weekday (1–7)`);
  }
  if (weekend.length === 7)
    throw new RangeError('businessCalendar: a weekend of all seven days leaves no business days');
  const holidays = new Set<string>();
  for (const holiday of options?.holidays ?? []) holidays.add(dateKey(plainDate(holiday)));
  return Object.freeze({ weekend: Object.freeze(weekend), holidays });
}

/** Saturday and Sunday off, no holidays. */
export const DEFAULT_BUSINESS_CALENDAR: BusinessCalendar = businessCalendar();

/** Is the value's date neither a weekend day nor a holiday? */
export function isBusinessDay(value: Civil, calendar: BusinessCalendar = DEFAULT_BUSINESS_CALENDAR): boolean {
  return !calendar.weekend.includes(dayOfWeek(value)) && !calendar.holidays.has(dateKey(value));
}

function assertCount(count: number, operation: string): void {
  if (!Number.isSafeInteger(count))
    throw new RangeError(`${operation}: count must be a safe integer, received ${String(count)}`);
}

function walk<T extends Civil>(value: T, count: number, calendar: BusinessCalendar): T {
  const step = Temporal.Duration.from({ days: Math.sign(count) });
  let cursor = value;
  for (let remaining = Math.abs(count); remaining > 0;) {
    cursor = add(cursor, step);
    if (isBusinessDay(cursor, calendar)) remaining--;
  }
  return cursor;
}

/**
 * Move `count` business days forward (negative: backward). The start day is
 * not counted, so Friday + 1 is Monday; `count` 0 returns `value` unchanged.
 * Zoned values keep their wall-clock time. `count` must be a safe integer.
 */
export function addBusinessDays<T extends Civil>(
  value: T,
  count: number,
  calendar: BusinessCalendar = DEFAULT_BUSINESS_CALENDAR,
): T {
  assertCount(count, 'addBusinessDays');
  return walk(value, count, calendar);
}

/** Move `count` business days backward: `addBusinessDays(value, -count)`. */
export function subBusinessDays<T extends Civil>(
  value: T,
  count: number,
  calendar: BusinessCalendar = DEFAULT_BUSINESS_CALENDAR,
): T {
  assertCount(count, 'subBusinessDays');
  return walk(value, -count, calendar);
}

/** The first business day strictly after `value` (same wall-clock time for zoned values). */
export function nextBusinessDay<T extends Civil>(value: T, calendar: BusinessCalendar = DEFAULT_BUSINESS_CALENDAR): T {
  return walk(value, 1, calendar);
}

/** The last business day strictly before `value` (same wall-clock time for zoned values). */
export function previousBusinessDay<T extends Civil>(
  value: T,
  calendar: BusinessCalendar = DEFAULT_BUSINESS_CALENDAR,
): T {
  return walk(value, -1, calendar);
}

/** Business days in `[from, to)` for `from ≤ to`, counted with whole weeks plus a short remainder. */
function countForward(from: PlainDate, to: PlainDate, calendar: BusinessCalendar): number {
  const days = from.until(to, { largestUnit: 'day' }).days;
  const fullWeeks = Math.floor(days / 7);
  let count = fullWeeks * (7 - calendar.weekend.length);
  for (let cursor = from.add({ days: fullWeeks * 7 }); Temporal.PlainDate.compare(cursor, to) < 0;) {
    if (!calendar.weekend.includes(dayOfWeek(cursor))) count++;
    cursor = cursor.add({ days: 1 });
  }
  for (const key of calendar.holidays) {
    const holiday = Temporal.PlainDate.from(key);
    const inside = Temporal.PlainDate.compare(from, holiday) <= 0 && Temporal.PlainDate.compare(holiday, to) < 0;
    if (inside && !calendar.weekend.includes(dayOfWeek(holiday))) count--;
  }
  return count;
}

/**
 * Business days in `[from, to)`. Reversed arguments give the negated count:
 * `businessDaysBetween(a, b) === -businessDaysBetween(b, a)`.
 */
export function businessDaysBetween(
  from: PlainDate,
  to: PlainDate,
  calendar: BusinessCalendar = DEFAULT_BUSINESS_CALENDAR,
): number {
  if (Temporal.PlainDate.compare(from, to) <= 0) return countForward(from, to, calendar);
  const count = countForward(to, from, calendar);
  return count === 0 ? 0 : -count;
}

/** Business days inside a `PlainDate` interval (its end is exclusive). */
export function businessDaysIn(i: Interval<PlainDate>, calendar: BusinessCalendar = DEFAULT_BUSINESS_CALENDAR): number {
  return businessDaysBetween(i.start, i.end, calendar);
}
