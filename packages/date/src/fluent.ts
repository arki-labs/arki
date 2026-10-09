/**
 * The fluent face of the package: `date(x, { timeZone })` wraps a
 * `ZonedDateTime` plus the display/clock settings it should use, and exposes
 * every receiver-first function as a method. Each method returns a new
 * `DateValue` or a plain result; nothing mutates.
 *
 * `date()` is for moments. A calendar date (`'2026-01-31'`) is rejected with
 * a hint to use `plainDate()` — the two are different things on purpose.
 */

import type { Clock } from '@arki/clock';
import { SystemClock } from '@arki/clock';

import type { BusinessCalendar } from './business.js';
import type { WeekInfo } from './calendar.js';
import type { BucketUnitFor, SameOptions } from './compare.js';
import type { FormatOptions } from './format.js';
import type { ArithmeticOptions, DiffOptions, PartsFor, RoundOptions, SetOptions, UntilOptions } from './math.js';
import type { RelativeOptions } from './relative.js';
import type {
  Amount,
  Bounds,
  Disambiguation,
  Duration,
  Instant,
  PlainDate,
  PlainDateTime,
  Point,
  TimeUnit,
  Unit,
  WallParts,
  Weekday,
  WeekRules,
  ZonedDateTime,
} from './types.js';
import { addBusinessDays, isBusinessDay, nextBusinessDay, previousBusinessDay, subBusinessDays } from './business.js';
import {
  dayOfWeek,
  dayOfYear,
  daysInMonth,
  isLeapYear,
  isoWeek,
  isWeekday,
  isWeekend,
  quarter,
  weekOf,
} from './calendar.js';
import { isFuture as isFutureAt, isPast as isPastAt, now as nowAt, nowIn, today as todayAt } from './clock.js';
import {
  clamp,
  compareAsc,
  equals,
  isAfter,
  isBefore,
  isBetween,
  isSame,
  isSameOrAfter,
  isSameOrBefore,
  sameInstant,
} from './compare.js';
import { instant, plainDate, zoned } from './core.js';
import { format, formatIntl } from './format.js';
import { systemTimeZone, toDate } from './interop.js';
import {
  add,
  ceil,
  diff,
  diffElapsed,
  endOf,
  floor,
  nextBoundary,
  parts,
  round,
  set,
  startOf,
  sub,
  until,
} from './math.js';
import { relative } from './relative.js';
import { isInstant, ISO_WEEK, isZonedDateTime, Temporal } from './types.js';
import { inZone, offset, reinterpretZone } from './zone.js';

export type DateContextOptions = Readonly<{
  timeZone?: string;
  locale?: string;
  week?: WeekRules;
  clock?: Clock;
}>;

type Settings = Readonly<{ timeZone: string; locale: string; week: WeekRules; clock: Clock }>;

/** Anything a `DateValue` method accepts as "the other moment". */
export type DateLike = DateValue | ZonedDateTime | Instant | Date | string;

const DATE_ONLY = /^[+-]?\d{4,6}-\d{2}-\d{2}$/;
const ZONE_ANNOTATION = /\[[^\]]+\]/;

function resolve(input: DateLike, timeZone: string): ZonedDateTime {
  if (input instanceof DateValue) return input.value();
  if (isZonedDateTime(input)) return input;
  if (isInstant(input) || input instanceof Date) return zoned(input, timeZone);
  if (DATE_ONLY.test(input)) {
    throw new RangeError(`date() is for moments; "${input}" is a calendar date — use plainDate() instead`);
  }
  return ZONE_ANNOTATION.test(input) ? zoned(input) : zoned(instant(input), timeZone);
}

/** An immutable moment in a zone with chainable operations. Create one with `date()`. */
export class DateValue {
  readonly #value: ZonedDateTime;
  readonly #settings: Settings;

  constructor(value: ZonedDateTime, settings: Settings) {
    this.#value = value;
    this.#settings = settings;
  }

  #wrap(value: ZonedDateTime): DateValue {
    return new DateValue(value, this.#settings);
  }

  /** The other moment, projected into this value's zone (so calendar comparisons never cross zones). */
  #other(other: DateLike): ZonedDateTime {
    const resolved = resolve(other, this.#settings.timeZone);
    return resolved.timeZoneId === this.#value.timeZoneId ? resolved : resolved.withTimeZone(this.#value.timeZoneId);
  }

