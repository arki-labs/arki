/**
 * Postgres columns that read and write `@arki/date` values instead of `Date`.
 *
 * - `plainDate(name)` — a `date` column ↔ `PlainDate`: a calendar date with no
 *   time and no zone, so nothing can shift it across midnight.
 * - `instant(name)` — a `timestamp with time zone` column ↔ `Instant`.
 * - `instant(name, { withTimezone: false })` — an existing `timestamp` column
 *   ↔ `Instant`, with the stored wall clock read as UTC. This is Drizzle's own
 *   convention for `timestamp(name)`, so switching a column to it changes the
 *   TypeScript type and nothing in the database.
 *
 * Both columns declare Drizzle's `:string` codecs, so every driver (node-postgres,
 * postgres.js, PGlite, Bun SQL) hands back Postgres text and one strict parser
 * covers them all. Values Temporal cannot hold (`infinity`, BC dates) throw a
 * `RangeError` instead of becoming a wrong date.
 *
 * There is no `ZonedDateTime` column: Postgres stores no zone. Keep the zone in
 * its own `text` column and project on read with `zoned(instant, zone)`.
 */

import { customType } from 'drizzle-orm/pg-core';

import type { Instant, PlainDate } from '@arki/date/types';
import { Temporal } from '@arki/date/types';

/** Ends with the UTC offset Postgres prints for `timestamptz` (`+03`, `+05:30`, `+01:44:24`) or `Z`. */
const HAS_OFFSET = /(?:[+-]\d{2}(?::?\d{2}){0,2}|Z)$/i;

function unsupported(kind: string, text: string): RangeError {
  return new RangeError(`@arki/db/temporal: cannot read ${kind} "${text}" (infinity and BC values are not supported)`);
}

/** `PlainDate` → `YYYY-MM-DD`. */
export function plainDateToDriver(value: PlainDate): string {
  return value.toString();
}

/** Postgres `date` text → `PlainDate`. */
export function plainDateFromDriver(text: string): PlainDate {
  try {
    return Temporal.PlainDate.from(text);
  } catch {
    throw unsupported('date', text);
  }
}

/** `Instant` → ISO text with `Z`. A `timestamp` column ignores the suffix and stores the UTC wall clock. */
export function instantToDriver(value: Instant): string {
  return value.toString();
}

/**
 * Postgres `timestamptz` or `timestamp` text → `Instant`. The two are told apart
 * by format, not guessed: `timestamptz` text always ends in an offset and
 * `timestamp` text never does; the latter is read as UTC.
 */
export function instantFromDriver(text: string): Instant {
  const iso = text.replace(' ', 'T');
  try {
    if (HAS_OFFSET.test(iso)) return Temporal.Instant.from(iso);
    return Temporal.PlainDateTime.from(iso).toZonedDateTime('UTC').toInstant();
  } catch {
    throw unsupported('timestamp', text);
  }
}

/** A `date` column holding a `PlainDate`. */
export const plainDate = customType<{ data: PlainDate; driverData: string }>({
  dataType() {
    return 'date';
  },
  codec: 'date:string',
  toDriver: plainDateToDriver,
  fromDriver: plainDateFromDriver,
});

export type InstantColumnConfig = Readonly<{
  /** `true` (default): `timestamp with time zone`. `false`: an existing `timestamp` column, read as UTC. */
  withTimezone?: boolean;
  /** Fractional-second digits stored, 0–6. Default: Postgres's 6. */
  precision?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}>;

/** A `timestamp with time zone` (or, opted in, `timestamp`) column holding an `Instant`. */
export const instant = customType<{ data: Instant; driverData: string; config: InstantColumnConfig }>({
  dataType(config) {
    const precision = config?.precision === undefined ? '' : `(${config.precision})`;
    return config?.withTimezone === false ? `timestamp${precision}` : `timestamp${precision} with time zone`;
  },
  codec: config => (config?.withTimezone === false ? 'timestamp:string' : 'timestamptz:string'),
  toDriver: instantToDriver,
  fromDriver: instantFromDriver,
});
