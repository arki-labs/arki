import type { CalendarUnit, Overflow, Point, Unit } from '../types.js';
import type { DurationInput } from './amount.js';
import { isInstant, isPlainDate, isPlainDateTime, isZonedDateTime, Temporal } from '../types.js';

/** Temporal ordering of two same-kind points (zoned values compare by instant). */
export function comparePoints(a: Point, b: Point): number {
  if (isPlainDate(a) && isPlainDate(b)) return Temporal.PlainDate.compare(a, b);
  if (isPlainDateTime(a) && isPlainDateTime(b)) return Temporal.PlainDateTime.compare(a, b);
  if (isZonedDateTime(a) && isZonedDateTime(b)) return Temporal.ZonedDateTime.compare(a, b);
  if (isInstant(a) && isInstant(b)) return Temporal.Instant.compare(a, b);
  throw new TypeError('compare needs two values of the same kind');
}

/** `value + amount` for any point; Temporal rejects calendar fields on an Instant. */
export function addPoint(value: Point, amount: DurationInput, options?: Readonly<{ overflow?: Overflow }>): Point {
  if (isInstant(value)) return value.add(amount);
  return value.add(amount, options);
}

export function isCalendarUnit(unit: Unit): unit is CalendarUnit {
  return unit === 'year' || unit === 'quarter' || unit === 'month' || unit === 'week' || unit === 'day';
}
