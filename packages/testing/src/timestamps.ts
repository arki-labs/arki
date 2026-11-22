/**
 * Timestamp assertions that accept every moment type an app stores
 *
 * Apps hold timestamps as `Date` (Drizzle `timestamp`) or as `@arki/date`
 * Temporal values (`Instant`, or `ZonedDateTime`). These helpers read all three
 * through their exact epoch in nanoseconds, so they never lose precision and
 * never depend on a time zone.
 */

import { z } from 'zod';

import { invariant } from '@arki/failure';
import type { Temporal } from '@arki/date/types';
import { is, recordSchema } from '@arki/schema';

import { timestampSchema } from './schemas.js';

/** A moment in time: a `Date`, or a Temporal `Instant` or `ZonedDateTime`. */
export type Timestamp = Date | Temporal.Instant | Temporal.ZonedDateTime;

/** An object with the two timestamps every table row carries. */
export type Timestamps = { createdAt: Timestamp; updatedAt: Timestamp };

const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

/** Whether a value is a `Date` (not `Invalid Date`), `Instant` or `ZonedDateTime`. */
export function isTimestamp(value: unknown): value is Timestamp {
  return is(value, timestampSchema);
}

/** Name the kind of a value that failed `isTimestamp`, for an error message. */
export function describeKind(value: unknown): string {
  if (is(value, z.instanceof(Date))) {
    return 'an invalid Date';
  }

  return typeof value;
}

/**
 * The exact epoch of a timestamp in nanoseconds, whatever its kind.
 *
 * @throws FailureError `ARKI_FAILURE_E008` (invariant) for an `Invalid Date`: it holds no moment. Check
 *   untrusted values with {@link isTimestamp} first.
 */
export function epochNanoseconds(value: Timestamp): bigint {
  if (!(value instanceof Date)) return value.epochNanoseconds;
  const milliseconds = value.getTime();
  invariant(!Number.isNaN(milliseconds), 'epochNanoseconds: the Date is an Invalid Date and holds no moment.');
  return BigInt(milliseconds) * NANOSECONDS_PER_MILLISECOND;
}

/**
 * The epoch of a timestamp in whole milliseconds, rounded toward the past.
 *
 * @throws FailureError `ARKI_FAILURE_E008` (invariant) for an `Invalid Date`, as {@link epochNanoseconds}.
 */
export function epochMilliseconds(value: Timestamp): number {
  const nanoseconds = epochNanoseconds(value);
  const milliseconds = nanoseconds / NANOSECONDS_PER_MILLISECOND;

  return Number(nanoseconds < 0n && nanoseconds % NANOSECONDS_PER_MILLISECOND !== 0n ? milliseconds - 1n : milliseconds);
}

function format(value: Timestamp): string {
  return value instanceof Date ? value.toISOString() : value.toString();
}

/**
 * Assert that an object has valid createdAt and updatedAt timestamps.
 *
 * @throws Error if the value is not an object, or a timestamp is missing, is not
 *   a `Date`, `Instant` or `ZonedDateTime`, or is an invalid `Date`
 */
export function assertTimestamps(obj: unknown): asserts obj is Timestamps {
  if (!is(obj, recordSchema)) {
    throw new Error('Expected object with timestamps');
  }

  const createdAt = obj['createdAt'];
  if (!isTimestamp(createdAt)) {
    throw new TypeError(`Expected createdAt to be a Date, Instant or ZonedDateTime, got ${describeKind(createdAt)}`);
  }

  const updatedAt = obj['updatedAt'];
  if (!isTimestamp(updatedAt)) {
    throw new TypeError(`Expected updatedAt to be a Date, Instant or ZonedDateTime, got ${describeKind(updatedAt)}`);
  }
}

/**
 * Assert that updatedAt is greater than or equal to createdAt.
 *
 * @throws Error if updatedAt is before createdAt
 * @throws FailureError `ARKI_FAILURE_E008` (invariant) if either is an `Invalid Date`
 */
export function assertUpdatedAfterCreated(obj: Timestamps): void {
  if (epochNanoseconds(obj.updatedAt) < epochNanoseconds(obj.createdAt)) {
    throw new Error(
      `Expected updatedAt (${format(obj.updatedAt)}) to be >= createdAt (${format(obj.createdAt)})`,
    );
  }
}
