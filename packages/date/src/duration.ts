/**
 * Durations: construction, field algebra, normalization, totals and
 * human-readable text.
 *
 * Policies (one for the whole module):
 * - `addDuration`/`subDuration` never carry across the three field groups:
 *   (years, months), (weeks, days) and (hours…nanoseconds). A day is not
 *   always 24 hours and a month is not 30 days, so converting between groups
 *   needs an anchor — use `normalizeDuration(d, { relativeTo })` for that.
 * - Without `relativeTo`, totals follow Temporal: a day is 24 hours, and
 *   months/years cannot be converted to days (Temporal throws `RangeError`).
 * - Text defaults to the `'en-US'` locale so server and client render the same.
 */

import type {
  Amount,
  Duration,
  DurationUnit,
  Ordering,
  PlainDate,
  RoundingMode,
  Unit,
  ZonedDateTime,
} from './types.js';
import { toDuration } from './internal/amount.js';
import { isPlainDate, Temporal } from './types.js';

/** The anchor Temporal needs to measure calendar units (months have 28–31 days, days 23–25 hours). */
export type RelativeToOptions = Readonly<{ relativeTo?: PlainDate | ZonedDateTime }>;

// ---------------------------------------------------------------------------
// construction

/** A `Duration` from an ISO 8601 string (`P1DT2H`), an `Amount` (quarters become 3 months) or a `Duration` (returned as-is). */
export function duration(input: string | Amount | Duration): Duration {
  if (typeof input === 'string') return Temporal.Duration.from(input);
  return toDuration(input);
}

/** `n` years. `n` must be an integer. */
export function years(n: number): Duration {
  return Temporal.Duration.from({ years: n });
}
/** `n` months. `n` must be an integer. */
export function months(n: number): Duration {
  return Temporal.Duration.from({ months: n });
}
/** `n` weeks. `n` must be an integer. */
export function weeks(n: number): Duration {
  return Temporal.Duration.from({ weeks: n });
}
/** `n` calendar days. `n` must be an integer. */
export function days(n: number): Duration {
  return Temporal.Duration.from({ days: n });
}
/** `n` hours. `n` must be an integer. */
export function hours(n: number): Duration {
  return Temporal.Duration.from({ hours: n });
}
/** `n` minutes. `n` must be an integer. */
export function minutes(n: number): Duration {
  return Temporal.Duration.from({ minutes: n });
}
/** `n` seconds. `n` must be an integer. */
export function seconds(n: number): Duration {
  return Temporal.Duration.from({ seconds: n });
}
/** `n` milliseconds. `n` must be an integer. */
export function milliseconds(n: number): Duration {
  return Temporal.Duration.from({ milliseconds: n });
}

// ---------------------------------------------------------------------------
// field algebra

const NS_PER: Readonly<Record<'hour' | 'minute' | 'second' | 'millisecond' | 'microsecond', bigint>> = {
  hour: 3_600_000_000_000n,
  minute: 60_000_000_000n,
  second: 1_000_000_000n,
  millisecond: 1_000_000n,
  microsecond: 1000n,
};

function timeNanoseconds(d: Duration): bigint {
  return (
    BigInt(d.hours) * NS_PER.hour +
    BigInt(d.minutes) * NS_PER.minute +
    BigInt(d.seconds) * NS_PER.second +
    BigInt(d.milliseconds) * NS_PER.millisecond +
    BigInt(d.microseconds) * NS_PER.microsecond +
    BigInt(d.nanoseconds)
  );
}

