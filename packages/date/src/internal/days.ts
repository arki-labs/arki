import type { PlainDate, Weekday } from '../types.js';
import { Temporal } from '../types.js';

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const satisfies readonly Weekday[];

const MS_PER_DAY = 86_400_000;

/**
 * Days since 1970-01-01 for an ISO calendar date, via `Date.UTC` — pure
 * integer arithmetic with no zone, and far cheaper than `PlainDate#until`
 * on the polyfill. Valid across Temporal's whole date range (which matches
 * `Date`'s ±271,821 years).
 */
export function epochDay(date: PlainDate): number {
  // setUTCFullYear(y, m, d) sets all three at once, so years 0–99 are not
  // remapped to 19xx the way `Date.UTC(y, …)` does (which turned 0000-02-29 into March 1).
  const d = new Date(0);
  d.setUTCFullYear(date.year, date.month - 1, date.day);
  const ms = d.getTime();
  if (Number.isNaN(ms)) return Temporal.PlainDate.from('1970-01-01').until(date, { largestUnit: 'day' }).days;
  return Math.floor(ms / MS_PER_DAY);
}

/** The `YYYY-MM-DD` key of an epoch day — identical to `PlainDate#toString()`, including extended years. */
export function epochDayKey(days: number): string {
  const iso = new Date(days * MS_PER_DAY).toISOString();
  return iso.slice(0, iso.indexOf('T'));
}

/** Whole days from `from` to `to`, negative when reversed. */
export function daysBetween(from: PlainDate, to: PlainDate): number {
  return epochDay(to) - epochDay(from);
}

/** ISO weekday (Monday = 1 … Sunday = 7) of an epoch day; 1970-01-01 was a Thursday. */
export function weekdayOfEpochDay(days: number): Weekday {
  const weekday = WEEKDAYS[(((days + 3) % 7) + 7) % 7];
  if (weekday === undefined) throw new RangeError(`weekdayOfEpochDay: ${String(days)} is not an integer`);
  return weekday;
}
