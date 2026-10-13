/**
 * Formatting: Unicode LDML patterns (`format`), ISO 8601 text (`formatISO`)
 * and locale-native output (`formatIntl`).
 *
 * Policies (one for the whole package):
 * - `format` reproduces date-fns v4 `format` output (en-US) for its token
 *   subset, so code moving off date-fns keeps its strings. Word tokens (month,
 *   weekday, AM/PM, era, zone names) come from `Intl.DateTimeFormat` in the
 *   requested locale; numbers, ordinals (`do`), quarters and the `P`/`p`
 *   presets follow date-fns en-US.
 * - A `Date` or `Instant` is projected into `options.timeZone`, defaulting to
 *   the runtime zone (what date-fns does implicitly). A `ZonedDateTime` keeps
 *   its own zone. A `PlainDate`/`PlainDateTime` has no zone and refuses one.
 * - Asking for something the value does not carry fails loud with a
 *   `RangeError`: a time token on a `PlainDate`, a zone token on a
 *   `PlainDateTime`, an unknown pattern letter, an invalid `Date`.
 * - Default locale is `'en-US'`.
 */

import type { Duration, PlainDate, PlainDateTime, Point, ZonedDateTime } from './types.js';
import { toISO } from './core.js';
import { remember } from './internal/cache.js';
import { civilFromDays, dayOfYearOf, daysFromCivil, isoWeekOf, MS_PER_DAY, weekdayOfDays } from './internal/civil.js';
import { dateTimeFormat } from './internal/intl.js';
import { offsetAt } from './internal/offsets.js';
import { systemTimeZone } from './interop.js';
import { isInstant, isPlainDate, isPlainDateTime, isZonedDateTime, Temporal } from './types.js';

/** Locale (BCP 47, default `'en-US'`) and time zone (IANA id) for formatting. */
export type FormatOptions = Readonly<{ locale?: string; timeZone?: string }>;

/** `Intl.DateTimeFormat` options plus this package's `locale` / `timeZone`. */
export type FormatIntlOptions = Readonly<Intl.DateTimeFormatOptions> & FormatOptions;

const DEFAULT_LOCALE = 'en-US';

type Subject = PlainDate | PlainDateTime | ZonedDateTime;

function kindName(value: Point): string {
  if (isPlainDate(value)) return 'PlainDate';
  if (isPlainDateTime(value)) return 'PlainDateTime';
  if (isZonedDateTime(value)) return 'ZonedDateTime';
  return 'Instant';
}

function instantOf(value: Date): Temporal.Instant {
  const milliseconds = value.getTime();
  if (Number.isNaN(milliseconds)) throw new RangeError('Invalid time value');
  return Temporal.Instant.fromEpochMilliseconds(milliseconds);
}

/** The calendar-bearing value to read fields from (ISO calendar). */
function toSubject(value: Point | Date, timeZone: string | undefined, operation: string): Subject {
  if (value instanceof Date) return instantOf(value).toZonedDateTimeISO(timeZone ?? systemTimeZone());
  if (isInstant(value)) return value.toZonedDateTimeISO(timeZone ?? systemTimeZone());
  if (isZonedDateTime(value)) {
    if (timeZone !== undefined && timeZone !== value.timeZoneId) {
      throw new RangeError(
        `${operation}: timeZone "${timeZone}" does not match the ZonedDateTime's zone "${value.timeZoneId}"`,
      );
    }
    return value.withCalendar('iso8601');
  }
  if (timeZone !== undefined) {
    throw new RangeError(`${operation}: a ${kindName(value)} has no time zone; drop the timeZone option`);
  }
  return value.withCalendar('iso8601');
}

/**
 * What `format` tokens read: plain numbers, computed once per call. Reading
 * Temporal getters costs tens to hundreds of nanoseconds each, and a `Date` or
 * `Instant` would first need a ZonedDateTime; the fields come instead from the
 * epoch and the zone's cached offset.
 */
