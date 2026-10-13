/**
 * Lenient ISO 8601 text, shared by `parseISO` in core.
 */

import { Temporal } from '../types.js';
import { daysFromCivil, daysInMonthOf, MS_PER_DAY } from './civil.js';
import { epochFromWall } from './offsets.js';

const DATE_TIME_DELIMITER = /[T ]/;
const TIME_ZONE_DELIMITER = /[Z ]/i;
const TIME_ZONE = /([Z+-].*)$/;
const YEAR = /^(?:(\d{4}|[+-]\d{6})|(\d{2}|[+-]\d{4})$)/;
const DATE = /^-?(?:(\d{3})|(\d{2})(?:-?(\d{2}))?|W(\d{2})(?:-?(\d))?)?$/;
const TIME = /^(\d{2}(?:[.,]\d*)?)(?::?(\d{2}(?:[.,]\d*)?))?(?::?(\d{2}(?:[.,]\d*)?))?$/;
const OFFSET = /^([+-])(\d{2})(?::?(\d{2}))?$/;

const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;

type Pieces = { date?: string; time?: string; zone?: string };

function splitText(text: string): Pieces {
  const pieces: Pieces = {};
  const array = text.split(DATE_TIME_DELIMITER);
  if (array.length > 2) return pieces;
  let timeText: string | undefined;
  const first = array[0] ?? '';
  if (first.includes(':')) {
    timeText = first;
  } else {
    pieces.date = first;
    timeText = array[1];
    if (TIME_ZONE_DELIMITER.test(first)) {
      pieces.date = text.split(TIME_ZONE_DELIMITER)[0] ?? '';
      timeText = text.slice(pieces.date.length);
    }
  }
  if (timeText !== undefined && timeText !== '') {
    const zone = TIME_ZONE.exec(timeText)?.[1];
    if (zone === undefined) {
      pieces.time = timeText;
    } else {
      pieces.time = timeText.replace(zone, '');
      pieces.zone = zone;
    }
  }
  return pieces;
}

function parseYear(text: string): { year: number; rest: string } {
  const captures = YEAR.exec(text);
  if (captures === null) return { year: Number.NaN, rest: '' };
  const full = captures[1];
  const century = captures[2];
  if (full !== undefined) return { year: Number.parseInt(full, 10), rest: text.slice(full.length) };
  const head = century ?? '';
  return { year: Number.parseInt(head, 10) * 100, rest: text.slice(head.length) };
}

function dateUnit(value: string | undefined): number {
  return value === undefined ? 1 : Number.parseInt(value, 10);
}

function parseIsoDate(rest: string, year: number): Temporal.PlainDate | undefined {
  const captures = DATE.exec(rest);
  if (captures === null || Number.isNaN(year)) return undefined;
  const dayOfYear = dateUnit(captures[1]);
  const month = dateUnit(captures[2]);
  const day = dateUnit(captures[3]);
  if (captures[4] !== undefined) {
    const week = dateUnit(captures[4]);
    const weekday = dateUnit(captures[5]);
    if (week < 1 || week > 53 || weekday < 1 || weekday > 7) return undefined;
    // Week 1 is the week containing January 4; week 53 of a 52-week year rolls into the next year.
    const january4 = Temporal.PlainDate.from({ year, month: 1, day: 4 });
    return january4.add({ days: (week - 1) * 7 + weekday - january4.dayOfWeek });
  }
  if (month < 1 || month > 12 || day < 1 || dayOfYear < 1) return undefined;
  const first = Temporal.PlainDate.from({ year, month, day: 1 });
  if (day > first.daysInMonth || dayOfYear > first.daysInYear) return undefined;
  return first.add({ days: Math.max(dayOfYear, day) - 1 });
}