function signOf(value: number | bigint): -1 | 0 | 1 {
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

/** Zero without a sign: `-0` would print and compare oddly in field values. */
function unsignedZero(value: number): number {
  return value === 0 ? 0 : value;
}

function combine(a: Duration, b: Duration, direction: 1 | -1, operation: string): Duration {
  const totalMonths = a.years * 12 + a.months + direction * (b.years * 12 + b.months);
  const totalDays = a.weeks * 7 + a.days + direction * (b.weeks * 7 + b.days);
  const totalNs = timeNanoseconds(a) + BigInt(direction) * timeNanoseconds(b);

  const signs = [signOf(totalMonths), signOf(totalDays), signOf(totalNs)].filter(s => s !== 0);
  if (signs.some(s => s !== signs[0])) {
    throw new RangeError(
      `${operation} produced fields with mixed signs (${a.toString()} ${direction === 1 ? '+' : '−'} ${b.toString()}). ` +
        'Converting between months, days and hours needs an anchor — use normalizeDuration(..., { relativeTo }).',
    );
  }

  const weeksOnly = a.days === 0 && b.days === 0;
  let ns = totalNs;
  const hoursPart = ns / NS_PER.hour;
  ns -= hoursPart * NS_PER.hour;
  const minutesPart = ns / NS_PER.minute;
  ns -= minutesPart * NS_PER.minute;
  const secondsPart = ns / NS_PER.second;
  ns -= secondsPart * NS_PER.second;
  const millisecondsPart = ns / NS_PER.millisecond;
  ns -= millisecondsPart * NS_PER.millisecond;
  const microsecondsPart = ns / NS_PER.microsecond;
  ns -= microsecondsPart * NS_PER.microsecond;

  return Temporal.Duration.from({
    years: unsignedZero(Math.trunc(totalMonths / 12)),
    months: unsignedZero(totalMonths % 12),
    weeks: weeksOnly ? unsignedZero(totalDays / 7) : 0,
    days: weeksOnly ? 0 : unsignedZero(totalDays),
    hours: Number(hoursPart),
    minutes: Number(minutesPart),
    seconds: Number(secondsPart),
    milliseconds: Number(millisecondsPart),
    microseconds: Number(microsecondsPart),
    nanoseconds: Number(ns),
  });
}

/**
 * `a + b` by field groups: (years, months) as months, (weeks, days) as days,
 * (hours…ns) exactly. Groups never carry into each other; weeks survive only
 * when neither input has days. Throws `RangeError` when groups end with mixed signs.
 */
export function addDuration(a: Duration, b: Duration): Duration {
  return combine(a, b, 1, 'addDuration');
}

/** `a − b` with the same group policy as `addDuration` (`P1Y − P2M` = `P10M`; `P1D − PT1H` throws). */
export function subDuration(a: Duration, b: Duration): Duration {
  return combine(a, b, -1, 'subDuration');
}

function scaled(value: number, factor: number): number {
  const result = value * factor;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`multiplyDuration overflowed: ${String(value)} × ${String(factor)} is not a safe integer`);
  }
  return unsignedZero(result);
}

/** Every field times `factor` (a safe integer). Fields are scaled as-is, never re-balanced. */
export function multiplyDuration(d: Duration, factor: number): Duration {
  if (!Number.isSafeInteger(factor)) {
    throw new RangeError(`multiplyDuration needs a safe integer factor, received ${String(factor)}`);
  }
  return Temporal.Duration.from({
    years: scaled(d.years, factor),
    months: scaled(d.months, factor),
    weeks: scaled(d.weeks, factor),
    days: scaled(d.days, factor),
    hours: scaled(d.hours, factor),
    minutes: scaled(d.minutes, factor),
    seconds: scaled(d.seconds, factor),
    milliseconds: scaled(d.milliseconds, factor),
    microseconds: scaled(d.microseconds, factor),
    nanoseconds: scaled(d.nanoseconds, factor),
  });
}

/** The same duration pointing the other way. */
export function negateDuration(d: Duration): Duration {
  return d.negated();
}

/** The duration with every field made non-negative. */
export function absDuration(d: Duration): Duration {
  return d.abs();
}

// ---------------------------------------------------------------------------
// normalize / totals

export type NormalizeOptions = Readonly<{
  largestUnit: DurationUnit;
  smallestUnit?: DurationUnit;
  relativeTo?: PlainDate | ZonedDateTime;
  /** Temporal's default (`halfExpand`) when omitted. */
  roundingMode?: RoundingMode;
}>;

/**
 * Re-balance across units with Temporal's `Duration#round`. Calendar units
 * (years, months, weeks) need `relativeTo`; without it a day counts as 24 hours.
 */