type Fields = Readonly<{
  kind: 'PlainDate' | 'PlainDateTime' | 'ZonedDateTime';
  year: number;
  month: number;
  day: number;
  /** ISO weekday, Monday = 1. */
  dayOfWeek: number;
  hour: number;
  minute: number;
  second: number;
  /** Nanoseconds within the second. */
  fraction: number;
  /** East-positive UTC offset in milliseconds (zoned values only). */
  offsetMs: number;
  timeZoneId: string;
  epochMs: number;
}>;

function zonedFields(epochMs: number, nanosOfMs: number, timeZoneId: string): Fields {
  const offsetMs = offsetAt(timeZoneId, epochMs);
  const wall = epochMs + offsetMs;
  const days = Math.floor(wall / MS_PER_DAY);
  const { year, month, day } = civilFromDays(days);
  const msOfDay = wall - days * MS_PER_DAY;
  return {
    kind: 'ZonedDateTime',
    year,
    month,
    day,
    dayOfWeek: weekdayOfDays(days),
    hour: Math.floor(msOfDay / 3_600_000),
    minute: Math.floor(msOfDay / 60_000) % 60,
    second: Math.floor(msOfDay / 1000) % 60,
    fraction: (msOfDay % 1000) * 1_000_000 + nanosOfMs,
    offsetMs,
    timeZoneId,
    epochMs,
  };
}

/** Epoch milliseconds (floored) and the nanoseconds left within that millisecond. */
function splitEpoch(value: Temporal.Instant | ZonedDateTime, withNanos: boolean): [number, number] {
  const epochMs = value.epochMilliseconds;
  if (!withNanos) return [epochMs, 0];
  const rest = Number(value.epochNanoseconds - BigInt(epochMs) * 1_000_000n);
  return rest < 0 ? [epochMs - 1, rest + 1_000_000] : [epochMs, rest];
}

function plainFields(value: PlainDate | PlainDateTime): Fields {
  const iso = value.calendarId === 'iso8601' ? value : value.withCalendar('iso8601');
  const { year, month, day } = iso;
  const base = {
    year,
    month,
    day,
    dayOfWeek: weekdayOfDays(daysFromCivil(year, month, day)),
    offsetMs: 0,
    timeZoneId: '',
    epochMs: 0,
  };
  if (isPlainDate(iso)) return { ...base, kind: 'PlainDate', hour: 0, minute: 0, second: 0, fraction: 0 };
  return {
    ...base,
    kind: 'PlainDateTime',
    hour: iso.hour,
    minute: iso.minute,
    second: iso.second,
    fraction: iso.millisecond * 1_000_000 + iso.microsecond * 1000 + iso.nanosecond,
  };
}

/** The fields `format` reads, with the same zone rules and errors as `toSubject`. */
function toFields(value: Point | Date, timeZone: string | undefined, withNanos: boolean): Fields {
  if (value instanceof Date) {
    const epochMs = value.getTime();
    if (Number.isNaN(epochMs)) throw new RangeError('Invalid time value');
    return zonedFields(epochMs, 0, timeZone ?? systemTimeZone());
  }
  if (isInstant(value)) {
    const [epochMs, nanos] = splitEpoch(value, withNanos);
    return zonedFields(epochMs, nanos, timeZone ?? systemTimeZone());
  }
  if (isZonedDateTime(value)) {
    const zone = value.timeZoneId;
    if (timeZone !== undefined && timeZone !== zone) {
      throw new RangeError(`format: timeZone "${timeZone}" does not match the ZonedDateTime's zone "${zone}"`);
    }
    const [epochMs, nanos] = splitEpoch(value, withNanos);
    return zonedFields(epochMs, nanos, zone);
  }
  if (timeZone !== undefined) {
    throw new RangeError(`format: a ${kindName(value)} has no time zone; drop the timeZone option`);
  }
  return plainFields(value);
}

// ---------------------------------------------------------------------------
// numbers

function pad(value: number, width: number): string {
  const sign = value < 0 ? '-' : '';
  return sign + Math.abs(value).toString().padStart(width, '0');
}

