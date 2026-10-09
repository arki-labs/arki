/**
 * Shared vocabulary for `@arki/date`.
 *
 * Value types are Temporal's own (via the `temporal-polyfill` ponyfill, which
 * hands back the native `Temporal` object where the runtime ships one). This
 * package adds no parallel date classes — only functions, one `Interval`
 * record shape, and the type aliases below that name the policies every
 * module shares.
 */

import { Temporal } from 'temporal-polyfill';

/** A calendar date with no time and no zone: a birthday, a due date, a holiday. */
export type PlainDate = Temporal.PlainDate;
/** A wall-clock date + time with no zone: "the meeting is at 09:00 local". */
export type PlainDateTime = Temporal.PlainDateTime;
/** An exact moment projected into an IANA time zone — the everyday scheduling type. */
export type ZonedDateTime = Temporal.ZonedDateTime;
/** An exact moment on the timeline, zone-less: timestamps, logs, `timestamptz`. */
export type Instant = Temporal.Instant;
/** A signed amount of time with separate calendar (years…days) and exact (hours…ns) fields. */
export type Duration = Temporal.Duration;

/** Any point-in-time value this package operates on. */
export type Point = PlainDate | PlainDateTime | ZonedDateTime | Instant;
/** Points that carry calendar fields (year, month, day). */
export type Civil = PlainDate | PlainDateTime | ZonedDateTime;
/** Points that carry a wall-clock time of day. */
export type Wall = PlainDateTime | ZonedDateTime;
/** Points that identify an exact instant. */
export type Timeline = Instant | ZonedDateTime;

export type PointKind = 'plainDate' | 'plainDateTime' | 'zonedDateTime' | 'instant';

export type TimeUnit = 'hour' | 'minute' | 'second' | 'millisecond' | 'microsecond' | 'nanosecond';
export type CalendarUnit = 'year' | 'quarter' | 'month' | 'week' | 'day';
export type Unit = CalendarUnit | TimeUnit;
/** Units a `Duration` can carry (Temporal has no quarter field; quarters expand to 3 months). */
export type DurationUnit = Exclude<Unit, 'quarter'>;

/** The units that make sense for a given point type. */
export type UnitFor<T extends Point> = T extends PlainDate ? CalendarUnit : T extends Instant ? TimeUnit : Unit;

/** ISO weekday: Monday = 1 … Sunday = 7 (same numbering as `Temporal.PlainDate#dayOfWeek`). */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * How weeks are counted. `startsOn` is the first day of the week; `minimalDays`
 * is how many days of January must fall in week 1 (ISO: Monday, 4).
 */
export type WeekRules = Readonly<{
  startsOn: Weekday;
  minimalDays: 1 | 2 | 3 | 4 | 5 | 6 | 7;
}>;

/** ISO 8601 weeks: Monday start, week 1 contains January 4. The package default. */
export const ISO_WEEK: WeekRules = Object.freeze({ startsOn: 1, minimalDays: 4 });
/** North-American convention: Sunday start, week 1 contains January 1. */
export const SUNDAY_WEEK: WeekRules = Object.freeze({ startsOn: 7, minimalDays: 1 });

export type DateParts = Readonly<{ year: number; month: number; day: number }>;
export type TimeParts = Readonly<{
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  microsecond: number;
  nanosecond: number;
}>;
export type WallParts = DateParts & TimeParts;
/** Date fields plus any subset of time fields (missing time fields are zero). */
export type WallInput = DateParts & Partial<TimeParts>;

export type CalendarAmount = Readonly<{
  years?: number;
  quarters?: number;
  months?: number;
  weeks?: number;
  days?: number;
}>;
export type TimeAmount = Readonly<{
  hours?: number;
  minutes?: number;
  seconds?: number;
  milliseconds?: number;
  microseconds?: number;
  nanoseconds?: number;
}>;
export type Amount = CalendarAmount & TimeAmount;

/** The amounts that can be added to a given point type. */
export type AmountFor<T extends Point> = T extends PlainDate ? CalendarAmount : T extends Instant ? TimeAmount : Amount;

/** What to do when a field is out of range: clamp (Jan 31 + 1 month = Feb 28) or throw. */
export type Overflow = 'constrain' | 'reject';
/** What to do when a wall-clock time is skipped or repeated by a DST transition. */
export type Disambiguation = 'compatible' | 'earlier' | 'later' | 'reject';
export type RoundingMode = 'trunc' | 'floor' | 'ceil' | 'halfExpand';
export type Ordering = -1 | 0 | 1;
/** Interval bounds notation: `[` / `]` inclusive, `(` / `)` exclusive. */
export type Bounds = '[)' | '[]' | '()' | '(]';

export function isPlainDate(value: unknown): value is PlainDate {
  return value instanceof Temporal.PlainDate;
}
export function isPlainDateTime(value: unknown): value is PlainDateTime {
  return value instanceof Temporal.PlainDateTime;
}
export function isZonedDateTime(value: unknown): value is ZonedDateTime {
  return value instanceof Temporal.ZonedDateTime;
}
export function isInstant(value: unknown): value is Instant {
  return value instanceof Temporal.Instant;
}
export function isDuration(value: unknown): value is Duration {
  return value instanceof Temporal.Duration;
}
export function isPoint(value: unknown): value is Point {
  return isPlainDate(value) || isPlainDateTime(value) || isZonedDateTime(value) || isInstant(value);
}

export function kindOf(value: Point): PointKind {
  if (isPlainDate(value)) return 'plainDate';
  if (isPlainDateTime(value)) return 'plainDateTime';
  if (isZonedDateTime(value)) return 'zonedDateTime';
  return 'instant';
}

export { Temporal } from 'temporal-polyfill';
