/**
 * Timestamp assertions that accept every moment type an app stores
 *
 * Apps hold timestamps as `Date` (Drizzle `timestamp`) or as `@arki/date`
 * Temporal values (`Instant`, or `ZonedDateTime`). These helpers read all three
 * through their exact epoch in nanoseconds, so they never lose precision and
 * never depend on a time zone.
 */

import type { Timeline } from '@arki/date/types';
import { isInstant, isZonedDateTime } from '@arki/date/types';

/** A moment in time: a `Date`, or a Temporal `Instant` or `ZonedDateTime`. */
export type Timestamp = Date | Timeline;

/** An object with the two timestamps every table row carries. */
export type Timestamps = { createdAt: Timestamp; updatedAt: Timestamp };

const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/** Whether a value is a `Date` (not `Invalid Date`), `Instant` or `ZonedDateTime`. */
export function isTimestamp(value: unknown): value is Timestamp {
  return isValidDate(value) || isInstant(value) || isZonedDateTime(value);
}

/** Name the kind of a value that failed `isTimestamp`, for an error message. */
export function describeKind(value: unknown): string {
  if (value instanceof Date) {
    return 'an invalid Date';
  }

  return typeof value;
}

/** The exact epoch of a timestamp in nanoseconds, whatever its kind. */
export function epochNanoseconds(value: Timestamp): bigint {
  return value instanceof Date ? BigInt(value.getTime()) * NANOSECONDS_PER_MILLISECOND : value.epochNanoseconds;
}

/** The epoch of a timestamp in whole milliseconds, rounded toward the past. */
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
  if (!obj || typeof obj !== 'object') {
    throw new Error('Expected object with timestamps');
  }

  const createdAt = 'createdAt' in obj ? obj.createdAt : undefined;
  if (!isTimestamp(createdAt)) {
    throw new TypeError(`Expected createdAt to be a Date, Instant or ZonedDateTime, got ${describeKind(createdAt)}`);
  }

  const updatedAt = 'updatedAt' in obj ? obj.updatedAt : undefined;
  if (!isTimestamp(updatedAt)) {
    throw new TypeError(`Expected updatedAt to be a Date, Instant or ZonedDateTime, got ${describeKind(updatedAt)}`);
  }
}

/**
 * Assert that updatedAt is greater than or equal to createdAt.
 *
 * @throws Error if updatedAt is before createdAt
 */
export function assertUpdatedAfterCreated(obj: Timestamps): void {
  if (epochNanoseconds(obj.updatedAt) < epochNanoseconds(obj.createdAt)) {
    throw new Error(
      `Expected updatedAt (${format(obj.updatedAt)}) to be >= createdAt (${format(obj.createdAt)})`,
    );
  }
}