/** en-US ordinal: 1st 2nd 3rd 4th … 11th 12th 13th … 21st 22nd. */
function ordinal(value: number): string {
  const rem100 = value % 100;
  if (rem100 > 20 || rem100 < 10) {
    switch (rem100 % 10) {
      case 1: {
        return `${value}st`;
      }
      case 2: {
        return `${value}nd`;
      }
      case 3: {
        return `${value}rd`;
      }
    }
  }
  return `${value}th`;
}

// ---------------------------------------------------------------------------
// words from Intl

type Width = 'narrow' | 'short' | 'long';

function isEnglish(locale: string): boolean {
  return /^en(?:-|$)/i.test(locale);
}

/** The text of one part when a fixed UTC moment is formatted with `options`. */
function partOf(
  locale: string,
  options: Intl.DateTimeFormatOptions,
  epochMs: number,
  type: Intl.DateTimeFormatPartTypes,
): string {
  const formatter = dateTimeFormat(locale, { ...options, timeZone: 'UTC', calendar: 'gregory' });
  const part = formatter.formatToParts(epochMs).find(candidate => candidate.type === type);
  if (part === undefined) throw new RangeError(`format: locale "${locale}" produced no ${type} text`);
  return part.value;
}

/**
 * Locale words (month, weekday, era, day period) by key. Asking Intl costs a
 * formatter lookup and a `formatToParts` call; the set of distinct words is
 * small, so each is computed once.
 */
const NAME_CACHE_LIMIT = 2000;
const names = new Map<string, string>();

function monthName(locale: string, month: number, width: Width, standAlone: boolean): string {
  return remember(names, `M|${locale}|${width}|${standAlone ? 'L' : 'M'}|${month}`, NAME_CACHE_LIMIT, () => {
    const options: Intl.DateTimeFormatOptions = standAlone ? { month: width } : { month: width, day: 'numeric' };
    return partOf(locale, options, Date.UTC(2000, month - 1, 1), 'month');
  });
}

/** `isoDay` 1 = Monday … 7 = Sunday (2000-01-03 was a Monday). */
function weekdayName(locale: string, isoDay: number, width: Width | 'shortest'): string {
  return remember(names, `E|${locale}|${width}|${isoDay}`, NAME_CACHE_LIMIT, () => weekdayText(locale, isoDay, width));
}

function weekdayText(locale: string, isoDay: number, width: Width | 'shortest'): string {
  const name = partOf(
    locale,
    { weekday: width === 'shortest' ? 'short' : width },
    Date.UTC(2000, 0, 2 + isoDay),
    'weekday',
  );
  // Intl has no two-letter width; date-fns en-US uses "Mo", "Tu", … for it.
  return width === 'shortest' && isEnglish(locale) ? name.slice(0, 2) : name;
}

function eraName(locale: string, anno: boolean, width: Width): string {
  return remember(names, `G|${locale}|${width}|${anno ? 'AD' : 'BC'}`, NAME_CACHE_LIMIT, () =>
    partOf(locale, { era: width, year: 'numeric' }, Date.UTC(anno ? 2000 : -1, 0, 1), 'era'),
  );
}

type PeriodWidth = 'abbreviated' | 'lower' | 'wide' | 'narrow';

function amPm(locale: string, pm: boolean, width: PeriodWidth): string {
  const text = remember(names, `a|${locale}|${pm ? 'PM' : 'AM'}`, NAME_CACHE_LIMIT, () =>
    partOf(locale, { hour: 'numeric', hour12: true }, Date.UTC(2000, 0, 1, pm ? 15 : 9), 'dayPeriod'),
  );
  const latin = /^[AP]M$/.test(text);
  switch (width) {
    case 'abbreviated': {
      return text;
    }
    case 'lower': {
      return text.toLowerCase();
    }
    case 'wide': {
      return latin ? `${text.charAt(0).toLowerCase()}.m.` : text;
    }
    case 'narrow': {
      return latin ? text.charAt(0).toLowerCase() : text;
    }
  }
}