export function normalizeDuration(d: Duration, options: NormalizeOptions): Duration {
  return d.round({
    largestUnit: options.largestUnit,
    smallestUnit: options.smallestUnit ?? 'nanosecond',
    roundingMode: options.roundingMode,
    relativeTo: options.relativeTo,
  });
}

/** The whole duration expressed in one unit (fractional). `quarter` is months ÷ 3. */
export function totalDuration(d: Duration, unit: Unit, options?: RelativeToOptions): number {
  const relativeTo = options?.relativeTo;
  if (unit === 'quarter') return d.total({ unit: 'month', relativeTo }) / 3;
  return d.total({ unit, relativeTo });
}

const UNIT_ORDER: readonly DurationUnit[] = [
  'year',
  'month',
  'week',
  'day',
  'hour',
  'minute',
  'second',
  'millisecond',
  'microsecond',
  'nanosecond',
];

const EXACT_NS: Readonly<Record<Exclude<DurationUnit, 'year' | 'month'>, bigint>> = {
  week: 604_800_000_000_000n,
  day: 86_400_000_000_000n,
  ...NS_PER,
  nanosecond: 1n,
};

function assertUnitOrder(units: readonly DurationUnit[]): void {
  if (units.length === 0) throw new RangeError('toUnits needs at least one unit');
  let previous = -1;
  for (const unit of units) {
    const rank = UNIT_ORDER.indexOf(unit);
    if (rank <= previous) {
      throw new RangeError(`toUnits needs distinct units from largest to smallest, received [${units.join(', ')}]`);
    }
    previous = rank;
  }
}

function durationOf(unit: DurationUnit, value: number): Duration {
  const fields: Partial<Record<`${DurationUnit}s`, number>> = { [`${unit}s`]: value };
  return Temporal.Duration.from(fields);
}

function fieldOf(d: Duration, unit: DurationUnit): number {
  const key: `${DurationUnit}s` = `${unit}s`;
  return d[key];
}

/** Anchored decomposition: walk a cursor from the anchor toward `anchor + d`, one unit at a time. */
function anchoredUnits(d: Duration, units: readonly DurationUnit[], anchor: ZonedDateTime): Map<DurationUnit, number> {
  const end = anchor.add(d);
  const out = new Map<DurationUnit, number>();
  let cursor = anchor;
  for (const [index, unit] of units.entries()) {
    if (index === units.length - 1) {
      out.set(unit, cursor.until(end, { largestUnit: unit }).total({ unit, relativeTo: cursor }));
      continue;
    }
    const whole = cursor.until(end, { largestUnit: unit, smallestUnit: unit, roundingMode: 'trunc' });
    const value = unsignedZero(fieldOf(whole, unit));
    out.set(unit, value);
    cursor = cursor.add(durationOf(unit, value));
  }
  return out;
}

/** Unanchored decomposition: months stay months, a week is 7 days, a day is 24 hours. */
function exactUnits(d: Duration, units: readonly DurationUnit[]): Map<DurationUnit, number> {
  const out = new Map<DurationUnit, number>();
  const last = units.at(-1);
  let monthsLeft = d.years * 12 + d.months;
  let nsLeft = BigInt(d.weeks * 7 + d.days) * EXACT_NS.day + timeNanoseconds(d);

  for (const unit of units) {
    if (unit === 'year' || unit === 'month') {
      const size = unit === 'year' ? 12 : 1;
      const value = unit === last ? monthsLeft / size : Math.trunc(monthsLeft / size);
      out.set(unit, unsignedZero(value));
      monthsLeft -= Math.trunc(value) * size;
      if (unit === last) monthsLeft = 0;
      continue;
    }
    const size = EXACT_NS[unit];
    const whole = nsLeft / size;
    nsLeft -= whole * size;
    const value = unit === last ? Number(whole) + Number(nsLeft) / Number(size) : Number(whole);
    if (unit === last) nsLeft = 0n;
    out.set(unit, unsignedZero(value));
  }

  if (monthsLeft !== 0 || nsLeft !== 0n) {
    throw new RangeError(
      `toUnits cannot convert between months and days in ${d.toString()} without an anchor — pass { relativeTo }.`,
    );
  }
  return out;
}

