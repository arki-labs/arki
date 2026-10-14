/**
 * Fast paths for ISO-calendar PlainDate arithmetic.
 *
 * A PlainDate is cheap to construct (about 120 ns on V8, 20 ns on Bun), but
 * `add`, `with` and `until` run Temporal's general algorithms and cost several
 * times that. These functions compute the result's fields directly and
 * construct it once; they convert to a day count only when days or weeks are
 * involved. They return `undefined` whenever they would not match
 * Temporal exactly (another calendar, a fractional or mixed-sign amount, time
 * fields, `reject` on a clamped day, the edge of Temporal's range); the caller
 * then uses Temporal itself.
 */

import type { CalendarUnit, Overflow, PlainDate, WeekRules } from '../types.js';
import type { DurationFields } from './amount.js';
import { Temporal } from '../types.js';
import { bucketStart } from './buckets.js';
import { civilFromDays, daysFromCivil, daysInMonthOf } from './civil.js';

/** Years safely inside Temporal's PlainDate range (-271821-04-19 to +275760-09-13). */
const LIMIT_YEARS = 270_000;
const LIMIT_DAYS = 98_000_000;

function isFastDate(value: PlainDate): boolean {
  return value.calendarId === 'iso8601' && Math.abs(value.year) <= LIMIT_YEARS;
}

function plainDateOfDays(days: number): PlainDate {
  const { year, month, day } = civilFromDays(days);
  return new Temporal.PlainDate(year, month, day);
}

/** `startOf(date, unit)` for a calendar unit. */
export function startOfPlainDate(value: PlainDate, unit: CalendarUnit, rules: WeekRules): PlainDate | undefined {
  if (!isFastDate(value)) return undefined;
  switch (unit) {
    case 'day': {
      return value;
    }
    case 'week': {
      return plainDateOfDays(bucketStart(daysFromCivil(value.year, value.month, value.day), unit, rules));
    }
    case 'month': {
      return new Temporal.PlainDate(value.year, value.month, 1);
    }
    case 'quarter': {
      return new Temporal.PlainDate(value.year, Math.floor((value.month - 1) / 3) * 3 + 1, 1);
    }
    case 'year': {
      return new Temporal.PlainDate(value.year, 1, 1);
    }
  }
}

/** `endOf(date, unit)` for a calendar unit: the last day of that day, week, month, quarter or year. */
export function endOfPlainDate(value: PlainDate, unit: CalendarUnit, rules: WeekRules): PlainDate | undefined {
  if (!isFastDate(value)) return undefined;
  switch (unit) {
    case 'day': {
      return value;
    }
    case 'week': {
      return plainDateOfDays(bucketStart(daysFromCivil(value.year, value.month, value.day), unit, rules) + 6);
    }
    case 'month': {
      return new Temporal.PlainDate(value.year, value.month, daysInMonthOf(value.year, value.month));
    }
    case 'quarter': {
      const month = Math.floor((value.month - 1) / 3) * 3 + 3;
      return new Temporal.PlainDate(value.year, month, daysInMonthOf(value.year, month));
    }
    case 'year': {
      return new Temporal.PlainDate(value.year, 12, 31);
    }
  }
}

const DATE_FIELDS = ['years', 'months', 'weeks', 'days'] as const;
const OTHER_FIELDS = ['hours', 'minutes', 'seconds', 'milliseconds', 'microseconds', 'nanoseconds'] as const;

/** `date + amount` for whole calendar amounts of one sign, as Temporal's ISO calendar adds them. */
export function addPlainDate(value: PlainDate, amount: DurationFields, overflow?: Overflow): PlainDate | undefined {
  for (const field of OTHER_FIELDS) if ((amount[field] ?? 0) !== 0) return undefined;
  let sign = 0;
  for (const field of DATE_FIELDS) {
    const fieldValue = amount[field] ?? 0;
    if (!Number.isSafeInteger(fieldValue)) return undefined;
    const fieldSign = Math.sign(fieldValue);
    if (fieldSign !== 0) {
      // Temporal rejects mixed signs; leave that error to it.
      if (sign !== 0 && fieldSign !== sign) return undefined;
      sign = fieldSign;
    }
  }
  if (!isFastDate(value)) return undefined;
  let { year, month, day } = value;
  const months = (amount.years ?? 0) * 12 + (amount.months ?? 0);
  if (months !== 0) {
    const total = year * 12 + month - 1 + months;
    year = Math.floor(total / 12);
    month = total - year * 12 + 1;
    const length = daysInMonthOf(year, month);
    if (day > length) {
      if (overflow === 'reject') return undefined;
      day = length;
    }
  }
  if (Math.abs(year) > LIMIT_YEARS) return undefined;
  const days = (amount.weeks ?? 0) * 7 + (amount.days ?? 0);
  if (days === 0) return new Temporal.PlainDate(year, month, day);
  const target = daysFromCivil(year, month, day) + days;
  // Past the limit, Temporal itself reports the out-of-range result.
  return Math.abs(target) <= LIMIT_DAYS ? plainDateOfDays(target) : undefined;
}
