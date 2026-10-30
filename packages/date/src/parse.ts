/**
 * Pattern parsing: the inverse of `format`. `parseDate`, `parseDateTime` and
 * `parseZoned` read text laid out by a Unicode LDML pattern (the date-fns v4
 * token subset below) and return a Temporal value, or an `InvalidDateText`
 * failure for text that does not match. Outside text always goes through
 * these doors; the builders (`plainDate`, `zoned`, …) take the caller's own values.
 *
 * Policies (one for the whole package):
 * - Round trip: for every supported token, `parseX(format(value, p), p)`
 *   equals `value`. Word tokens (month, weekday, AM/PM) are matched,
 *   case-insensitively, against the exact words `format` prints for the
 *   locale, so the two can never drift apart.
 * - Supported tokens: `y` `yy` `yyy` `yyyy`, `M`…`MMMM`, `L`…`LLLL`, `d` `dd`,
 *   `D` `DDD` (day of year, only without month/day tokens), `E`…`EEEE`,
 *   `i`…`iiii`, `H` `HH`, `h` `hh`, `K` `KK`, `k` `kk`, `a`…`aaaa`, `m` `mm`,
 *   `s` `ss`, `S`…`SSSSSSSSS`, `X`…`XXX`, `x`…`xxx`, `'quoted text'` (`''` is
 *   a quote) and any non-letter as itself. Single-letter numeric tokens read
 *   1-2 digits, doubled ones exactly 2. `y` reads 1+ digits with an optional
 *   sign (an ISO year), `yy` is 2000-2099, `yyy` 3+ digits, `yyyy` exactly 4.
 *   Ordinals (`do`, `Mo`…), quarters, eras, week-numbering, zone names and the
 *   `P`/`p` presets are not parsed: they throw like any unknown letter.
 * - Bad text is returned, never thrown: an `InvalidDateText` failure whose
 *   `data.reason` is one of `DATE_TEXT_REASONS` (missing or leftover text, an
 *   unknown word, an invalid date or time such as Feb 30, hour 24 or minute
 *   60 — values are built with `overflow: 'reject'` — a weekday that does not
 *   match the date, two tokens that disagree, an offset out of range) and
 *   `data.input` is a bounded copy of the text. An unknown time zone name
 *   returns `UnknownTimeZone`.
 * - A bad pattern is the caller's bug and throws `RangeError` with the function
 *   name first: `h`/`K` without an AM/PM token, an unsupported pattern letter,
 *   a pattern with no year, month or day.
 * - `parseDate` needs a year plus month and day (or a day of year). Time
 *   tokens are read and validated, then dropped. `parseDateTime` fills missing
 *   time fields with zero. Both refuse offset tokens: an offset names an exact
 *   instant, so use `parseZoned`, which shows that instant in the given zone.
 *   Without an offset, `parseZoned` resolves the wall clock in the zone with
 *   `disambiguation` (default `'compatible'`, as `zoned` does).
 * - Default locale is `'en-US'`.
 */

import type { ZonedOptions } from './core.js';
import type { DateTextOperation, DateTextReason, UnknownTimeZone } from './failures.js';
import type { PlainDate, PlainDateTime, ZonedDateTime } from './types.js';
import { boundedInput, InvalidDateText, unknownTimeZone } from './failures.js';
import { format } from './format.js';
import { Temporal } from './types.js';
import { isValidTimeZone } from './zone.js';

/** Locale (BCP 47, default `'en-US'`) whose month, weekday and AM/PM words are accepted. */
export type ParseOptions = Readonly<{ locale?: string }>;

const DEFAULT_LOCALE = 'en-US';

type Operation = Exclude<DateTextOperation, 'parseISO'>;

/** Raised inside the readers for text the pattern refuses; the public doors turn it into a returned failure. */
class TextProblem extends Error {
  readonly reason: DateTextReason;

  constructor(reason: DateTextReason) {
    super(reason);
    this.name = 'TextProblem';
    this.reason = reason;
  }
}

/** Raw values read from the text, before they are combined and validated. */
type Field =
  | 'year'
  | 'month'
  | 'day'
  | 'dayOfYear'
  | 'weekday'
  | 'hour'
  | 'hour24'
  | 'hour12'
  | 'hour11'
  | 'period'
  | 'minute'
  | 'second'
  | 'fraction'
  | 'offset';

