/**
 * Equality, ordering and predicates. Two values must be of the same kind;
 * mixing a `PlainDate` with a `ZonedDateTime` is a type error and a runtime
 * `TypeError`. Ordering of zoned values compares instants; equality also
 * compares the zone.
 */

import type { Bounds, CalendarUnit, Civil, Ordering, PlainDate, Point, Timeline, Unit, WeekRules } from './types.js';
import { instant } from './core.js';
import { assertSameKind } from './internal/kind.js';
import { internal, startOf } from './math.js';
import { isInstant, isPlainDate, isPlainDateTime, isZonedDateTime } from './types.js';

function equalsPoint(a: Point, b: Point): boolean {
  assertSameKind(a, b, 'equals');
  if (isPlainDate(a) && isPlainDate(b)) return a.equals(b);
  if (isPlainDateTime(a) && isPlainDateTime(b)) return a.equals(b);
  if (isZonedDateTime(a) && isZonedDateTime(b)) return a.equals(b);
  if (isInstant(a) && isInstant(b)) return a.equals(b);
  return false;
}

/** Field-for-field equality (for zoned values: same instant *and* same zone). */
export function equals<T extends Point>(a: T, b: NoInfer<T>): boolean {
  return equalsPoint(a, b);
}

/** Do two timeline values point at the same instant, whatever their zones? */
export function sameInstant(a: Timeline | Date, b: Timeline | Date): boolean {
  return instant(a).equals(instant(b));
}

function sign(n: number): Ordering {
  return n < 0 ? -1 : n > 0 ? 1 : 0;
}

/** `-1` when `a` is earlier, `1` when later, `0` when equal. Usable directly as an `Array#sort` comparator. */
export function compareAsc<T extends Point>(a: T, b: NoInfer<T>): Ordering {
  return sign(internal.comparePoints(a, b));
}

export function compareDesc<T extends Point>(a: T, b: NoInfer<T>): Ordering {
  return sign(internal.comparePoints(b, a));
}

export function isBefore<T extends Point>(a: T, b: NoInfer<T>): boolean {
  return internal.comparePoints(a, b) < 0;
}

export function isAfter<T extends Point>(a: T, b: NoInfer<T>): boolean {
  return internal.comparePoints(a, b) > 0;
}

export function isSameOrBefore<T extends Point>(a: T, b: NoInfer<T>): boolean {
  return internal.comparePoints(a, b) <= 0;
}

export function isSameOrAfter<T extends Point>(a: T, b: NoInfer<T>): boolean {
  return internal.comparePoints(a, b) >= 0;
}

export type SameOptions = Readonly<{
  week?: WeekRules;
  /** Zone in which to bucket. Required for instants; required for zoned values in different zones. */
  timeZone?: string;
}>;

function toBucketable(value: Point, timeZone: string | undefined, unit: string): Civil {
  if (isInstant(value)) {
    if (!timeZone) throw new TypeError(`isSame(${unit}) on Instants needs a timeZone option`);
    return value.toZonedDateTimeISO(timeZone);
  }
  if (isZonedDateTime(value) && timeZone) return value.withTimeZone(timeZone);
  return value;
}

/** Units a value can be bucketed by: instants may use calendar units once projected into `timeZone`. */
export type BucketUnitFor<T extends Point> = T extends PlainDate ? CalendarUnit : Unit;

/** Do both values fall in the same calendar unit (day, ISO week, month, quarter, year, hour…)? */
export function isSame<T extends Point>(
  a: T,
  b: NoInfer<T>,
  unit: BucketUnitFor<NoInfer<T>>,
  options?: SameOptions,
): boolean {
  assertSameKind(a, b, 'isSame');
  const left = toBucketable(a, options?.timeZone, unit);
  const right = toBucketable(b, options?.timeZone, unit);
  if (isZonedDateTime(left) && isZonedDateTime(right) && left.timeZoneId !== right.timeZoneId) {
    throw new TypeError(
      `isSame(${unit}) across zones ${left.timeZoneId} and ${right.timeZoneId} needs an explicit timeZone option`,
    );
  }
  return equalsPoint(startOf(left, unit, options), startOf(right, unit, options));
}

export function isSameDay(a: Civil, b: Civil, options?: SameOptions): boolean {
  return isSame(a, b, 'day', options);
}
export function isSameWeek(a: Civil, b: Civil, options?: SameOptions): boolean {
  return isSame(a, b, 'week', options);
}
export function isSameMonth(a: Civil, b: Civil, options?: SameOptions): boolean {
  return isSame(a, b, 'month', options);
}
export function isSameQuarter(a: Civil, b: Civil, options?: SameOptions): boolean {
  return isSame(a, b, 'quarter', options);
}
export function isSameYear(a: Civil, b: Civil, options?: SameOptions): boolean {
  return isSame(a, b, 'year', options);
}

/** Is `value` inside `[start, end)` (or the given `bounds`)? Reversed bounds throw. */
export function isBetween<T extends Point>(
  value: T,
  start: NoInfer<T>,
  end: NoInfer<T>,
  options?: Readonly<{ bounds?: Bounds }>,
): boolean {
  if (internal.comparePoints(start, end) > 0) throw new RangeError('isBetween: start is after end');
  const bounds = options?.bounds ?? '[)';
  const lower = internal.comparePoints(value, start);
  const upper = internal.comparePoints(value, end);
  const lowerOk = bounds.startsWith('[') ? lower >= 0 : lower > 0;
  const upperOk = bounds.endsWith(']') ? upper <= 0 : upper < 0;
  return lowerOk && upperOk;
}

/** The earliest of the given values (one of the inputs, not a copy). */
export function min<T extends Point>(values: readonly [T, ...T[]]): T {
  return values.reduce((best, candidate) => (internal.comparePoints(candidate, best) < 0 ? candidate : best));
}

/** The latest of the given values. */
export function max<T extends Point>(values: readonly [T, ...T[]]): T {
  return values.reduce((best, candidate) => (internal.comparePoints(candidate, best) > 0 ? candidate : best));
}

/** `value` limited to `[minimum, maximum]`. */
export function clamp<T extends Point>(value: T, minimum: NoInfer<T>, maximum: NoInfer<T>): T {
  if (internal.comparePoints(minimum, maximum) > 0) throw new RangeError('clamp: minimum is after maximum');
  if (internal.comparePoints(value, minimum) < 0) return minimum;
  if (internal.comparePoints(value, maximum) > 0) return maximum;
  return value;
}
