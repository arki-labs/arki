/**
 * Fast path for ISO-calendar ZonedDateTime boundaries.
 *
 * Temporal reaches a zoned boundary through three objects (to a PlainDate, a
 * `with`, back to a ZonedDateTime), and on V8 each costs hundreds of
 * nanoseconds. This computes the boundary with integer calendar math and the
 * cached zone offsets, then builds exactly one ZonedDateTime. It returns
 * `undefined` whenever it would not match Temporal exactly (another calendar,
 * several transitions nearby, the edge of Temporal's range); the caller then
 * uses Temporal itself.
 *
 * `add` has no such path: it replaces a single Temporal call, and building the
 * result costs more than that call on V8.
 */

import type { CalendarUnit, WeekRules, ZonedDateTime } from '../types.js';
import { Temporal } from '../types.js';
import { bucketStart, zonedDays } from './buckets.js';
import { MS_PER_DAY } from './civil.js';
import { startOfDayEpoch } from './offsets.js';

/** Stay two days inside Temporal's ±8.64e15 ms range, where its own rules change. */
const LIMIT_MS = 8.64e15 - 2 * MS_PER_DAY;

function within(epochMs: number | undefined): epochMs is number {
  return epochMs !== undefined && Math.abs(epochMs) <= LIMIT_MS;
}

/** `startOf(value, unit)` for a calendar unit: the first moment of that day, week, month, quarter or year. */
export function startOfZoned(value: ZonedDateTime, unit: CalendarUnit, rules: WeekRules): ZonedDateTime | undefined {
  if (value.calendarId !== 'iso8601') return undefined;
  const zone = value.timeZoneId;
  const epochMs = value.epochMilliseconds;
  if (!within(epochMs)) return undefined;
  const first = bucketStart(zonedDays(epochMs, zone), unit, rules);
  const start = startOfDayEpoch(zone, first * MS_PER_DAY);
  return within(start) ? new Temporal.ZonedDateTime(BigInt(start) * 1_000_000n, zone) : undefined;
}
