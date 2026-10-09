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
import { systemTimeZone } from './interop.js';
import { startOf } from './math.js';
import { isInstant, isZonedDateTime, Temporal } from './types.js';

const systemClock: Clock = new SystemClock();

/** The current instant. */
export function now(clock: Clock = systemClock): Instant {
  return instant(clock.now());
}

/** The current moment in a zone (runtime zone by default). */
export function nowIn(timeZone: string = systemTimeZone(), clock: Clock = systemClock): ZonedDateTime {
  return now(clock).toZonedDateTimeISO(timeZone);
}

export type CurrentOptions = Readonly<{
  timeZone?: string;
  clock?: Clock;
  week?: WeekRules;
}>;

/** Today's calendar date in a zone (runtime zone by default). */
export function today(options?: CurrentOptions): PlainDate {
  return nowIn(options?.timeZone, options?.clock).toPlainDate();
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

function sameCurrentUnit(
  value: Point,
  unit: CurrentUnit,
  offsetUnits: number,
  options: CurrentOptions | undefined,
): boolean {
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
export function isPast(value: Timeline | Date, clock: Clock = systemClock): boolean {
  return Temporal.Instant.compare(instant(value), now(clock)) < 0;
}

/** Strictly after now. */
export function isFuture(value: Timeline | Date, clock: Clock = systemClock): boolean {
  return Temporal.Instant.compare(instant(value), now(clock)) > 0;
}
