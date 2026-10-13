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
import { epochDay, epochDayKey, weekdayOfEpochDay } from './internal/days.js';
import { sameKind } from './internal/kind.js';
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

/**
 * Walks whole days as epoch-day integers (weekday by arithmetic, holidays by
 * ISO key) and materializes a Temporal value only at the end: a `with` of the
 * final year/month/day keeps a zoned value's wall-clock time exactly as
 * repeated calendar `add`s would.
 */
function walk<T extends Civil>(value: T, count: number, calendar: BusinessCalendar): T {
  if (count === 0) return value;
  const direction = Math.sign(count);
  const hasHolidays = calendar.holidays.size > 0;
  let day = epochDay(plainDate(value));
  let remaining = Math.abs(count);
  if (!hasHolidays) {
    // Every full week holds the same number of business days: jump them, but
    // leave at least one day to walk so the result lands on a business day.
    const perWeek = 7 - calendar.weekend.length;
    const weeks = Math.floor((remaining - 1) / perWeek);
    day += weeks * 7 * direction;
    remaining -= weeks * perWeek;
  }
  for (;;) {
    while (remaining > 0) {
      day += direction;
      const off =
        calendar.weekend.includes(weekdayOfEpochDay(day)) || (hasHolidays && calendar.holidays.has(epochDayKey(day)));
      if (!off) remaining--;
    }
    const target = new Date(day * 86_400_000);
    const landed = sameKind(
      value,
      value.with({ year: target.getUTCFullYear(), month: target.getUTCMonth() + 1, day: target.getUTCDate() }),
    );
    if (epochDay(plainDate(landed)) === day) return landed;
    // A zone can skip a whole calendar day (Samoa, 2011-12-30): the value then
    // resolves onto a neighbouring date, so the counted day was not a business
    // day in this zone. Keep walking past it.
    remaining = 1;
  }
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