/** date-fns `b`: noon / midnight on the exact hour, otherwise AM/PM. Intl has no "midnight" word, so it is en-only. */
function noonMidnight(locale: string, hour: number, width: PeriodWidth): string {
  if ((hour === 12 || hour === 0) && isEnglish(locale)) {
    if (width === 'narrow') return hour === 12 ? 'n' : 'mi';
    return hour === 12 ? 'noon' : 'midnight';
  }
  return amPm(locale, hour >= 12, width);
}

function zoneName(locale: string, value: Fields, width: 'short' | 'long'): string {
  const formatter = dateTimeFormat(locale, { timeZone: value.timeZoneId, timeZoneName: width });
  const part = formatter.formatToParts(value.epochMs).find(candidate => candidate.type === 'timeZoneName');
  if (part === undefined) throw new RangeError(`format: locale "${locale}" produced no time zone name`);
  return part.value;
}

// ---------------------------------------------------------------------------
// offsets (east-positive minutes)

function offsetMinutes(value: Fields): number {
  return Math.trunc(value.offsetMs / 60_000);
}

function offsetText(minutes: number, delimiter: string): string {
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  return sign + pad(Math.trunc(absolute / 60), 2) + delimiter + pad(absolute % 60, 2);
}

function offsetOptionalMinutes(minutes: number, delimiter: string): string {
  if (minutes % 60 !== 0) return offsetText(minutes, delimiter);
  return (minutes < 0 ? '-' : '+') + pad(Math.abs(minutes) / 60, 2);
}

function offsetShort(minutes: number, delimiter: string): string {
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  const hours = Math.trunc(absolute / 60);
  const rest = absolute % 60;
  return rest === 0 ? `${sign}${hours}` : `${sign}${hours}${delimiter}${pad(rest, 2)}`;
}

// ---------------------------------------------------------------------------
// tokens

function needWall(value: Fields, token: string): Fields {
  if (value.kind === 'PlainDate')
    throw new RangeError(`format: token "${token}" needs a time of day, but the value is a PlainDate`);
  return value;
}

function needZone(value: Fields, token: string): Fields {
  if (value.kind !== 'ZonedDateTime') {
    throw new RangeError(`format: token "${token}" needs a time zone, but the value is a ${value.kind}`);
  }
  return value;
}

function numberOrOrdinal(value: number, token: string): string {
  return token.length === 2 && token.charAt(1) === 'o' ? ordinal(value) : pad(value, token.length);
}

function nameWidth(length: number): Width {
  if (length <= 3) return 'short';
  return length === 5 ? 'narrow' : 'long';
}

function periodWidth(length: number): PeriodWidth {
  if (length <= 2) return 'abbreviated';
  if (length === 3) return 'lower';
  return length === 5 ? 'narrow' : 'wide';
}

function weekdayToken(locale: string, isoDay: number, length: number): string {
  if (length === 6) return weekdayName(locale, isoDay, 'shortest');
  return weekdayName(locale, isoDay, nameWidth(length));
}

function fraction(value: Fields, length: number): string {
  const digits = String(value.fraction).padStart(9, '0');
  return length <= 9 ? digits.slice(0, length) : digits.padEnd(length, '0');
}