type Fields = Partial<Record<Field, number>>;

type Reader = (text: string, at: number, fields: Fields) => number | undefined;

/** One pattern piece: what it expects (for errors) and how to read it (returns the end position, or undefined). */
type Matcher = Readonly<{ expected: string; read: Reader }>;

type Plan = Readonly<{
  operation: Operation;
  pattern: string;
  matchers: readonly Matcher[];
  letters: ReadonlySet<string>;
}>;

// ---------------------------------------------------------------------------
// matchers

function assign(fields: Fields, field: Field, value: number): void {
  const previous = fields[field];
  if (previous !== undefined && previous !== value) throw new TextProblem('conflicting_tokens');
  fields[field] = value;
}

/** Text matching the regular expression `source` at the current position. */
function regex(source: string, expected: string, apply: (match: string, fields: Fields) => void): Matcher {
  const sticky = new RegExp(source, 'y');
  return {
    expected,
    read: (text, at, fields) => {
      sticky.lastIndex = at;
      const match = sticky.exec(text);
      if (match === null) return;
      apply(match[0], fields);
      return at + match[0].length;
    },
  };
}

function digits(
  source: string,
  expected: string,
  field: Field,
  map: (value: number) => number = value => value,
): Matcher {
  return regex(source, expected, (match, fields) => {
    assign(fields, field, map(Number(match)));
  });
}

/** 1-2 digits for a single letter, exactly 2 for a doubled one. */
function oneOrTwo(token: string, what: string, field: Field): Matcher {
  return token.length === 1
    ? digits(String.raw`\d{1,2}`, `a 1-2 digit ${what}`, field)
    : digits(String.raw`\d{2}`, `a 2-digit ${what}`, field);
}

/** One of `words` (case-insensitive, longest first so a prefix never wins). */
function words(
  entries: readonly (readonly [string, number])[],
  expected: string,
  field: Field,
  token: string,
  locale: string,
): Matcher {
  const candidates = entries
    .map(([word, value]): readonly [string, number] => [word.toLocaleLowerCase(locale), value])
    .sort((left, right) => right[0].length - left[0].length);
  return {
    expected: `${expected} for "${token}"`,
    read: (text, at, fields) => {
      for (const [word, value] of candidates) {
        if (text.slice(at, at + word.length).toLocaleLowerCase(locale) === word) {
          assign(fields, field, value);
          return at + word.length;
        }
      }
      return;
    },
  };
}

