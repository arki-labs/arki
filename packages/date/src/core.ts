/**
 * Construction and parsing. Every constructor is strict: it validates and
 * throws `RangeError` on bad input rather than returning an "invalid" value.
 * Use `tryParse` when a failure is expected (user input).
 */

import type {
  Civil,
  DateParts,
  Disambiguation,
  Duration,
  Instant,
  PlainDate,
  PlainDateTime,
  Point,
  Timeline,
  Wall,
  WallInput,
  ZonedDateTime,
} from './types.js';
import { isInstant, isPlainDate, isPlainDateTime, isZonedDateTime, Temporal } from './types.js';

const DATE_ONLY = /^[+-]?\d{4,6}-\d{2}-\d{2}$/;
const HAS_OFFSET_OR_ZONE = /(?:z|[+-]\d{2}(?::?\d{2})?|\[[^\]]+\])$/i;
const HAS_ZONE_ANNOTATION = /\[[^\]]+\]/;

/**
 * A calendar date. Accepts `YYYY-MM-DD` only — a timestamp string is rejected
 * so that a zone and time are never silently dropped. Pass a `ZonedDateTime`
 * when you really mean "the date this moment falls on in its zone".
 */
export function plainDate(input: string | DateParts | Civil): PlainDate {
  if (typeof input === 'string') {
    if (!DATE_ONLY.test(input)) {
      throw new RangeError(
        `plainDate expects a date-only ISO string (YYYY-MM-DD), received "${input}". Use instant()/zoned() for timestamps.`,
      );
    }
    return Temporal.PlainDate.from(input);
  }
  if (isPlainDate(input)) return input;
  if (isPlainDateTime(input) || isZonedDateTime(input)) return input.toPlainDate();
  return Temporal.PlainDate.from(input, { overflow: 'reject' });
}

/** A wall-clock date and time with no zone. Strings carrying an offset or zone are rejected. */
export function plainDateTime(input: string | WallInput | Wall): PlainDateTime {
  if (typeof input === 'string') {
    if (HAS_OFFSET_OR_ZONE.test(input)) {
      throw new RangeError(
        `plainDateTime expects a zone-less ISO string, received "${input}". Use zoned() or instant() for timestamps with an offset.`,
      );
    }
    return Temporal.PlainDateTime.from(input);
  }
  if (isPlainDateTime(input)) return input;
  if (isZonedDateTime(input)) return input.toPlainDateTime();
  return Temporal.PlainDateTime.from(input, { overflow: 'reject' });
}

/** An exact moment. Strings must carry `Z` or an offset; `Date` is copied by its epoch milliseconds. */
export function instant(input: string | Date | Timeline): Instant {
  if (typeof input === 'string') return Temporal.Instant.from(input);
  if (input instanceof Date) {
    const ms = input.getTime();
    if (Number.isNaN(ms)) throw new RangeError('instant() received an invalid Date');
    return Temporal.Instant.fromEpochMilliseconds(ms);
  }
  if (isInstant(input)) return input;
  return input.toInstant();
}

export type ZonedOptions = Readonly<{ disambiguation?: Disambiguation }>;

/**
 * An exact moment in a named zone.
 *
 * - `zoned('2026-03-29T03:30+03:00[Europe/Bucharest]')` — string must carry a `[Zone]` annotation.
 * - `zoned({ year, month, day, hour, minute }, 'Europe/Bucharest')` — wall-clock fields in a zone.
 * - `zoned(plainDate, zone)` — first valid time of that day; `zoned(instant | Date, zone)` — projection.
 *
 * Skipped or repeated wall times resolve with Temporal's `compatible` rule by default.
 */