function formatToken(token: string, value: Fields, locale: string): string {
  const length = token.length;
  const isOrdinal = length === 2 && token.charAt(1) === 'o';
  switch (token.charAt(0)) {
    case 'G': {
      return eraName(locale, value.year > 0, nameWidth(length));
    }
    case 'y': {
      const year = value.year > 0 ? value.year : 1 - value.year;
      if (isOrdinal) return ordinal(year);
      return token === 'yy' ? pad(year, 2).slice(-2) : pad(year, length);
    }
    case 'R': {
      return pad(isoWeekOf(value.year, value.month, value.day).weekYear, length);
    }
    case 'Q': {
      const q = Math.floor((value.month - 1) / 3) + 1;
      if (isOrdinal || length <= 2) return numberOrOrdinal(q, token);
      if (length === 3) return `Q${q}`;
      return length === 5 ? String(q) : `${ordinal(q)} quarter`;
    }
    case 'M':
    case 'L': {
      if (isOrdinal || length <= 2) return numberOrOrdinal(value.month, token);
      return monthName(locale, value.month, nameWidth(length), token.charAt(0) === 'L');
    }
    case 'I': {
      return numberOrOrdinal(isoWeekOf(value.year, value.month, value.day).week, token);
    }
    case 'd': {
      return numberOrOrdinal(value.day, token);
    }
    case 'D': {
      return numberOrOrdinal(dayOfYearOf(value.year, value.month, value.day), token);
    }
    case 'E': {
      return weekdayToken(locale, value.dayOfWeek, length);
    }
    case 'i': {
      if (isOrdinal || length <= 2) return numberOrOrdinal(value.dayOfWeek, token);
      return weekdayToken(locale, value.dayOfWeek, length);
    }
    case 'a': {
      const wall = needWall(value, token);
      return amPm(locale, wall.hour >= 12, periodWidth(length));
    }
    case 'b': {
      return noonMidnight(locale, needWall(value, token).hour, periodWidth(length));
    }
    case 'h': {
      return numberOrOrdinal(needWall(value, token).hour % 12 || 12, token);
    }
    case 'H': {
      return numberOrOrdinal(needWall(value, token).hour, token);
    }
    case 'K': {
      return numberOrOrdinal(needWall(value, token).hour % 12, token);
    }
    case 'k': {
      return numberOrOrdinal(needWall(value, token).hour || 24, token);
    }
    case 'm': {
      return numberOrOrdinal(needWall(value, token).minute, token);
    }
    case 's': {
      return numberOrOrdinal(needWall(value, token).second, token);
    }
    case 'S': {
      return fraction(needWall(value, token), length);
    }
    case 'X': {
      const minutes = offsetMinutes(needZone(value, token));
      if (minutes === 0) return 'Z';
      if (length === 1) return offsetOptionalMinutes(minutes, '');
      return length === 2 || length === 4 ? offsetText(minutes, '') : offsetText(minutes, ':');
    }
    case 'x': {
      const minutes = offsetMinutes(needZone(value, token));
      if (length === 1) return offsetOptionalMinutes(minutes, '');
      return length === 2 || length === 4 ? offsetText(minutes, '') : offsetText(minutes, ':');
    }
    case 'O': {
      const minutes = offsetMinutes(needZone(value, token));
      return length <= 3 ? `GMT${offsetShort(minutes, ':')}` : `GMT${offsetText(minutes, ':')}`;
    }
    case 'z': {
      return zoneName(locale, needZone(value, token), length <= 3 ? 'short' : 'long');
    }
    default: {
      throw new RangeError(`format: unsupported pattern token "${token}"; wrap literal text in single quotes`);
    }
  }
}

// ---------------------------------------------------------------------------
// pattern expansion and tokenizing (same grammar as date-fns)