function timeUnit(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number.parseFloat(value.replace(',', '.'));
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Milliseconds since midnight (fractional, exactly as date-fns computes it), or NaN. */
function parseTime(text: string): number {
  const captures = TIME.exec(text);
  if (captures === null) return Number.NaN;
  const hours = timeUnit(captures[1]);
  const minutes = timeUnit(captures[2]);
  const seconds = timeUnit(captures[3]);
  const valid =
    hours === 24
      ? minutes === 0 && seconds === 0
      : seconds >= 0 && seconds < 60 && minutes >= 0 && minutes < 60 && hours >= 0 && hours < 25;
  if (!valid) return Number.NaN;
  return hours * MS_PER_HOUR + minutes * MS_PER_MINUTE + seconds * 1000;
}

/** Milliseconds to ADD to the wall-clock reading to reach UTC, or NaN. An unrecognised suffix counts as UTC (date-fns quirk). */
function parseOffset(text: string): number {
  if (text === 'Z') return 0;
  const captures = OFFSET.exec(text);
  if (captures === null) return 0;
  const sign = captures[1] === '+' ? -1 : 1;
  const hours = Number.parseInt(captures[2] ?? '0', 10);
  const minutes = captures[3] === undefined ? 0 : Number.parseInt(captures[3], 10);
  if (minutes < 0 || minutes > 59) return Number.NaN;
  return sign * (hours * MS_PER_HOUR + minutes * MS_PER_MINUTE);
}

/**
 * Lenient ISO 8601 reader (the date-fns `parseISO` grammar): calendar, week
 * and ordinal dates, basic and extended forms, fractional last time unit,
 * `24:00`, `Z`/`±HH[:MM]` offsets. Zone-less text is a wall-clock reading in
 * `timeZone`. Returns `undefined` for text the grammar rejects.
 */
export function readLenientISO(text: string, timeZone: string): Temporal.Instant | undefined {
  const pieces = splitText(text);
  if (pieces.date === undefined || pieces.date === '') return undefined;
  const { year, rest } = parseYear(pieces.date);
  let date: Temporal.PlainDate | undefined;
  try {
    date = parseIsoDate(rest, year);
  } catch (error) {
    // Temporal rejects years outside ±271821 with a RangeError: not ISO text we can represent.
    if (error instanceof RangeError) return undefined;
    throw error;
  }
  if (date === undefined) return undefined;

  const timestamp = date.toZonedDateTime('UTC').epochMilliseconds;
  let time = 0;
  if (pieces.time !== undefined && pieces.time !== '') {
    time = parseTime(pieces.time);
    if (Number.isNaN(time)) return undefined;
  }

  if (pieces.zone !== undefined) {
    const offset = parseOffset(pieces.zone);
    if (Number.isNaN(offset)) return undefined;
    return Temporal.Instant.fromEpochMilliseconds(Math.trunc(timestamp + time + offset));
  }

  // Zone-less: the fields are a wall-clock reading in `timeZone`.
  const wall = Temporal.Instant.fromEpochMilliseconds(Math.trunc(timestamp + time))
    .toZonedDateTimeISO('UTC')
    .toPlainDateTime();
  return wall.toZonedDateTime(timeZone).toInstant();
}

// ---------------------------------------------------------------------------
// fast path

/** The digit at `index`, or -1 (also past the end). */
function digitAt(text: string, index: number): number {
  const value = (text.codePointAt(index) ?? -1) - 48;
  return value >= 0 && value <= 9 ? value : -1;
}

function twoDigitsAt(text: string, index: number): number {
  const tens = digitAt(text, index);
  const ones = digitAt(text, index + 1);
  return tens < 0 || ones < 0 ? -1 : tens * 10 + ones;
}

/** `±HH`, `±HHMM` or `±HH:MM` from `index` to the end: milliseconds to add to reach UTC, or `undefined`. */
function readOffset(text: string, index: number): number | undefined {
  const sign = text.charAt(index);
  if (sign !== '+' && sign !== '-') return undefined;
  const hours = twoDigitsAt(text, index + 1);
  if (hours < 0) return undefined;
  let minutes = 0;
  const rest = text.length - (index + 3);
  if (rest === 3 && text.charAt(index + 3) === ':') minutes = twoDigitsAt(text, index + 4);
  else if (rest === 2) minutes = twoDigitsAt(text, index + 3);
  else if (rest !== 0) return undefined;
  if (minutes < 0 || minutes > 59) return undefined;
  return (sign === '+' ? -1 : 1) * (hours * MS_PER_HOUR + minutes * MS_PER_MINUTE);
}

/**
 * The common ISO 8601 shapes — `YYYY-MM-DD`, optionally followed by `T` or a
 * space, `HH:MM`, `:SS`, a `.`/`,` fraction and `Z` or `±HH[[:]MM]` — read
 * with plain arithmetic. Returns epoch milliseconds, or `undefined` for any
 * other text; the caller then uses `readLenientISO`, so every answer equals
 * the lenient reader's (same validation, same fraction arithmetic).
 */
export function readCommonISO(text: string, timeZone: () => string): number | undefined {
  const length = text.length;
  if (length < 10 || text.charAt(4) !== '-' || text.charAt(7) !== '-') return undefined;
  const century = twoDigitsAt(text, 0);
  const yearOfCentury = twoDigitsAt(text, 2);
  const month = twoDigitsAt(text, 5);
  const day = twoDigitsAt(text, 8);
  if (century < 0 || yearOfCentury < 0 || month < 1 || month > 12 || day < 1) return undefined;
  const year = century * 100 + yearOfCentury;
  if (day > daysInMonthOf(year, month)) return undefined;
  const date = daysFromCivil(year, month, day) * MS_PER_DAY;

  let time = 0;
  let index = 10;
  if (length > 10) {
    const separator = text.charAt(10);
    if ((separator !== 'T' && separator !== ' ') || text.charAt(13) !== ':') return undefined;
    const hours = twoDigitsAt(text, 11);
    const minutes = twoDigitsAt(text, 14);
    if (hours < 0 || minutes < 0) return undefined;
    let seconds = 0;
    index = 16;
    if (text.charAt(16) === ':') {
      seconds = twoDigitsAt(text, 17);
      if (seconds < 0) return undefined;
      index = 19;
      const mark = text.charAt(19);
      if (mark === '.' || mark === ',') {
        index = 20;
        while (digitAt(text, index) >= 0) index++;
        if (index === 20) return undefined;
        // The lenient reader's arithmetic exactly: parse "SS.fff" as one float.
        seconds = Number.parseFloat(text.slice(17, index).replace(',', '.'));
      }
    }
    const valid = hours === 24 ? minutes === 0 && seconds === 0 : seconds < 60 && minutes < 60 && hours < 25;
    if (!valid) return undefined;
    time = hours * MS_PER_HOUR + minutes * MS_PER_MINUTE + seconds * 1000;
  }

  if (index === length) return epochFromWall(timeZone(), Math.trunc(date + time));
  if (text.charAt(index) === 'Z') return index + 1 === length ? Math.trunc(date + time) : undefined;
  const offset = readOffset(text, index);
  return offset === undefined ? undefined : Math.trunc(date + time + offset);
}