export function zoned(input: string | ZonedDateTime, options?: ZonedOptions): ZonedDateTime;
export function zoned(
  input: WallInput | PlainDateTime | PlainDate | Instant | Date,
  timeZone: string,
  options?: ZonedOptions,
): ZonedDateTime;
export function zoned(
  input: string | ZonedDateTime | WallInput | PlainDateTime | PlainDate | Instant | Date,
  timeZoneOrOptions?: string | ZonedOptions,
  maybeOptions?: ZonedOptions,
): ZonedDateTime {
  if (typeof input === 'string' || isZonedDateTime(input)) {
    const options = typeof timeZoneOrOptions === 'string' ? maybeOptions : timeZoneOrOptions;
    if (typeof input === 'string') {
      if (!HAS_ZONE_ANNOTATION.test(input)) {
        throw new RangeError(
          `zoned() expects an ISO string with a [TimeZone] annotation, received "${input}". Pass the zone as the second argument to project an instant.`,
        );
      }
      return Temporal.ZonedDateTime.from(input, options);
    }
    return input;
  }
  if (typeof timeZoneOrOptions !== 'string') {
    throw new TypeError('zoned() needs a time zone as its second argument for this input');
  }
  const timeZone = timeZoneOrOptions;
  const options = maybeOptions;
  if (input instanceof Date) return instant(input).toZonedDateTimeISO(timeZone);
  if (isInstant(input)) return input.toZonedDateTimeISO(timeZone);
  if (isPlainDate(input)) return input.toZonedDateTime({ timeZone });
  if (isPlainDateTime(input)) return input.toZonedDateTime(timeZone, options);
  return Temporal.ZonedDateTime.from({ ...input, timeZone }, { overflow: 'reject', ...options });
}

/** Unix time in seconds (fractions allowed, kept to nanosecond precision). */
export function fromUnix(seconds: number): Instant {
  if (!Number.isFinite(seconds)) throw new RangeError(`fromUnix needs a finite number, received ${String(seconds)}`);
  return Temporal.Instant.fromEpochNanoseconds(BigInt(Math.round(seconds * 1_000_000_000)));
}

/** Unix time in whole milliseconds (the `Date.now()` convention). */
export function fromMillis(milliseconds: number): Instant {
  if (!Number.isSafeInteger(milliseconds)) {
    throw new RangeError(`fromMillis needs a safe integer, received ${String(milliseconds)}`);
  }
  return Temporal.Instant.fromEpochMilliseconds(milliseconds);
}

/** Whole seconds since the Unix epoch, floored. */
export function toUnix(value: Timeline): number {
  return Math.floor(value.epochMilliseconds / 1000);
}

/** Milliseconds since the Unix epoch (sub-millisecond precision is truncated). */
export function toMillis(value: Timeline): number {
  return value.epochMilliseconds;
}

export function toInstant(value: Timeline | Date): Instant {
  return instant(value);
}

/** The calendar date of a civil value (a `ZonedDateTime` yields its date in its own zone). */
export function toPlainDate(value: Civil): PlainDate {
  return plainDate(value);
}

/** ISO 8601 text (`toString()` of the value). */
export function toISO(value: Point | Duration): string {
  return value.toString();
}

export type ParseKinds = {
  plainDate: PlainDate;
  plainDateTime: PlainDateTime;
  zoned: ZonedDateTime;
  instant: Instant;
  duration: Duration;
};

export type ParseResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RangeError };

/** Parse without throwing. The `kind` is explicit so a string is never reinterpreted. */
export function tryParse<K extends keyof ParseKinds>(text: string, kind: K): ParseResult<ParseKinds[K]> {
  try {
    return { ok: true, value: parseKind(text, kind) };
  } catch (error) {
    return { ok: false, error: error instanceof RangeError ? error : new RangeError(String(error)) };
  }
}

function parseKind<K extends keyof ParseKinds>(text: string, kind: K): ParseKinds[K] {
  const parsers: { [P in keyof ParseKinds]: (input: string) => ParseKinds[P] } = {
    plainDate,
    plainDateTime,
    zoned: input => zoned(input),
    instant,
    duration: input => Temporal.Duration.from(input),
  };
  return parsers[kind](text);
}
