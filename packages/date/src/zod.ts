/**
 * Zod v4 schemas for the Temporal values this package returns.
 *
 * Every schema's INPUT accepts an ISO string or an already-built value, and
 * its OUTPUT is the Temporal value, so `z.input` / `z.infer` stay precise for
 * tRPC and oRPC consumers. Import from `@arki/date/zod`; `zod` is an optional
 * peer dependency.
 */

import { z } from 'zod';

import type { Interval } from './interval.js';
import type { Duration, Instant, PlainDate, PlainDateTime, Point, ZonedDateTime } from './types.js';
import { instant, plainDate, plainDateTime, zoned } from './core.js';
import { interval } from './interval.js';
import { isDuration, isInstant, isPlainDate, isPlainDateTime, isZonedDateTime, Temporal } from './types.js';

function describe(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : Object.prototype.toString.call(value);
}

function reason(error: unknown): string {
  return error instanceof Error ? ` (${error.message})` : '';
}

/** A string-or-value schema: `build` turns the input into the Temporal value or throws. */
function temporalSchema<T, I>(
  name: string,
  expected: string,
  accepts: (value: unknown) => value is I,
  build: (value: string | I) => T,
): z.ZodType<T, string | I> {
  return z
    .union([z.string(), z.custom<I>(accepts, { message: `Invalid ${name}: expected ${expected}` })])
    .transform((value, ctx) => {
      try {
        return build(value);
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          message: `Invalid ${name}: expected ${expected}, received ${describe(value)}${reason(error)}`,
        });
        return z.NEVER;
      }
    });
}

/** A calendar date: `'YYYY-MM-DD'` or a `PlainDate`. Output is a `PlainDate`. */
export function plainDateSchema(): z.ZodType<PlainDate, string | PlainDate> {
  return temporalSchema('PlainDate', 'YYYY-MM-DD or a PlainDate', isPlainDate, value => plainDate(value));
}

/** A zone-less date and time: `'YYYY-MM-DDTHH:mm[:ss]'` or a `PlainDateTime`. Output is a `PlainDateTime`. */
export function plainDateTimeSchema(): z.ZodType<PlainDateTime, string | PlainDateTime> {
  return temporalSchema('PlainDateTime', 'a zone-less ISO date-time or a PlainDateTime', isPlainDateTime, value =>
    plainDateTime(value),
  );
}

function isInstantOrDate(value: unknown): value is Instant | Date {
  return isInstant(value) || value instanceof Date;
}

/** An exact moment: an ISO string with `Z` or an offset, an `Instant`, or a `Date`. Output is an `Instant`. */
export function instantSchema(): z.ZodType<Instant, string | Instant | Date> {
  return temporalSchema('Instant', 'an ISO string with Z or an offset, an Instant, or a Date', isInstantOrDate, value =>
    instant(value),
  );
}

/**
 * An exact moment in a zone. Without `timeZone` a string must carry a `[Zone]`
 * annotation; with `timeZone` the value is read in (or projected into) that zone.
 */
export function zonedDateTimeSchema(options?: { timeZone?: string }): z.ZodType<ZonedDateTime, string | ZonedDateTime> {
  const timeZone = options?.timeZone;
  const expected =
    timeZone === undefined
      ? 'an ISO string with a [TimeZone] annotation or a ZonedDateTime'
      : `an ISO string or a ZonedDateTime, read in ${timeZone}`;
  return temporalSchema('ZonedDateTime', expected, isZonedDateTime, value =>
    timeZone === undefined ? zoned(value) : zoned(value, timeZone),
  );
}

/** A signed amount of time: an ISO 8601 duration such as `'P1DT2H'`, or a `Duration`. Output is a `Duration`. */
export function durationSchema(): z.ZodType<Duration, string | Duration> {
  return temporalSchema('Duration', 'an ISO 8601 duration such as P1DT2H or a Duration', isDuration, value =>
    Temporal.Duration.from(value),
  );
}

/** An IANA time zone id. Output is the canonical id (for example `'europe/bucharest'` becomes `'Europe/Bucharest'`). */
export function timeZoneSchema(): z.ZodType<string, string> {
  return z.string().transform((value, ctx) => {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: `Invalid time zone: expected an IANA id such as Europe/Bucharest, received ${describe(value)}`,
      });
      return z.NEVER;
    }
  });
}

/**
 * A half-open interval `{ start, end }` whose ends are parsed by `point`.
 * An `end` before `start` is an issue.
 */
export function intervalSchema<T extends Point>(
  point: z.ZodType<T, unknown>,
): z.ZodType<Interval<T>, { start: unknown; end: unknown }> {
  return z.object({ start: point, end: point }).transform((value, ctx) => {
    try {
      return interval(value.start, value.end);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: `Invalid interval: expected start not after end${reason(error)}`,
      });
      return z.NEVER;
    }
  });
}
