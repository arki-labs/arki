/**
 * Arithmetic, field access, boundaries, rounding and differences.
 *
 * Policies (one for the whole package):
 * - `add`/`sub`/`set` clamp out-of-range fields (`overflow: 'constrain'`):
 *   Jan 31 + 1 month = Feb 28. Pass `{ overflow: 'reject' }` to throw instead.
 * - On a `ZonedDateTime`, calendar units (years…days) move the wall clock and
 *   time units (hours…ns) move the exact instant. Adding 1 day across a DST
 *   change is 23 or 25 elapsed hours; adding 24 hours is always 24.
 * - `diff(from, to)` is `to − from`: positive when `to` is later.
 */

import type { DurationInput } from './internal/amount.js';
import type {
  Amount,
  AmountFor,
  CalendarUnit,
  Civil,
  DateParts,
  Disambiguation,
  Duration,
  DurationUnit,
  Overflow,
  PlainDate,
  Point,
  RoundingMode,
  Timeline,
  TimeUnit,
  Unit,
  UnitFor,
  Wall,
  WallParts,
  WeekRules,
} from './types.js';
import { instant } from './core.js';
import { negateDurationInput, toDurationInput } from './internal/amount.js';
import { daysBetween } from './internal/days.js';
import { sameKind } from './internal/kind.js';
import { addPlainDate, endOfPlainDate, startOfPlainDate } from './internal/plain.js';
import { addPoint, comparePoints, isCalendarUnit } from './internal/point.js';
import { startOfWeekDate } from './internal/week.js';
import { startOfZoned } from './internal/zoned.js';
import { isDuration, isInstant, ISO_WEEK, isPlainDate, isPlainDateTime, isZonedDateTime } from './types.js';

export type ArithmeticOptions = Readonly<{ overflow?: Overflow }>;
export type SetOptions = Readonly<{ overflow?: Overflow; disambiguation?: Disambiguation }>;
export type WeekOptions = Readonly<{ week?: WeekRules }>;

// ---------------------------------------------------------------------------
// add / sub

/** `value + amount`. Calendar amounts are rejected on an `Instant` (project it into a zone first). */
export function add<T extends Civil>(value: T, amount: Amount | Duration, options?: ArithmeticOptions): T;
export function add<T extends Point>(
  value: T,
  amount: AmountFor<NoInfer<T>> | Duration,
  options?: ArithmeticOptions,
): T;
export function add(value: Point, amount: Amount | Duration, options?: ArithmeticOptions): Point {
  return sameKind(value, addAny(value, toDurationInput(amount), options));
}

/** Temporal's `add`, through the integer fast path for ISO-calendar plain dates. */
function addAny(value: Point, input: DurationInput, options: ArithmeticOptions | undefined): Point {
  if (isPlainDate(value) && !isDuration(input)) {
    const fast = addPlainDate(value, input, options?.overflow);
    if (fast !== undefined) return fast;
  }
  return addPoint(value, input, options);
}

/** `value − amount`. Not always the inverse of `add` (Jan 31 + 1 month − 1 month = Feb 28 − 1 month = Jan 28). */
export function sub<T extends Civil>(value: T, amount: Amount | Duration, options?: ArithmeticOptions): T;
export function sub<T extends Point>(
  value: T,
  amount: AmountFor<NoInfer<T>> | Duration,
  options?: ArithmeticOptions,
): T;
export function sub(value: Point, amount: Amount | Duration, options?: ArithmeticOptions): Point {
  return sameKind(value, addAny(value, negateDurationInput(toDurationInput(amount)), options));
}

// ---------------------------------------------------------------------------
// parts / set

export type PartsFor<T extends Civil> = T extends PlainDate ? DateParts : WallParts;

/** The calendar (and, for wall-clock values, time) fields as a plain object. */
export function parts(value: PlainDate): DateParts;
export function parts(value: Wall): WallParts;
export function parts(value: Civil): DateParts | WallParts;
export function parts(value: Civil): DateParts | WallParts {
  const date: DateParts = { year: value.year, month: value.month, day: value.day };
  if (isPlainDate(value)) return date;
  return {
    ...date,
    hour: value.hour,
    minute: value.minute,
    second: value.second,
    millisecond: value.millisecond,
    microsecond: value.microsecond,
    nanosecond: value.nanosecond,
  };
}