  // --- extraction -----------------------------------------------------------

  /** The underlying immutable `ZonedDateTime`. */
  value(): ZonedDateTime {
    return this.#value;
  }
  toInstant(): Instant {
    return this.#value.toInstant();
  }
  toPlainDate(): PlainDate {
    return this.#value.toPlainDate();
  }
  toPlainDateTime(): PlainDateTime {
    return this.#value.toPlainDateTime();
  }
  /** A fresh mutable `Date` at this instant. */
  toDate(): Date {
    return toDate(this.#value);
  }
  toISO(): string {
    return this.#value.toString();
  }
  toString(): string {
    return this.#value.toString();
  }
  toJSON(): string {
    return this.#value.toJSON();
  }
  /** Numeric coercion is a bug waiting to happen; use `toInstant().epochMilliseconds`. */
  [Symbol.toPrimitive](hint: string): string {
    if (hint === 'number')
      throw new TypeError('DateValue cannot be coerced to a number; use toInstant().epochMilliseconds');
    return this.toString();
  }

  get timeZoneId(): string {
    return this.#value.timeZoneId;
  }
  get locale(): string {
    return this.#settings.locale;
  }
  get year(): number {
    return this.#value.year;
  }
  get month(): number {
    return this.#value.month;
  }
  get day(): number {
    return this.#value.day;
  }
  get hour(): number {
    return this.#value.hour;
  }
  get minute(): number {
    return this.#value.minute;
  }
  get second(): number {
    return this.#value.second;
  }
  get epochMilliseconds(): number {
    return this.#value.epochMilliseconds;
  }
  parts(): WallParts {
    return parts(this.#value);
  }

  // --- arithmetic -----------------------------------------------------------

  add(amount: Amount | Duration, options?: ArithmeticOptions): DateValue {
    return this.#wrap(add(this.#value, amount, options));
  }
  sub(amount: Amount | Duration, options?: ArithmeticOptions): DateValue {
    return this.#wrap(sub(this.#value, amount, options));
  }
  set(patch: Partial<PartsFor<ZonedDateTime>>, options?: SetOptions): DateValue {
    return this.#wrap(set(this.#value, patch, options));
  }
  startOf(unit: Unit): DateValue {
    return this.#wrap(startOf(this.#value, unit, this.#settings));
  }
  endOf(unit: Unit): DateValue {
    return this.#wrap(endOf(this.#value, unit, this.#settings));
  }
  nextBoundary(unit: Unit): DateValue {
    return this.#wrap(nextBoundary(this.#value, unit, this.#settings));
  }
  floor(unit: Unit, options?: RoundOptions): DateValue {
    return this.#wrap(floor(this.#value, unit, { week: this.#settings.week, ...options }));
  }
  ceil(unit: Unit, options?: RoundOptions): DateValue {
    return this.#wrap(ceil(this.#value, unit, { week: this.#settings.week, ...options }));
  }
  round(unit: Unit, options?: RoundOptions): DateValue {
    return this.#wrap(round(this.#value, unit, { week: this.#settings.week, ...options }));
  }

  // --- differences ----------------------------------------------------------

  /** `other − this` in whole units (see `diff`). */
  diff(other: DateLike, unit: Unit, options?: DiffOptions): number {
    return diff(this.#value, this.#other(other), unit, options);
  }
  until(other: DateLike, options: UntilOptions<ZonedDateTime>): Duration {
    return until(this.#value, this.#other(other), options);
  }
  /** Exact elapsed time to `other` (a day is 24 h here). */
  diffElapsed(other: DateLike, unit: TimeUnit | 'day' | 'week', options?: DiffOptions): number {
    return diffElapsed(this.#value, resolve(other, this.#settings.timeZone), unit, options);
  }

  // --- comparison -----------------------------------------------------------

  equals(other: DateLike): boolean {
    return equals(this.#value, resolve(other, this.#settings.timeZone));
  }
  sameInstant(other: DateLike): boolean {
    return sameInstant(this.#value, resolve(other, this.#settings.timeZone));
  }
  compare(other: DateLike): -1 | 0 | 1 {
    return compareAsc(this.#value, this.#other(other));
  }
  isBefore(other: DateLike): boolean {
    return isBefore(this.#value, this.#other(other));
  }
  isAfter(other: DateLike): boolean {
    return isAfter(this.#value, this.#other(other));
  }
  isSameOrBefore(other: DateLike): boolean {
    return isSameOrBefore(this.#value, this.#other(other));
  }
  isSameOrAfter(other: DateLike): boolean {
    return isSameOrAfter(this.#value, this.#other(other));
  }
  isSame(other: DateLike, unit: BucketUnitFor<ZonedDateTime>, options?: SameOptions): boolean {
    return isSame(this.#value, this.#other(other), unit, { week: this.#settings.week, ...options });
  }
  isSameDay(other: DateLike): boolean {
    return this.isSame(other, 'day');
  }
  isSameWeek(other: DateLike): boolean {
    return this.isSame(other, 'week');
  }
  isSameMonth(other: DateLike): boolean {
    return this.isSame(other, 'month');
  }
  isSameYear(other: DateLike): boolean {
    return this.isSame(other, 'year');
  }
  isBetween(start: DateLike, end: DateLike, options?: Readonly<{ bounds?: Bounds }>): boolean {
    return isBetween(this.#value, this.#other(start), this.#other(end), options);
  }
  clamp(minimum: DateLike, maximum: DateLike): DateValue {
    return this.#wrap(clamp(this.#value, this.#other(minimum), this.#other(maximum)));
  }

  // --- relative to the context clock ---------------------------------------

  isToday(): boolean {
    return this.isSameDay(nowIn(this.#value.timeZoneId, this.#settings.clock));
  }
  isTomorrow(): boolean {
    return this.isSameDay(nowIn(this.#value.timeZoneId, this.#settings.clock).add({ days: 1 }));
  }
  isYesterday(): boolean {
    return this.isSameDay(nowIn(this.#value.timeZoneId, this.#settings.clock).subtract({ days: 1 }));
  }
  isThisWeek(): boolean {
    return this.isSameWeek(nowIn(this.#value.timeZoneId, this.#settings.clock));
  }
  isThisMonth(): boolean {
    return this.isSameMonth(nowIn(this.#value.timeZoneId, this.#settings.clock));
  }
  isThisYear(): boolean {
    return this.isSameYear(nowIn(this.#value.timeZoneId, this.#settings.clock));
  }
  isPast(): boolean {
    return isPastAt(this.#value, this.#settings.clock);
  }
  isFuture(): boolean {
    return isFutureAt(this.#value, this.#settings.clock);
  }
  /** "3 days ago" / "in 2 hours" relative to the context clock. */
  fromNow(options?: RelativeOptions): string {
    return this.relativeTo(nowAt(this.#settings.clock), options);
  }

  // --- calendar -------------------------------------------------------------

  dayOfWeek(): Weekday {
    return dayOfWeek(this.#value);
  }
  dayOfYear(): number {
    return dayOfYear(this.#value);
  }
  daysInMonth(): number {
    return daysInMonth(this.#value);
  }
  isLeapYear(): boolean {
    return isLeapYear(this.#value);
  }
  isWeekend(weekend?: readonly Weekday[]): boolean {
    return isWeekend(this.#value, weekend);
  }
  isWeekday(weekend?: readonly Weekday[]): boolean {
    return isWeekday(this.#value, weekend);
  }
  isoWeek(): WeekInfo {
    return isoWeek(this.#value);
  }
  weekOf(rules: WeekRules = this.#settings.week): WeekInfo {
    return weekOf(this.#value, rules);
  }
  quarter(): 1 | 2 | 3 | 4 {
    return quarter(this.#value);
  }

  // --- zones ----------------------------------------------------------------

  /** Same instant, another zone. */
  inZone(timeZone: string): DateValue {
    return this.#wrap(inZone(this.#value, timeZone));
  }
  /** Same wall clock, another zone (the instant changes). */
  reinterpretZone(timeZone: string, options?: Readonly<{ disambiguation?: Disambiguation }>): DateValue {
    return this.#wrap(reinterpretZone(this.#value, timeZone, options));
  }
  toUTC(): DateValue {
    return this.inZone('UTC');
  }
  offset(): string {
    return offset(this.#value);
  }

  // --- business days --------------------------------------------------------

  isBusinessDay(calendar?: BusinessCalendar): boolean {
    return isBusinessDay(this.#value, calendar);
  }
  addBusinessDays(count: number, calendar?: BusinessCalendar): DateValue {
    return this.#wrap(addBusinessDays(this.#value, count, calendar));
  }
  subBusinessDays(count: number, calendar?: BusinessCalendar): DateValue {
    return this.#wrap(subBusinessDays(this.#value, count, calendar));
  }
  nextBusinessDay(calendar?: BusinessCalendar): DateValue {
    return this.#wrap(nextBusinessDay(this.#value, calendar));
  }
  previousBusinessDay(calendar?: BusinessCalendar): DateValue {
    return this.#wrap(previousBusinessDay(this.#value, calendar));
  }

  // --- display --------------------------------------------------------------

  /** Token formatting (`'yyyy-MM-dd HH:mm'`) in the context locale. */
  format(pattern: string, options?: FormatOptions): string {
    return format(this.#value, pattern, { locale: this.#settings.locale, ...options });
  }
  /** `Intl.DateTimeFormat` formatting in the context locale. */
  formatIntl(options?: Intl.DateTimeFormatOptions & FormatOptions): string {
    return formatIntl(this.#value, { locale: this.#settings.locale, ...options });
  }
  /** "3 days ago" / "in 2 hours" relative to `reference`. */
  relativeTo(reference: DateLike, options?: RelativeOptions): string {
    return relative(this.#value, resolve(reference, this.#settings.timeZone), {
      locale: this.#settings.locale,
      ...options,
    });
  }

  // --- composition ----------------------------------------------------------

  /** Apply any function to the underlying value; a `ZonedDateTime` result is re-wrapped. */
  pipe<R>(fn: (value: ZonedDateTime) => R): R extends ZonedDateTime ? DateValue : R;
  pipe<R>(fn: (value: ZonedDateTime) => R): DateValue | R {
    const result = fn(this.#value);
    return isZonedDateTime(result) ? this.#wrap(result) : result;
  }
}

function settingsFor(options: DateContextOptions | undefined, fallbackZone?: string): Settings {
  return {
    timeZone: options?.timeZone ?? fallbackZone ?? systemTimeZone(),
    locale: options?.locale ?? 'en-US',
    week: options?.week ?? ISO_WEEK,
    clock: options?.clock ?? new SystemClock(),
  };
}

/**
 * Wrap a moment for fluent use. A `Date`, `Instant` or offset string is
 * projected into `options.timeZone` (runtime zone by default); a
 * `ZonedDateTime` or `[Zone]`-annotated string keeps its own zone.
 */
export function date(input: DateLike, options?: DateContextOptions): DateValue {
  const settings = settingsFor(options, input instanceof DateValue ? input.timeZoneId : undefined);
  const value = resolve(input, settings.timeZone);
  return new DateValue(value, { ...settings, timeZone: value.timeZoneId });
}

/** A `date()` factory with zone, locale, week rules and clock bound once (inject a `MockClock` in tests). */
export type DateContext = Readonly<{
  timeZone: string;
  locale: string;
  week: WeekRules;
  clock: Clock;
  /** The current moment in the context zone. */
  now(): DateValue;
  /** Today's calendar date in the context zone. */
  today(): PlainDate;
  date(input: DateLike): DateValue;
  isToday(value: Point): boolean;
  isPast(value: Instant | ZonedDateTime | Date): boolean;
  isFuture(value: Instant | ZonedDateTime | Date): boolean;
}>;

export function createDateContext(options?: DateContextOptions): DateContext {
  const settings = settingsFor(options);
  const wrap = (input: DateLike): DateValue => date(input, settings);
  return Object.freeze({
    ...settings,
    now: () => wrap(nowIn(settings.timeZone, settings.clock)),
    today: () => todayAt(settings),
    date: wrap,
    isToday: (value: Point) => {
      const target = isInstant(value) ? value.toZonedDateTimeISO(settings.timeZone) : value;
      return Temporal.PlainDate.compare(plainDate(target), todayAt(settings)) === 0;
    },
    isPast: value => isPastAt(value, settings.clock),
    isFuture: value => isFutureAt(value, settings.clock),
  });
}
