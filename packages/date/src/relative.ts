/**
 * "In 3 days" / "3 days ago" — relative time text via `Intl.RelativeTimeFormat`.
 *
 * Policies:
 * - Under 24 elapsed hours the unit comes from exact elapsed time (second,
 *   minute, hour), truncated toward zero.
 * - From 24 hours on, both moments are projected into one zone and compared
 *   by calendar day, so "tomorrow" means the next calendar day even across DST.
 * - Positive values mean `target` is later than `reference`.
 * - Text defaults to the `'en-US'` locale so server and client render the same.
 */

import type { Clock } from '@arki/clock';

import type { Timeline, ZonedDateTime } from './types.js';
import { now } from './clock.js';
import { instant } from './core.js';
import { systemTimeZone } from './interop.js';
import { diff, startOf } from './math.js';
import { isZonedDateTime } from './types.js';

export type RelativeUnit = 'year' | 'quarter' | 'month' | 'week' | 'day' | 'hour' | 'minute' | 'second';

export type RelativeOptions = Readonly<{
  locale?: string;
  /** Force one unit, or `'auto'` (default) to pick by distance. */
  unit?: RelativeUnit | 'auto';
  /** `'auto'` allows words like "yesterday" and "tomorrow". Default `'always'`. */
  numeric?: 'always' | 'auto';
  style?: 'long' | 'short' | 'narrow';
  /** Zone for calendar-day comparison. Default: the target's zone if zoned, else the runtime zone. */
  timeZone?: string;
}>;

export type RelativeValue = Readonly<{ unit: RelativeUnit; value: number }>;

const NS_PER_SECOND = 1_000_000_000n;
const NS_PER_MINUTE = 60n * NS_PER_SECOND;
const NS_PER_HOUR = 60n * NS_PER_MINUTE;
const NS_PER_DAY = 24n * NS_PER_HOUR;

function exactValue(elapsed: bigint, unit: 'second' | 'minute' | 'hour'): RelativeValue {
  const size = unit === 'second' ? NS_PER_SECOND : unit === 'minute' ? NS_PER_MINUTE : NS_PER_HOUR;
  return { unit, value: Number(elapsed / size) };
}

function startOfDayIn(value: Timeline | Date, timeZone: string): ZonedDateTime {
  return startOf(instant(value).toZonedDateTimeISO(timeZone), 'day');
}

function zoneFor(target: Timeline | Date, options: RelativeOptions | undefined): string {
  if (options?.timeZone) return options.timeZone;
  return isZonedDateTime(target) ? target.timeZoneId : systemTimeZone();
}

/**
 * The unit and signed whole value `relative` would print. Auto selection:
 * < 60 s → second, < 60 min → minute, < 24 h → hour (exact time), then by
 * calendar days in the zone: < 7 days → day, < 1 month → week, < 12 months → month, else year.
 */
export function relativeUnit(
  target: Timeline | Date,
  reference: Timeline | Date,
  options?: RelativeOptions,
): RelativeValue {
  const elapsed = instant(target).epochNanoseconds - instant(reference).epochNanoseconds;
  const magnitude = elapsed < 0n ? -elapsed : elapsed;
  const forced = options?.unit === undefined || options.unit === 'auto' ? undefined : options.unit;

  if (forced === 'second' || forced === 'minute' || forced === 'hour') return exactValue(elapsed, forced);
  if (forced === undefined) {
    if (magnitude < 60n * NS_PER_SECOND) return exactValue(elapsed, 'second');
    if (magnitude < 60n * NS_PER_MINUTE) return exactValue(elapsed, 'minute');
    if (magnitude < NS_PER_DAY) return exactValue(elapsed, 'hour');
  }

  const zone = zoneFor(target, options);
  const from = startOfDayIn(reference, zone);
  const to = startOfDayIn(target, zone);
  if (forced !== undefined) return { unit: forced, value: diff(from, to, forced) };

  const dayCount = diff(from, to, 'day');
  // A 25-hour fall-back day can put ≥ 24 elapsed hours on one calendar day.
  if (dayCount === 0) return exactValue(elapsed, 'hour');
  if (Math.abs(dayCount) < 7) return { unit: 'day', value: dayCount };
  const monthCount = diff(from, to, 'month');
  if (Math.abs(monthCount) < 1) return { unit: 'week', value: Math.trunc(dayCount / 7) };
  if (Math.abs(monthCount) < 12) return { unit: 'month', value: monthCount };
  return { unit: 'year', value: diff(from, to, 'year') };
}

const FORMAT_CACHE_LIMIT = 50;
const formatCache = new Map<string, Intl.RelativeTimeFormat>();

/** One formatter per locale + options; the cache is emptied when it reaches the limit. */
function formatterFor(
  locale: string,
  numeric: 'always' | 'auto',
  style: 'long' | 'short' | 'narrow',
): Intl.RelativeTimeFormat {
  const key = `${locale}|${numeric}|${style}`;
  const cached = formatCache.get(key);
  if (cached) return cached;
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric, style });
  if (formatCache.size >= FORMAT_CACHE_LIMIT) formatCache.clear();
  formatCache.set(key, formatter);
  return formatter;
}

/** Locale text for `target` seen from `reference`: "in 3 days", "3 days ago", or "tomorrow" with `numeric: 'auto'`. */
export function relative(target: Timeline | Date, reference: Timeline | Date, options?: RelativeOptions): string {
  const { unit, value } = relativeUnit(target, reference, options);
  const formatter = formatterFor(options?.locale ?? 'en-US', options?.numeric ?? 'always', options?.style ?? 'long');
  return formatter.format(value, unit);
}

/** `relative(target, now(clock))`. Pass a `MockClock` for deterministic output. */
export function relativeToNow(
  target: Timeline | Date,
  options?: RelativeOptions & Readonly<{ clock?: Clock }>,
): string {
  return relative(target, now(options?.clock), options);
}