function setPoint(value: Civil, patch: Partial<WallParts>, options: SetOptions | undefined): Civil {
  if (isZonedDateTime(value)) return value.with(patch, { offset: 'prefer', ...options });
  return value.with(patch, { overflow: options?.overflow });
}

/** A copy with the given fields replaced. Out-of-range fields clamp unless `overflow: 'reject'`. */
export function set<T extends Civil>(value: T, patch: Partial<PartsFor<NoInfer<T>>>, options?: SetOptions): T {
  return sameKind(value, setPoint(value, patch, options));
}

// ---------------------------------------------------------------------------
// boundaries

function startOfDate(date: PlainDate, unit: CalendarUnit, rules: WeekRules): PlainDate {
  const fast = startOfPlainDate(date, unit, rules);
  if (fast !== undefined) return fast;
  switch (unit) {
    case 'day': {
      return date;
    }
    case 'week': {
      return startOfWeekDate(date, rules);
    }
    case 'month': {
      return date.with({ day: 1 });
    }
    case 'quarter': {
      return date.with({ month: Math.floor((date.month - 1) / 3) * 3 + 1, day: 1 });
    }
    case 'year': {
      return date.with({ month: 1, day: 1 });
    }
  }
}

function startOfPoint(value: Point, unit: Unit, rules: WeekRules): Point {
  if (isCalendarUnit(unit)) {
    if (isInstant(value))
      throw new RangeError(`startOf(${unit}) needs a zone — project the Instant with inZone() first`);
    if (isPlainDate(value)) return startOfDate(value, unit, rules);
    if (isZonedDateTime(value)) {
      const fast = startOfZoned(value, unit, rules);
      if (fast !== undefined) return fast;
    }
    const date = startOfDate(value.toPlainDate(), unit, rules);
    if (isPlainDateTime(value)) return date.toPlainDateTime();
    return date.toZonedDateTime({ timeZone: value.timeZoneId });
  }
  if (isPlainDate(value)) throw new RangeError(`startOf(${unit}) is not defined for a PlainDate`);
  return value.round({ smallestUnit: unit, roundingMode: 'floor' });
}

/** The first moment of the unit containing `value` (week per `options.week`, ISO by default). */
export function startOf<T extends Civil>(value: T, unit: CalendarUnit, options?: WeekOptions): T;
export function startOf<T extends Point>(value: T, unit: UnitFor<NoInfer<T>>, options?: WeekOptions): T;
export function startOf(value: Point, unit: Unit, options?: WeekOptions): Point {
  return sameKind(value, startOfPoint(value, unit, options?.week ?? ISO_WEEK));
}

function oneUnit(unit: Unit): Amount {
  switch (unit) {
    case 'year': {
      return { years: 1 };
    }
    case 'quarter': {
      return { months: 3 };
    }
    case 'month': {
      return { months: 1 };
    }
    case 'week': {
      return { weeks: 1 };
    }
    case 'day': {
      return { days: 1 };
    }
    case 'hour': {
      return { hours: 1 };
    }
    case 'minute': {
      return { minutes: 1 };
    }
    case 'second': {
      return { seconds: 1 };
    }
    case 'millisecond': {
      return { milliseconds: 1 };
    }
    case 'microsecond': {
      return { microseconds: 1 };
    }
    case 'nanosecond': {
      return { nanoseconds: 1 };
    }
  }
}

function nextBoundaryPoint(value: Point, unit: Unit, rules: WeekRules): Point {
  if (isCalendarUnit(unit) || isPlainDate(value)) {
    const next = addPoint(startOfPoint(value, unit, rules), oneUnit(unit));
    return isZonedDateTime(next) ? startOfPoint(next, unit, rules) : next;
  }
  // The next `:00` on the clock. Temporal resolves a DST gap forward, so this
  // is also the start of a shortened unit (Lord Howe 02:30 after a 02:00 → 02:30 jump).
  const wall = value.round({ smallestUnit: unit, roundingMode: 'ceil' });
  if (!isZonedDateTime(value)) return comparePoints(wall, value) > 0 ? wall : addPoint(wall, oneUnit(unit));
  // A fall-back fold repeats wall-clock time: the clock never shows the repeated
  // hour as "next", and a unit may last longer than itself (Lord Howe 01:00–02:00
  // spans 90 minutes). Step in exact time until the landed unit starts after `value`.
  let exact: Point = value;
  let exactStart: Point;
  do {
    exact = addPoint(exact, oneUnit(unit));
    exactStart = startOfPoint(exact, unit, rules);
  } while (comparePoints(exactStart, value) <= 0);
  return comparePoints(wall, value) > 0 && comparePoints(wall, exactStart) < 0 ? wall : exactStart;
}