function literal(text: string): Matcher {
  return {
    expected: JSON.stringify(text),
    read: (input, at) => (input.startsWith(text, at) ? at + text.length : undefined),
  };
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

/** The words `format` prints for `token`, so parsing accepts exactly what formatting produces. */
function monthWords(token: string, locale: string): (readonly [string, number])[] {
  return range(1, 12).map(month => [
    format(Temporal.PlainDate.from({ year: 2000, month, day: 1 }), token, { locale }),
    month,
  ]);
}

/** ISO weekdays: 2000-01-03 was a Monday. */
function weekdayWords(token: string, locale: string): (readonly [string, number])[] {
  return range(1, 7).map(weekday => [
    format(Temporal.PlainDate.from({ year: 2000, month: 1, day: 2 + weekday }), token, { locale }),
    weekday,
  ]);
}

function periodWords(token: string, locale: string): (readonly [string, number])[] {
  return [0, 1].map(period => [
    format(Temporal.PlainDateTime.from({ year: 2000, month: 1, day: 1, hour: period === 0 ? 9 : 15 }), token, {
      locale,
    }),
    period,
  ]);
}

const OFFSET_SOURCES: Readonly<Record<number, string>> = {
  1: String.raw`[+-]\d{2}(?:\d{2})?`,
  2: String.raw`[+-]\d{4}`,
  3: String.raw`[+-]\d{2}:\d{2}`,
};

function offsetMatcher(token: string): Matcher | undefined {
  const source = OFFSET_SOURCES[token.length];
  if (source === undefined) return undefined;
  const allowsZ = token.charAt(0) === 'X';
  const shape = token.length === 3 ? '+02:00' : token.length === 2 ? '+0200' : '+02';
  return regex(
    allowsZ ? `Z|${source}` : source,
    `an offset like ${shape}${allowsZ ? ' or Z' : ''} for "${token}"`,
    (match, fields) => {
      if (match === 'Z') {
        assign(fields, 'offset', 0);
        return;
      }
      const numbers = match.slice(1).replace(':', '');
      const hours = Number(numbers.slice(0, 2));
      const minutes = numbers.length > 2 ? Number(numbers.slice(2)) : 0;
      if (hours > 23 || minutes > 59) throw new TextProblem('offset_out_of_range');
      assign(fields, 'offset', (match.startsWith('-') ? -1 : 1) * (hours * 60 + minutes));
    },
  );
}

function yearMatcher(token: string): Matcher {
  switch (token.length) {
    case 1: {
      return digits(String.raw`[+-]?\d+`, 'a year', 'year');
    }
    case 2: {
      return digits(String.raw`\d{2}`, 'a 2-digit year', 'year', value => 2000 + value);
    }
    case 3: {
      return digits(String.raw`\d{3,}`, 'a year of 3+ digits', 'year');
    }
    default: {
      return digits(String.raw`\d{${token.length}}`, `a ${token.length}-digit year`, 'year');
    }
  }
}

function tokenMatcher(token: string, locale: string): Matcher | undefined {
  const length = token.length;
  switch (token.charAt(0)) {
    case 'y': {
      return yearMatcher(token);
    }
    case 'M':
    case 'L': {
      if (length <= 2) return oneOrTwo(token, 'month', 'month');
      if (length <= 4) return words(monthWords(token, locale), 'a month name', 'month', token, locale);
      return undefined;
    }
    case 'd': {
      return length <= 2 ? oneOrTwo(token, 'day', 'day') : undefined;
    }
    case 'D': {
      if (length === 1) return digits(String.raw`\d{1,3}`, 'a 1-3 digit day of year', 'dayOfYear');
      if (length === 3) return digits(String.raw`\d{3}`, 'a 3-digit day of year', 'dayOfYear');
      return undefined;
    }
    case 'E': {
      return length <= 4 ? words(weekdayWords(token, locale), 'a weekday name', 'weekday', token, locale) : undefined;
    }
    case 'i': {
      if (length <= 2) return oneOrTwo(token, 'weekday number', 'weekday');
      return length <= 4 ? words(weekdayWords(token, locale), 'a weekday name', 'weekday', token, locale) : undefined;
    }
    case 'a': {
      return length <= 4 ? words(periodWords(token, locale), 'AM or PM', 'period', token, locale) : undefined;
    }
    case 'H': {
      return length <= 2 ? oneOrTwo(token, 'hour', 'hour') : undefined;
    }
    case 'k': {
      return length <= 2 ? oneOrTwo(token, 'hour', 'hour24') : undefined;
    }
    case 'h': {
      return length <= 2 ? oneOrTwo(token, 'hour', 'hour12') : undefined;
    }
    case 'K': {
      return length <= 2 ? oneOrTwo(token, 'hour', 'hour11') : undefined;
    }
    case 'm': {
      return length <= 2 ? oneOrTwo(token, 'minute', 'minute') : undefined;
    }
    case 's': {
      return length <= 2 ? oneOrTwo(token, 'second', 'second') : undefined;
    }
    case 'S': {
      if (length > 9) return undefined;
      // Right-padded to nanoseconds: "5" for "S" is 500 ms.
      return regex(String.raw`\d{${length}}`, `${length} fraction digit(s) for "${token}"`, (match, fields) => {
        assign(fields, 'fraction', Number(match.padEnd(9, '0')));
      });
    }
    case 'X':
    case 'x': {
      return offsetMatcher(token);
    }
    default: {
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// pattern compilation (same tokenizer grammar as `format`)

const TOKENS = /[yYQqMLwIdDecihHKkms]o|(\w)\1*|''|'(?:''|[^'])+(?:'|$)|./g;
const ESCAPED = /^'([\s\S]*?)'?$/;
const DOUBLE_QUOTE = /''/g;
const LATIN_LETTER = /[a-z]/i;

function unquote(chunk: string): string {
  const inner = ESCAPED.exec(chunk);
  return (inner?.[1] ?? chunk).replaceAll(DOUBLE_QUOTE, "'");
}

function compile(operation: Operation, pattern: string, options: ParseOptions | undefined): Plan {
  const locale = options?.locale ?? DEFAULT_LOCALE;
  const matchers: Matcher[] = [];
  const letters = new Set<string>();
  for (const chunk of pattern.match(TOKENS) ?? []) {
    if (chunk === "''") {
      matchers.push(literal("'"));
    } else if (chunk.startsWith("'")) {
      matchers.push(literal(unquote(chunk)));
    } else if (LATIN_LETTER.test(chunk.charAt(0))) {
      // Ordinal forms (`do`, `Mo`, …) are not parsed.
      const matcher = chunk.endsWith('o') ? undefined : tokenMatcher(chunk, locale);
      if (matcher === undefined) {
        throw new RangeError(`${operation}: unsupported pattern token "${chunk}"; wrap literal text in single quotes`);
      }
      matchers.push(matcher);
      letters.add(chunk.charAt(0));
    } else {
      matchers.push(literal(chunk));
    }
  }
  const plan: Plan = { operation, pattern, matchers, letters };
  checkPattern(plan);
  return plan;
}

function has(plan: Plan, ...letters: string[]): boolean {
  return letters.some(letter => plan.letters.has(letter));
}

function checkPattern(plan: Plan): void {
  const { operation, pattern } = plan;
  if (!has(plan, 'y')) throw new RangeError(`${operation}: pattern "${pattern}" has no year token (y)`);
  if (has(plan, 'D')) {
    if (has(plan, 'M', 'L', 'd')) {
      throw new RangeError(`${operation}: pattern "${pattern}" mixes day of year (D) with month or day tokens`);
    }
  } else {
    if (!has(plan, 'M', 'L')) throw new RangeError(`${operation}: pattern "${pattern}" has no month token (M or L)`);
    if (!has(plan, 'd')) throw new RangeError(`${operation}: pattern "${pattern}" has no day token (d)`);
  }
  if (has(plan, 'h', 'K') && !has(plan, 'a')) {
    throw new RangeError(`${operation}: pattern "${pattern}" uses a 12-hour token (h or K) without an AM/PM token (a)`);
  }
  if (operation !== 'parseZoned' && has(plan, 'X', 'x')) {
    throw new RangeError(
      `${operation}: pattern "${pattern}" has an offset token, which names an exact instant; use parseZoned`,
    );
  }
}

// ---------------------------------------------------------------------------
// reading and building

function readFields(plan: Plan, text: string): Fields {
  const fields: Fields = {};
  let at = 0;
  for (const matcher of plan.matchers) {
    const next = matcher.read(text, at, fields);
    if (next === undefined) throw new TextProblem('no_match');
    at = next;
  }
  if (at < text.length) throw new TextProblem('trailing_text');
  return fields;
}

/** Runs a Temporal constructor; its `RangeError` means the text named a value that does not exist. */
function build<T>(reason: DateTextReason, construct: () => T): T {
  try {
    return construct();
  } catch (error) {
    if (error instanceof RangeError) throw new TextProblem(reason);
    throw error;
  }
}

function two(value: number): string {
  return String(value).padStart(2, '0');
}

function toDate(fields: Fields): PlainDate {
  const { year = 0, dayOfYear } = fields;
  let date: PlainDate;
  if (dayOfYear === undefined) {
    const { month = 0, day = 0 } = fields;
    date = build('invalid_date', () => Temporal.PlainDate.from({ year, month, day }, { overflow: 'reject' }));
  } else {
    const first = build('invalid_date', () =>
      Temporal.PlainDate.from({ year, month: 1, day: 1 }, { overflow: 'reject' }),
    );
    if (dayOfYear < 1 || dayOfYear > first.daysInYear) throw new TextProblem('invalid_date');
    date = first.add({ days: dayOfYear - 1 });
  }
  if (fields.weekday !== undefined && fields.weekday !== date.dayOfWeek) throw new TextProblem('weekday_mismatch');
  return date;
}

/** The 0-23 hour each hour token implies; every one present must agree. */
function hourOf(fields: Fields): number {
  const { hour, hour24, hour12, hour11, period } = fields;
  const pm = period === 1;
  const readings: number[] = [];
  if (hour !== undefined) readings.push(hour);
  if (hour24 !== undefined) {
    if (hour24 < 1 || hour24 > 24) throw new TextProblem('invalid_time');
    readings.push(hour24 % 24);
  }
  if (hour12 !== undefined) {
    if (hour12 < 1 || hour12 > 12) throw new TextProblem('invalid_time');
    readings.push((hour12 % 12) + (pm ? 12 : 0));
  }
  if (hour11 !== undefined) {
    if (hour11 > 11) throw new TextProblem('invalid_time');
    readings.push(hour11 + (pm ? 12 : 0));
  }
  const [first = 0] = readings;
  if (readings.some(reading => reading !== first) || (period !== undefined && first >= 12 !== pm)) {
    throw new TextProblem('conflicting_tokens');
  }
  return first;
}

function toTime(fields: Fields): Temporal.PlainTime {
  const hour = hourOf(fields);
  const { minute = 0, second = 0, fraction = 0 } = fields;
  return build('invalid_time', () =>
    Temporal.PlainTime.from(
      {
        hour,
        minute,
        second,
        millisecond: Math.trunc(fraction / 1_000_000),
        microsecond: Math.trunc(fraction / 1000) % 1000,
        nanosecond: fraction % 1000,
      },
      { overflow: 'reject' },
    ),
  );
}

function toDateTime(fields: Fields): PlainDateTime {
  return toDate(fields).toPlainDateTime(toTime(fields));
}

function offsetId(minutes: number): string {
  const absolute = Math.abs(minutes);
  return `${minutes < 0 ? '-' : '+'}${two(Math.trunc(absolute / 60))}:${two(absolute % 60)}`;
}

function toZoned(fields: Fields, timeZone: string, options: ZonedOptions | undefined): ZonedDateTime {
  const wall = toDateTime(fields);
  if (fields.offset !== undefined) return wall.toZonedDateTime(offsetId(fields.offset)).withTimeZone(timeZone);
  return build('invalid_wall_time', () =>
    wall.toZonedDateTime(timeZone, { disambiguation: options?.disambiguation ?? 'compatible' }),
  );
}

/** The failure for text the pattern refused; anything else (a bug) keeps throwing. */
function refused(operation: Operation, text: string, error: unknown): InvalidDateText {
  if (error instanceof TextProblem) return InvalidDateText({ operation, reason: error.reason, ...boundedInput(text) });
  throw error;
}

// ---------------------------------------------------------------------------
// public API

/**
 * A calendar date read from `text` laid out by `pattern`, e.g.
 * `parseDate('Mar 5, 2026', 'MMM d, yyyy')`, or an `InvalidDateText` failure. The pattern needs a year and a
 * month + day (or a day of year `D`). Time tokens are read, validated and
 * dropped; offset tokens are refused (use `parseZoned`). A bad pattern throws.
 */
export function parseDate(text: string, pattern: string, options?: ParseOptions): PlainDate | InvalidDateText {
  const plan = compile('parseDate', pattern, options);
  try {
    const fields = readFields(plan, text);
    toTime(fields);
    return toDate(fields);
  } catch (error) {
    return refused('parseDate', text, error);
  }
}

/**
 * A wall-clock date and time read from `text` laid out by `pattern`, e.g.
 * `parseDateTime('03/05/2026 9:30 PM', 'MM/dd/yyyy h:mm a')`, or an `InvalidDateText` failure. Missing time
 * fields are zero; offset tokens are refused (use `parseZoned`). A bad pattern throws.
 */
export function parseDateTime(text: string, pattern: string, options?: ParseOptions): PlainDateTime | InvalidDateText {
  const plan = compile('parseDateTime', pattern, options);
  try {
    return toDateTime(readFields(plan, text));
  } catch (error) {
    return refused('parseDateTime', text, error);
  }
}

/**
 * A moment in `timeZone` read from `text` laid out by `pattern`, or an
 * `InvalidDateText` failure, or `UnknownTimeZone` when the runtime does not
 * know `timeZone`. With an offset token (`X`, `x`…) the text names an exact
 * instant, which is shown in `timeZone`. Without one, the text is a wall-clock
 * time in `timeZone`; skipped or repeated times resolve with `disambiguation`
 * (default `'compatible'`, and `'reject'` returns `invalid_wall_time`). A bad pattern throws.
 */
export function parseZoned(
  text: string,
  pattern: string,
  timeZone: string,
  options?: ParseOptions & ZonedOptions,
): ZonedDateTime | InvalidDateText | UnknownTimeZone {
  const plan = compile('parseZoned', pattern, options);
  if (!isValidTimeZone(timeZone)) return unknownTimeZone(timeZone);
  try {
    return toZoned(readFields(plan, text), timeZone, options);
  } catch (error) {
    return refused('parseZoned', text, error);
  }
}