const LONG_TOKENS = /P+p+|P+|p+|''|'(?:''|[^'])+(?:'|$)|./g;
const TOKENS = /[yYQqMLwIdDecihHKkms]o|(\w)\1*|''|'(?:''|[^'])+(?:'|$)|./g;
const ESCAPED = /^'([\s\S]*?)'?$/;
const DOUBLE_QUOTE = /''/g;
const LATIN_LETTER = /[a-z]/i;

/** date-fns en-US `formatLong` (`z` in the time presets renders as `GMT±h`, i.e. our `O`). */
function datePreset(run: string): string {
  switch (run.length) {
    case 1: {
      return 'MM/dd/yyyy';
    }
    case 2: {
      return 'MMM d, y';
    }
    case 3: {
      return 'MMMM do, y';
    }
    default: {
      return 'EEEE, MMMM do, y';
    }
  }
}

function timePreset(run: string): string {
  switch (run.length) {
    case 1: {
      return 'h:mm a';
    }
    case 2: {
      return 'h:mm:ss a';
    }
    case 3: {
      return 'h:mm:ss a O';
    }
    default: {
      return 'h:mm:ss a OOOO';
    }
  }
}

function expandPresets(pattern: string): string {
  return (pattern.match(LONG_TOKENS) ?? [])
    .map(chunk => {
      const presets = /^(P*)(p*)$/.exec(chunk);
      const dateRun = presets?.[1] ?? '';
      const timeRun = presets?.[2] ?? '';
      if (dateRun === '' && timeRun === '') return chunk;
      if (timeRun === '') return datePreset(dateRun);
      if (dateRun === '') return timePreset(timeRun);
      const joiner = dateRun.length <= 2 ? ', ' : " 'at' ";
      return datePreset(dateRun) + joiner + timePreset(timeRun);
    })
    .join('');
}

/** A pattern split once into literal text and field tokens; the split is reused across calls. */
type PatternPiece = string | Readonly<{ token: string }>;

/** A compiled pattern; `nanos` is set when a fraction token shows digits below the millisecond. */
type CompiledPattern = Readonly<{ pieces: readonly PatternPiece[]; nanos: boolean }>;

const PATTERN_CACHE_LIMIT = 200;
const patterns = new Map<string, CompiledPattern>();

function compilePattern(pattern: string): CompiledPattern {
  return remember(patterns, pattern, PATTERN_CACHE_LIMIT, () => {
    const pieces = (expandPresets(pattern).match(TOKENS) ?? []).map((token): PatternPiece => {
      if (token === "''") return "'";
      const head = token.charAt(0);
      if (head === "'") return unquote(token);
      return LATIN_LETTER.test(head) ? { token } : token;
    });
    const nanos = pieces.some(
      piece => typeof piece !== 'string' && piece.token.startsWith('S') && piece.token.length > 3,
    );
    return { pieces, nanos };
  });
}

function unquote(chunk: string): string {
  const inner = ESCAPED.exec(chunk)?.[1];
  return inner === undefined ? chunk : inner.replaceAll(DOUBLE_QUOTE, "'");
}

/**
 * Format with a Unicode LDML pattern, producing the same text as date-fns v4
 * `format` (en-US) for the supported tokens.
 *
 * Tokens: `G…GGGGG` era · `y yy yyy… yo` year · `R…` ISO week-year ·
 * `Q QQ QQQ QQQQ QQQQQ Qo` quarter · `M… L… Mo Lo` month (L = stand-alone) ·
 * `I II Io` ISO week · `d dd do` day · `D DD DDD Do` day of year ·
 * `E…EEEEEE` weekday · `i…iiiiii io` ISO weekday · `a…aaaaa` AM/PM ·
 * `b…bbbbb` AM/PM/noon/midnight · `h H K k` (+ `o`) hours · `m s` (+ `o`) ·
 * `S…` fraction (truncated) · `X… x…` ISO offset · `O OOOO` GMT offset ·
 * `z zzzz` zone name (Intl) · `P…PPPP p…pppp Pp…` date-fns en-US presets ·
 * `'literal'` with `''` for a quote. Any other letter throws `RangeError`.
 *
 * `Date`/`Instant` are shown in `options.timeZone ?? systemTimeZone()`.
 * Time tokens on a `PlainDate`, and zone tokens on a `PlainDate`/`PlainDateTime`,
 * throw `RangeError`.
 */
export function format(value: Point | Date, pattern: string, options?: FormatOptions): string {
  const locale = options?.locale ?? DEFAULT_LOCALE;
  const compiled = compilePattern(pattern);
  const fields = toFields(value, options?.timeZone, compiled.nanos);
  let text = '';
  for (const piece of compiled.pieces) {
    text += typeof piece === 'string' ? piece : formatToken(piece.token, fields, locale);
  }
  return text;
}

/** ISO 8601 / RFC 9557 text: the value's `toString()` (`2026-05-20`, `PT1H30M`, `…+03:00[Europe/Bucharest]`). */
export function formatISO(value: Point | Duration): string {
  return toISO(value);
}

const TIME_OPTIONS = [
  'hour',
  'minute',
  'second',
  'fractionalSecondDigits',
  'dayPeriod',
  'timeStyle',
  'timeZoneName',
] as const satisfies readonly (keyof Intl.DateTimeFormatOptions)[];

/**
 * Locale-native output through `Intl.DateTimeFormat` (`dateStyle`, `month: 'long'`, …).
 *
 * - `PlainDate`: date fields only; time options (`hour`, `minute`, `second`,
 *   `fractionalSecondDigits`, `dayPeriod`, `timeStyle`, `timeZoneName`) throw `RangeError`.
 * - `PlainDateTime`: the wall clock as-is, no zone (`timeZoneName` throws).
 * - `ZonedDateTime`: its own zone; a different `timeZone` option throws.
 * - `Date`/`Instant`: `options.timeZone ?? systemTimeZone()`.
 * A `timeZone` option on a `PlainDate`/`PlainDateTime` throws.
 */
export function formatIntl(value: Point | Date, options?: FormatIntlOptions): string {
  const { locale = DEFAULT_LOCALE, timeZone, ...intl } = options ?? {};
  const subject = toSubject(value, timeZone, 'formatIntl');
  if (isZonedDateTime(subject)) {
    return dateTimeFormat(locale, { ...intl, timeZone: subject.timeZoneId }).format(subject.epochMilliseconds);
  }
  if (isPlainDate(subject)) {
    const timeOption = TIME_OPTIONS.find(key => intl[key] !== undefined);
    if (timeOption !== undefined) {
      throw new RangeError(`formatIntl: a PlainDate has no time of day; drop the "${timeOption}" option`);
    }
  } else if (intl.timeZoneName !== undefined) {
    throw new RangeError('formatIntl: a PlainDateTime has no time zone; drop the "timeZoneName" option');
  }
  // Plain values: render their fields as a UTC wall clock so no zone shifts them.
  return dateTimeFormat(locale, { ...intl, timeZone: 'UTC' }).format(subject.toZonedDateTime('UTC').epochMilliseconds);
}

/**
 * Locale text for a span, through `Intl.DateTimeFormat#formatRange`:
 * `formatRange(plainDate('2026-05-20'), plainDate('2026-05-24'), { dateStyle: 'medium' })`
 * → `May 20 – 24, 2026`. Both ends follow the same rules as `formatIntl`
 * and must be the same kind of value; the end may precede the start.
 */
export function formatRange(start: Point | Date, end: Point | Date, options?: FormatIntlOptions): string {
  const { locale = DEFAULT_LOCALE, timeZone, ...intl } = options ?? {};
  const from = toSubject(start, timeZone, 'formatRange');
  const to = toSubject(end, timeZone, 'formatRange');
  if (isZonedDateTime(from) && isZonedDateTime(to)) {
    if (from.timeZoneId !== to.timeZoneId) {
      throw new RangeError(`formatRange: both ends must share a zone (${from.timeZoneId} vs ${to.timeZoneId})`);
    }
    return dateTimeFormat(locale, { ...intl, timeZone: from.timeZoneId }).formatRange(
      from.epochMilliseconds,
      to.epochMilliseconds,
    );
  }
  if (isZonedDateTime(from) || isZonedDateTime(to) || isPlainDate(from) !== isPlainDate(to)) {
    throw new RangeError('formatRange: both ends must be the same kind of value');
  }
  if (isPlainDate(from)) {
    const timeOption = TIME_OPTIONS.find(key => intl[key] !== undefined);
    if (timeOption !== undefined) {
      throw new RangeError(`formatRange: a PlainDate has no time of day; drop the "${timeOption}" option`);
    }
  } else if (intl.timeZoneName !== undefined) {
    throw new RangeError('formatRange: a PlainDateTime has no time zone; drop the "timeZoneName" option');
  }
  return dateTimeFormat(locale, { ...intl, timeZone: 'UTC' }).formatRange(
    from.toZonedDateTime('UTC').epochMilliseconds,
    to.toZonedDateTime('UTC').epochMilliseconds,
  );
}