/** The start of the unit after the one containing `value` — the exclusive end of `startOf(value, unit)`. Always after `value`. */
export function nextBoundary<T extends Civil>(value: T, unit: CalendarUnit, options?: WeekOptions): T;
export function nextBoundary<T extends Point>(value: T, unit: UnitFor<NoInfer<T>>, options?: WeekOptions): T;
export function nextBoundary(value: Point, unit: Unit, options?: WeekOptions): Point {
  return sameKind(value, nextBoundaryPoint(value, unit, options?.week ?? ISO_WEEK));
}

/**
 * The last representable moment of the unit: the next boundary minus one day
 * for a `PlainDate`, minus one nanosecond otherwise. Prefer `[startOf, nextBoundary)`
 * for range queries; `endOf` exists for display and inclusive APIs.
 */
export function endOf<T extends Civil>(value: T, unit: CalendarUnit, options?: WeekOptions): T;
export function endOf<T extends Point>(value: T, unit: UnitFor<NoInfer<T>>, options?: WeekOptions): T;
export function endOf(value: Point, unit: Unit, options?: WeekOptions): Point {
  if (isPlainDate(value) && isCalendarUnit(unit)) {
    const fast = endOfPlainDate(value, unit, options?.week ?? ISO_WEEK);
    if (fast !== undefined) return sameKind(value, fast);
  }
  const next = nextBoundaryPoint(value, unit, options?.week ?? ISO_WEEK);
  const step: Amount = isPlainDate(next) ? { days: -1 } : { nanoseconds: -1 };
  return sameKind(value, addPoint(next, step));
}

// ---------------------------------------------------------------------------
// rounding

export type RoundOptions = Readonly<{
  /** Round to a multiple of the unit (e.g. 15 minutes). Calendar units support only 1. */
  increment?: number;
  week?: WeekRules;
  /** For `round`: which side wins an exact tie. Default `later`. */
  tie?: 'earlier' | 'later';
}>;

type TemporalRoundingMode = 'floor' | 'ceil' | 'halfCeil' | 'halfFloor';

function roundTime(
  value: Exclude<Point, PlainDate>,
  unit: TimeUnit,
  increment: number,
  mode: TemporalRoundingMode,
): Point {
  return value.round({ smallestUnit: unit, roundingIncrement: increment, roundingMode: mode });
}

function assertCalendarIncrement(unit: Unit, increment: number): void {
  if (increment !== 1)
    throw new RangeError(`Rounding to ${String(increment)} ${unit}s is not supported; calendar units round to 1`);
}

function roundPoint(
  value: Point,
  unit: Unit,
  options: RoundOptions | undefined,
  mode: 'floor' | 'ceil' | 'round',
): Point {
  const increment = options?.increment ?? 1;
  const rules = options?.week ?? ISO_WEEK;
  if (!isCalendarUnit(unit)) {
    if (isPlainDate(value)) throw new RangeError(`Cannot round a PlainDate to ${unit}`);
    const tie: TemporalRoundingMode = options?.tie === 'earlier' ? 'halfFloor' : 'halfCeil';
    return roundTime(value, unit, increment, mode === 'round' ? tie : mode);
  }
  assertCalendarIncrement(unit, increment);
  const start = startOfPoint(value, unit, rules);
  if (mode === 'floor') return start;
  const next = nextBoundaryPoint(value, unit, rules);
  if (comparePoints(value, start) === 0) return start;
  if (mode === 'ceil') return next;
  const toStart = spanNanoseconds(start, value);
  const toNext = spanNanoseconds(value, next);
  if (toStart < toNext) return start;
  if (toStart > toNext) return next;
  return options?.tie === 'earlier' ? start : next;
}

