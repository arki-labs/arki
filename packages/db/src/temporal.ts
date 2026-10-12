/**
 * Postgres columns that read and write `@arki/date` values instead of `Date`.
 *
 * - `plainDate(name)` — a `date` column ↔ `PlainDate` (no zone, no time, no
 *   midnight shifting through the runtime zone).
 * - `instant(name)` — a `timestamptz` column ↔ `Instant` (an exact moment).
 *
 * There is no column for `ZonedDateTime`: Postgres stores no zone, so keep the
 * zone in its own `text` column and project with `zoned(instant, zone)` when
 * reading. `timestamp` without time zone is deliberately not offered — drivers
 * reinterpret it through the process zone, which is exactly the bug these
 * columns exist to prevent.
 */

import { customType } from 'drizzle-orm/pg-core';

import type { Instant, PlainDate } from '@arki/date/types';
import { parseISO, instant as toInstant, plainDate as toPlainDate } from '@arki/date/core';

/** `PlainDate` → `YYYY-MM-DD` for the driver. */
export function plainDateToDriver(value: PlainDate): string {
  return value.toString();
}

/** Driver `date` text (`YYYY-MM-DD`; some drivers give a `Date` at local midnight) → `PlainDate`. */
export function plainDateFromDriver(value: string | Date): PlainDate {
  if (typeof value === 'string') return toPlainDate(value.slice(0, 10));
  return toPlainDate({ year: value.getFullYear(), month: value.getMonth() + 1, day: value.getDate() });
}

/** `Instant` → ISO text for the driver. */
export function instantToDriver(value: Instant): string {
  return value.toString();
}

/** Driver `timestamptz` value (`Date`, or text like `2026-05-20 10:30:00+00`) → `Instant`. */
export function instantFromDriver(value: string | Date): Instant {
  if (value instanceof Date) return toInstant(value);
  return parseISO(value.replace(' ', 'T'), { timeZone: 'UTC' });
}

/** A `date` column holding a `PlainDate`. */
export const plainDate = customType<{ data: PlainDate; driverData: string | Date }>({
  dataType() {
    return 'date';
  },
  toDriver: plainDateToDriver,
  fromDriver: plainDateFromDriver,
});

/** A `timestamptz` column holding an `Instant`. */
export const instant = customType<{ data: Instant; driverData: string | Date }>({
  dataType() {
    return 'timestamptz';
  },
  toDriver: instantToDriver,
  fromDriver: instantFromDriver,
});
