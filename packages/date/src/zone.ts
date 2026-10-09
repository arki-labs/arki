/**
 * Time-zone projection. Two deliberately different operations:
 * `inZone` keeps the instant and changes the wall clock;
 * `reinterpretZone` keeps the wall clock and changes the instant.
 */

import type { Disambiguation, PlainDate, Timeline, TimeParts, ZonedDateTime } from './types.js';
import { instant, plainDateTime } from './core.js';
import { Temporal } from './types.js';

/** The same instant, shown in another zone. */
export function inZone(value: Timeline | Date, timeZone: string): ZonedDateTime {
  return instant(value).toZonedDateTimeISO(timeZone);
}

/** The same instant in UTC. */
export function toUTC(value: Timeline | Date): ZonedDateTime {
  return inZone(value, 'UTC');
}

/** The same wall-clock fields, read as if they were in another zone (the instant changes). */
export function reinterpretZone(
  value: ZonedDateTime,
  timeZone: string,
  options?: Readonly<{ disambiguation?: Disambiguation }>,
): ZonedDateTime {
  return value.toPlainDateTime().toZonedDateTime(timeZone, options);
}

/** A calendar date at a wall-clock time in a zone. */
export function atTime(
  date: PlainDate,
  time: Partial<TimeParts>,
  timeZone: string,
  options?: Readonly<{ disambiguation?: Disambiguation }>,
): ZonedDateTime {
  return plainDateTime({ year: date.year, month: date.month, day: date.day, ...time }).toZonedDateTime(
    timeZone,
    options,
  );
}

/** The UTC offset as text, e.g. `+03:00`. */
export function offset(value: ZonedDateTime): string {
  return value.offset;
}

/** The UTC offset in minutes (east positive). */
export function offsetMinutes(value: ZonedDateTime): number {
  return value.offsetNanoseconds / 60_000_000_000;
}

/** Is this a time zone the runtime knows (IANA name or fixed offset)? */
export function isValidTimeZone(id: string): boolean {
  try {
    new Temporal.ZonedDateTime(0n, id);
    return true;
  } catch {
    return false;
  }
}