/** Distance between two points of the same kind in nanoseconds (days = 24h for zone-less values). */
function spanNanoseconds(from: Point, to: Point): bigint {
  if (isInstant(from) && isInstant(to)) return to.epochNanoseconds - from.epochNanoseconds;
  if (isZonedDateTime(from) && isZonedDateTime(to)) return to.epochNanoseconds - from.epochNanoseconds;
  if (isPlainDate(from) && isPlainDate(to)) return BigInt(daysBetween(from, to)) * 86_400_000_000_000n;
  if (isPlainDateTime(from) && isPlainDateTime(to)) {
    const d = from.until(to, { largestUnit: 'hour' });
    return (
      BigInt(d.hours) * 3_600_000_000_000n +
      BigInt(d.minutes) * 60_000_000_000n +
      BigInt(d.seconds) * 1_000_000_000n +
      BigInt(d.milliseconds) * 1_000_000n +
      BigInt(d.microseconds) * 1000n +
      BigInt(d.nanoseconds)
    );
  }
  throw new TypeError('spanNanoseconds needs two values of the same kind');
}

/** Round down to the unit (or to a multiple of it via `increment`). Same as `startOf` for calendar units. */
export function floor<T extends Civil>(value: T, unit: CalendarUnit, options?: RoundOptions): T;
export function floor<T extends Point>(value: T, unit: UnitFor<NoInfer<T>>, options?: RoundOptions): T;
export function floor(value: Point, unit: Unit, options?: RoundOptions): Point {
  return sameKind(value, roundPoint(value, unit, options, 'floor'));
}

/** Round up to the unit; a value already on the boundary is returned unchanged. */
export function ceil<T extends Civil>(value: T, unit: CalendarUnit, options?: RoundOptions): T;
export function ceil<T extends Point>(value: T, unit: UnitFor<NoInfer<T>>, options?: RoundOptions): T;
export function ceil(value: Point, unit: Unit, options?: RoundOptions): Point {
  return sameKind(value, roundPoint(value, unit, options, 'ceil'));
}

/** Round to the nearest unit boundary; ties go to the later boundary unless `tie: 'earlier'`. */
export function round<T extends Civil>(value: T, unit: CalendarUnit, options?: RoundOptions): T;
export function round<T extends Point>(value: T, unit: UnitFor<NoInfer<T>>, options?: RoundOptions): T;
export function round(value: Point, unit: Unit, options?: RoundOptions): Point {
  return sameKind(value, roundPoint(value, unit, options, 'round'));
}

// ---------------------------------------------------------------------------
// differences

export type DiffOptions = Readonly<{
  /** Return the exact fractional total instead of truncating toward zero. */
  fractional?: boolean;
}>;

type DateUnit = Exclude<CalendarUnit, 'quarter'>;

function isDateUnit(unit: DurationUnit): unit is DateUnit {
  return unit === 'year' || unit === 'month' || unit === 'week' || unit === 'day';
}

function untilPoint(from: Point, to: Point, largestUnit: DurationUnit): Duration {
  if (isPlainDate(from) && isPlainDate(to)) {
    if (!isDateUnit(largestUnit)) throw new RangeError(`A PlainDate difference cannot be measured in ${largestUnit}s`);
    return from.until(to, { largestUnit });
  }
  if (isPlainDateTime(from) && isPlainDateTime(to)) return from.until(to, { largestUnit });
  if (isZonedDateTime(from) && isZonedDateTime(to)) return from.until(to, { largestUnit });
  if (isInstant(from) && isInstant(to)) {
    if (isDateUnit(largestUnit))
      throw new RangeError(
        `An Instant difference cannot be measured in ${largestUnit}s — project it with inZone() first`,
      );
    return from.until(to, { largestUnit });
  }
  throw new TypeError('diff needs two values of the same kind');
}

/** Temporal needs a calendar anchor to total months/years; an Instant has none. */
function anchorOf(point: Point): Civil | undefined {
  return isInstant(point) ? undefined : point;
}

function durationField(duration: Duration, unit: DurationUnit): number {
  switch (unit) {
    case 'year': {
      return duration.years;
    }
    case 'month': {
      return duration.months;
    }
    case 'week': {
      return duration.weeks;
    }
    case 'day': {
      return duration.days;
    }
    case 'hour': {
      return duration.hours;
    }
    case 'minute': {
      return duration.minutes;
    }
    case 'second': {
      return duration.seconds;
    }
    case 'millisecond': {
      return duration.milliseconds;
    }
    case 'microsecond': {
      return duration.microseconds;
    }
    case 'nanosecond': {
      return duration.nanoseconds;
    }
  }
}

