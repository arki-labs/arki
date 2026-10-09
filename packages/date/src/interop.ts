/**
 * The native `Date` boundary. `Date` stays at the edges (DB drivers, pickers,
 * third-party APIs); inside, values are Temporal. Two different conversions
 * exist on purpose: `fromDate` keeps the *instant*, `fromPickerDate` keeps the
 * *calendar fields* a picker showed the user.
 */

import type { Instant, PlainDate, Timeline } from './types.js';
import { instant, plainDate } from './core.js';
import { Temporal } from './types.js';

/** The instant a `Date` represents. */
export function fromDate(value: Date): Instant {
  return instant(value);
}

/** A fresh mutable `Date` at the same instant (sub-millisecond precision truncated). */
export function toDate(value: Timeline | Date): Date {
  return value instanceof Date ? new Date(value) : new Date(value.epochMilliseconds);
}

/**
 * Which clock a `Date`'s calendar fields were chosen in. Browser pickers that
 * build `new Date(y, m, d)` use `local`; APIs that build `Date.UTC(...)` use `utc`.
 */
export type DateBasis =
  { readonly basis: 'local' } | { readonly basis: 'utc' } | { readonly basis: 'zone'; readonly timeZone: string };

const LOCAL: DateBasis = { basis: 'local' };

/** The calendar date a picker selected, read from the `Date`'s fields in the stated basis. */
export function fromPickerDate(value: Date, basis: DateBasis = LOCAL): PlainDate {
  if (Number.isNaN(value.getTime())) throw new RangeError('fromPickerDate received an invalid Date');
  switch (basis.basis) {
    case 'local': {
      return plainDate({ year: value.getFullYear(), month: value.getMonth() + 1, day: value.getDate() });
    }
    case 'utc': {
      return plainDate({ year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() });
    }
    case 'zone': {
      return instant(value).toZonedDateTimeISO(basis.timeZone).toPlainDate();
    }
  }
}

/**
 * A `Date` whose fields in the stated basis show the given calendar date
 * (first valid time of that day). Throws if the day does not exist in that
 * basis (a zone that skipped the date).
 */
export function toPickerDate(value: PlainDate, basis: DateBasis = LOCAL): Date {
  let result: Date;
  switch (basis.basis) {
    case 'local': {
      result = new Date(value.year, value.month - 1, value.day, 0, 0, 0, 0);
      if (value.year >= 0 && value.year < 100) result.setFullYear(value.year);
      break;
    }
    case 'utc': {
      result = new Date(Date.UTC(value.year, value.month - 1, value.day));
      if (value.year >= 0 && value.year < 100) result.setUTCFullYear(value.year);
      break;
    }
    case 'zone': {
      result = toDate(value.toZonedDateTime({ timeZone: basis.timeZone }));
      break;
    }
  }
  if (!fromPickerDate(result, basis).equals(value)) {
    throw new RangeError(`${value.toString()} cannot be represented as a Date in the ${basis.basis} basis`);
  }
  return result;
}

/** The runtime's current IANA time zone (e.g. `Europe/Bucharest`). */
export function systemTimeZone(): string {
  return Temporal.Now.timeZoneId();
}