/**
 * Split a duration across `units` (distinct, largest first): every unit is a
 * whole number except the last, which takes the fractional remainder.
 * Without `relativeTo`, months never convert to days (throws `RangeError`).
 */
export function toUnits(
  d: Duration,
  units: readonly DurationUnit[],
  options?: RelativeToOptions,
): Readonly<Partial<Record<DurationUnit, number>>> {
  assertUnitOrder(units);
  const relativeTo = options?.relativeTo;
  const values = relativeTo
    ? anchoredUnits(d, units, isPlainDate(relativeTo) ? relativeTo.toZonedDateTime({ timeZone: 'UTC' }) : relativeTo)
    : exactUnits(d, units);
  const result: Partial<Record<DurationUnit, number>> = {};
  for (const unit of units) result[unit] = values.get(unit) ?? 0;
  return Object.freeze(result);
}

// ---------------------------------------------------------------------------
// comparison / text

/** `-1`, `0` or `1` by length. Calendar units need `relativeTo` (`P1M` vs `P30D` depends on the month). */
export function compareDurations(a: Duration, b: Duration, options?: RelativeToOptions): Ordering {
  return signOf(Temporal.Duration.compare(a, b, { relativeTo: options?.relativeTo }));
}

/** True when every field is zero. */
export function isZeroDuration(d: Duration): boolean {
  return d.blank;
}

/** True when the duration points backward (any field is negative). */
export function isNegativeDuration(d: Duration): boolean {
  return d.sign < 0;
}

/** ISO 8601 duration text, e.g. `P1DT2H`. */
export function formatDurationISO(d: Duration): string {
  return d.toString();
}

export type HumanizeOptions = Readonly<{
  locale?: string;
  units?: readonly DurationUnit[];
  style?: 'long' | 'short' | 'narrow';
  /** Keep only the N largest nonzero units; the rest is dropped, not rounded. */
  maximumUnits?: number;
  relativeTo?: PlainDate | ZonedDateTime;
}>;

const HUMANIZE_UNITS: readonly DurationUnit[] = ['year', 'month', 'week', 'day', 'hour', 'minute', 'second'];

function joinList(locale: string, pieces: readonly string[]): string {
  if (!('ListFormat' in Intl)) return pieces.join(', ');
  return new Intl.ListFormat(locale, { type: 'conjunction' }).format(pieces);
}

/**
 * Locale text such as "1 day and 2 hours" (`Intl.NumberFormat` units joined by
 * `Intl.ListFormat`). Zero-valued units are skipped; a negative duration is the
 * absolute text prefixed with `-`; a zero duration prints 0 of the smallest unit.
 */
export function humanizeDuration(d: Duration, options?: HumanizeOptions): string {
  const locale = options?.locale ?? 'en-US';
  const units = options?.units ?? HUMANIZE_UNITS;
  const maximumUnits = options?.maximumUnits;
  if (maximumUnits !== undefined && (!Number.isSafeInteger(maximumUnits) || maximumUnits < 1)) {
    throw new RangeError(`maximumUnits must be a positive integer, received ${String(maximumUnits)}`);
  }
  const values = toUnits(d, units, { relativeTo: options?.relativeTo });
  const nonzero = units.flatMap(unit => {
    const value = Math.abs(values[unit] ?? 0);
    return value === 0 ? [] : [{ unit, value }];
  });
  const kept = maximumUnits === undefined ? nonzero : nonzero.slice(0, maximumUnits);
  const smallest = units.at(-1) ?? 'second';
  const entries = kept.length > 0 ? kept : [{ unit: smallest, value: 0 }];
  const pieces = entries.map(({ unit, value }) =>
    new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: options?.style ?? 'long' }).format(value),
  );
  const text = joinList(locale, pieces);
  return d.sign < 0 && kept.length > 0 ? `-${text}` : text;
}