/**
 * `to − from` as a number of units. Positive when `to` is later.
 *
 * - Default: the whole-unit field of the balanced difference, truncated toward
 *   zero. Calendar units count completed steps from `from`, so
 *   `diff(Jan 31, Feb 28, 'month')` is `0` (Feb 31 does not exist) while
 *   `diff(Jan 31, Mar 1, 'month')` is `1`.
 * - `{ fractional: true }`: the exact total in that unit, anchored at `from`;
 *   `diff(Jan 31, Feb 28, 'month', { fractional: true })` is `1` because the
 *   constrained month step lands exactly on Feb 28, and the reverse is `-28/31`.
 *
 * Use `until` for a balanced `Duration` and `diffElapsed` for exact elapsed
 * time. Zoned values must share a zone for calendar units.
 */
export function diff<T extends Civil>(from: T, to: NoInfer<T>, unit: CalendarUnit, options?: DiffOptions): number;
export function diff<T extends Point>(
  from: T,
  to: NoInfer<T>,
  unit: UnitFor<NoInfer<T>>,
  options?: DiffOptions,
): number;
export function diff(from: Point, to: Point, unit: Unit, options?: DiffOptions): number {
  if (isPlainDate(from) && isPlainDate(to) && (unit === 'day' || unit === 'week')) {
    // Whole days between two calendar dates is integer arithmetic; no need
    // for Temporal's general (and, on the polyfill, slow) `until`.
    const days = daysBetween(from, to);
    if (unit === 'day') return days;
    return options?.fractional ? days / 7 : Math.trunc(days / 7);
  }
  const largestUnit: DurationUnit = unit === 'quarter' ? 'month' : unit;
  const duration = untilPoint(from, to, largestUnit);
  const relativeTo = anchorOf(from);
  const total = options?.fractional
    ? duration.total({ unit: largestUnit, relativeTo })
    : durationField(duration, largestUnit);
  return unit === 'quarter' ? (options?.fractional ? total / 3 : Math.trunc(total / 3)) : total;
}

export type UntilOptions<T extends Point> = Readonly<{
  largestUnit: Exclude<UnitFor<T>, 'quarter'>;
  smallestUnit?: Exclude<UnitFor<T>, 'quarter'>;
  roundingMode?: RoundingMode;
}>;

type AnyUntilOptions = Readonly<{
  largestUnit: DurationUnit;
  smallestUnit?: DurationUnit;
  roundingMode?: RoundingMode;
}>;

export type CalendarUntilOptions = Readonly<{
  largestUnit: Exclude<CalendarUnit, 'quarter'>;
  smallestUnit?: Exclude<CalendarUnit, 'quarter'>;
  roundingMode?: RoundingMode;
}>;

/** `to − from` as a balanced `Duration` (e.g. 1 month 3 days 4 hours). */
export function until<T extends Civil>(from: T, to: NoInfer<T>, options: CalendarUntilOptions): Duration;
export function until<T extends Point>(from: T, to: NoInfer<T>, options: UntilOptions<NoInfer<T>>): Duration;
export function until(from: Point, to: Point, options: AnyUntilOptions): Duration {
  const base = untilPoint(from, to, options.largestUnit);
  if (!options.smallestUnit && !options.roundingMode) return base;
  const relativeTo = anchorOf(from);
  return base.round({
    largestUnit: options.largestUnit,
    smallestUnit: options.smallestUnit ?? 'nanosecond',
    roundingMode: options.roundingMode ?? 'trunc',
    relativeTo,
  });
}

const NS: Record<TimeUnit | 'day' | 'week', bigint> = {
  nanosecond: 1n,
  microsecond: 1000n,
  millisecond: 1_000_000n,
  second: 1_000_000_000n,
  minute: 60_000_000_000n,
  hour: 3_600_000_000_000n,
  day: 86_400_000_000_000n,
  week: 604_800_000_000_000n,
};

/** Exact nanoseconds from `from` to `to`, ignoring calendars and zones. */
export function elapsedNanoseconds(from: Timeline | Date, to: Timeline | Date): bigint {
  return instant(to).epochNanoseconds - instant(from).epochNanoseconds;
}

/**
 * Elapsed time between two instants. Here a `day` is exactly 24 hours and a
 * `week` 168 hours — use `diff` on zoned values for calendar days.
 */
export function diffElapsed(
  from: Timeline | Date,
  to: Timeline | Date,
  unit: TimeUnit | 'day' | 'week',
  options?: DiffOptions,
): number {
  const ns = elapsedNanoseconds(from, to);
  if (options?.fractional) return Number(ns) / Number(NS[unit]);
  return Number(ns / NS[unit]);
}

export { type Instant, type ZonedDateTime } from './types.js';
