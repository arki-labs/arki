/**
 * Proleptic Gregorian (ISO 8601) calendar arithmetic on plain integers.
 *
 * Temporal answers these questions through objects, and on V8 each object
 * costs hundreds of nanoseconds. The hot paths (parsing, formatting, zoned
 * boundaries) need only a few numbers, so they use these functions and create
 * at most one Temporal value at the end. Days count from 1970-01-01 = 0.
 */

export const MS_PER_DAY = 86_400_000;

/** Days since 1970-01-01 of an ISO date (Howard Hinnant's `days_from_civil`). Valid for any integer year. */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const marchMonth = (month + 9) % 12;
  const dayOfYear = Math.floor((153 * marchMonth + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

export type CivilDate = { year: number; month: number; day: number };

/** The ISO date of a day count (Howard Hinnant's `civil_from_days`). */
export function civilFromDays(days: number): CivilDate {
  const shifted = days + 719_468;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365,
  );
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const marchMonth = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * marchMonth + 2) / 5) + 1;
  const month = marchMonth < 10 ? marchMonth + 3 : marchMonth - 9;
  return { year: yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export function daysInMonthOf(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return MONTH_DAYS[month - 1] ?? Number.NaN;
}

/** ISO weekday of a day count: Monday = 1 … Sunday = 7 (1970-01-01 was a Thursday). */
export function weekdayOfDays(days: number): number {
  return ((((days + 3) % 7) + 7) % 7) + 1;
}

/** Day of the year, 1-based. */
export function dayOfYearOf(year: number, month: number, day: number): number {
  return daysFromCivil(year, month, day) - daysFromCivil(year, 1, 1) + 1;
}

/** ISO 8601 week (weeks start Monday; week 1 holds the year's first Thursday). */
export function isoWeekOf(year: number, month: number, day: number): { week: number; weekYear: number } {
  const days = daysFromCivil(year, month, day);
  const thursday = days - weekdayOfDays(days) + 4;
  const weekYear = civilFromDays(thursday).year;
  return { week: Math.floor((thursday - daysFromCivil(weekYear, 1, 1)) / 7) + 1, weekYear };
}
