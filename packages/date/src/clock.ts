/**
 * "What time is it?" — answered only through an `@arki/clock` `Clock`, read
 * once per call and copied into an immutable value. There is no package-level
 * test clock; pass a `MockClock` (or use `createDateContext` from `fluent`).
 *
 * `timeZone` defaults to the runtime's zone. On a server that is usually UTC
 * and in a browser it is the user's zone — pass it explicitly whenever the
 * result is rendered on both sides.
 */

import type { Clock } from '@arki/clock';
import { SystemClock } from '@arki/clock';

import type { Civil, Instant, PlainDate, Point, Timeline, WeekRules, ZonedDateTime } from './types.js';
import { instant, plainDate } from './core.js';
import { bucketStart, epochDaysOf, shiftBucket, zonedDays } from './internal/buckets.js';
import { systemTimeZone } from './interop.js';
import { startOf } from './math.js';
import { isInstant, ISO_WEEK, isZonedDateTime, Temporal } from './types.js';

const systemClock: Clock = new SystemClock();

/** Which clock to read. Default: the system clock. */
export type ClockOptions = Readonly<{ clock?: Clock }>;

export type CurrentOptions = ClockOptions &
  Readonly<{
    timeZone?: string;
    week?: WeekRules;
  }>;

/** The current instant. */
export function now(options?: ClockOptions): Instant {
  return instant((options?.clock ?? systemClock).now());
}

/** The current moment in a zone (runtime zone by default). */
export function nowIn(options?: CurrentOptions): ZonedDateTime {
  return now(options).toZonedDateTimeISO(options?.timeZone ?? systemTimeZone());
}

/** Today's calendar date in a zone (runtime zone by default). */
export function today(options?: CurrentOptions): PlainDate {
  return nowIn(options).toPlainDate();
}

/**
 * Project any point into the comparison zone: plain values are taken as-is,
 * zoned values keep their zone unless one is given, instants need a zone.
 */
function civilIn(value: Point, timeZone: string | undefined): Civil {
  if (isInstant(value)) return value.toZonedDateTimeISO(timeZone ?? systemTimeZone());
  if (isZonedDateTime(value) && timeZone) return value.withTimeZone(timeZone);
  return value;
}

type CurrentUnit = 'day' | 'week' | 'month' | 'year';

/** `sameCurrentUnit` on integer day counts; `undefined` for a non-ISO calendar (Temporal then decides). */
function sameCurrentBucket(
  value: Point,
  unit: CurrentUnit,
  offsetUnits: number,
  options: CurrentOptions | undefined,
): boolean | undefined {
  const timeZone = options?.timeZone;
  const zone = isZonedDateTime(value) ? (timeZone ?? value.timeZoneId) : (timeZone ?? systemTimeZone());
  const days = epochDaysOf(value, isInstant(value) ? zone : timeZone);
  if (days === undefined) return undefined;
  const rules = options?.week ?? ISO_WEEK;
  const current = bucketStart(zonedDays(now(options).epochMilliseconds, zone), unit, rules);
  return bucketStart(days, unit, rules) === shiftBucket(current, unit, offsetUnits);
}

function sameCurrentUnit(
  value: Point,
  unit: CurrentUnit,
  offsetUnits: number,
  options: CurrentOptions | undefined,
): boolean {
  const fast = sameCurrentBucket(value, unit, offsetUnits, options);
  if (fast !== undefined) return fast;
  const civil = civilIn(value, options?.timeZone);
  const zone = isZonedDateTime(civil) ? civil.timeZoneId : (options?.timeZone ?? systemTimeZone());
  const target = startOf(plainDate(civil), unit, options);
  const base = startOf(today({ ...options, timeZone: zone }), unit, options);
  const shifted = offsetUnits === 0 ? base : base.add({ [`${unit}s`]: offsetUnits });
  return Temporal.PlainDate.compare(target, shifted) === 0;
}

export function isToday(value: Point, options?: CurrentOptions): boolean {
  return sameCurrentUnit(value, 'day', 0, options);
}
export function isTomorrow(value: Point, options?: CurrentOptions): boolean {
  return sameCurrentUnit(value, 'day', 1, options);
}
export function isYesterday(value: Point, options?: CurrentOptions): boolean {
  return sameCurrentUnit(value, 'day', -1, options);
}
export function isThisWeek(value: Point, options?: CurrentOptions): boolean {
  return sameCurrentUnit(value, 'week', 0, options);
}
export function isThisMonth(value: Point, options?: CurrentOptions): boolean {
  return sameCurrentUnit(value, 'month', 0, options);
}
export function isThisYear(value: Point, options?: CurrentOptions): boolean {
  return sameCurrentUnit(value, 'year', 0, options);
}

/** Strictly before now. */
export function isPast(value: Timeline | Date, options?: ClockOptions): boolean {
  return Temporal.Instant.compare(instant(value), now(options)) < 0;
}

/** Strictly after now. */
export function isFuture(value: Timeline | Date, options?: ClockOptions): boolean {
  return Temporal.Instant.compare(instant(value), now(options)) > 0;
}
