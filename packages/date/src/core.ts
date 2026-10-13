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
import { readCommonISO, readLenientISO } from './internal/iso.js';
import { systemTimeZone } from './internal/system-zone.js';
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
 * - `zoned('2026-03-29T03:30+03:00[Europe/Bucharest]')` — a string with a `[Zone]` annotation.
 * - `zoned('2026-03-29T00:30:00Z', 'Europe/Bucharest')` — an exact timestamp shown in a zone;
 *   `zoned('2026-03-29T03:30', 'Europe/Bucharest')` — a wall-clock time in that zone.
 * - `zoned({ year, month, day, hour, minute }, 'Europe/Bucharest')` — wall-clock fields in a zone.
 * - `zoned(plainDate, zone)` — first valid time of that day; `zoned(instant | Date, zone)` — projection.
 *
 * Skipped or repeated wall times resolve with Temporal's `compatible` rule by default.
 */
export function zoned(input: string | ZonedDateTime, options?: ZonedOptions): ZonedDateTime;
export function zoned(
  input: string | WallInput | PlainDateTime | PlainDate | Instant | ZonedDateTime | Date,
  timeZone: string,
  options?: ZonedOptions,
): ZonedDateTime;
export function zoned(
  input: string | ZonedDateTime | WallInput | PlainDateTime | PlainDate | Instant | Date,
  timeZoneOrOptions?: string | ZonedOptions,
  maybeOptions?: ZonedOptions,
): ZonedDateTime {
  if (typeof timeZoneOrOptions === 'string' && (typeof input === 'string' || isZonedDateTime(input))) {
    // Explicit zone: an exact string/zoned value is projected into it; a
    // zone-less wall-clock string is read as local time in that zone.
    const timeZone = timeZoneOrOptions;
    if (isZonedDateTime(input)) return input.withTimeZone(timeZone);
    if (HAS_ZONE_ANNOTATION.test(input)) return Temporal.ZonedDateTime.from(input, maybeOptions).withTimeZone(timeZone);
    if (HAS_OFFSET_OR_ZONE.test(input)) return Temporal.Instant.from(input).toZonedDateTimeISO(timeZone);
    return Temporal.PlainDateTime.from(input).toZonedDateTime(timeZone, maybeOptions);
  }
  if (typeof input === 'string' || isZonedDateTime(input)) {
    if (typeof input === 'string') {
      if (!HAS_ZONE_ANNOTATION.test(input)) {
        throw new RangeError(
          `zoned() needs a zone for "${input}": either a [TimeZone] annotation in the string or a second argument, e.g. zoned(text, 'Europe/Bucharest')`,
        );
      }
      return Temporal.ZonedDateTime.from(input, typeof timeZoneOrOptions === 'string' ? undefined : timeZoneOrOptions);
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

export type ParseISOOptions = Readonly<{
  /** Zone for text without an offset. Default: the runtime zone. */
  timeZone?: string;
}>;

/**
 * Read lenient ISO 8601 text — everything `instant()` accepts plus the forms
 * people actually send: `2026-05-20` (midnight), `2026-05`, `2026`, basic
 * `20260520T1030`, week dates `2026-W41-5`, ordinal dates `2026-283`, a
 * fraction on the last time unit, `24:00`, `±HH` offsets.
 *
 * Text without an offset is a wall-clock reading in `options.timeZone`
 * (default: the runtime zone), resolved with the `'compatible'` DST rule.
 * Anything else is a `RangeError`. For strict RFC 9557 text use `instant()`
 * or `zoned()`; for a calendar date use `plainDate()`.
 */
export function parseISO(text: string, options?: ParseISOOptions): Instant {
  const zone = (): string => options?.timeZone ?? systemTimeZone();
  const epochMs = readCommonISO(text, zone);
  if (epochMs !== undefined) return Temporal.Instant.fromEpochMilliseconds(epochMs);
  const result = readLenientISO(text, zone());
  if (result === undefined) throw new RangeError(`parseISO: "${text}" is not ISO 8601 date/time text`);
  return result;
}

export type ParseKinds = {
  plainDate: PlainDate;
  plainDateTime: PlainDateTime;
  zoned: ZonedDateTime;
  instant: Instant;
  duration: Duration;
  /** Lenient ISO text via `parseISO`. */
  iso: Instant;
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
    iso: input => parseISO(input),
  };
  return parsers[kind](text);
}
