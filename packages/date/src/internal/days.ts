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
  const ms = Date.UTC(date.year, date.month - 1, date.day);
  if (date.year >= 0 && date.year < 100) {
    const fixed = new Date(ms);
    fixed.setUTCFullYear(date.year);
    return Math.floor(fixed.getTime() / MS_PER_DAY);
  }
  return Math.floor(ms / MS_PER_DAY);
}

/** The ISO calendar date `days` days after 1970-01-01. */
export function fromEpochDay(days: number): PlainDate {
  const d = new Date(days * MS_PER_DAY);
  return Temporal.PlainDate.from({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
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
