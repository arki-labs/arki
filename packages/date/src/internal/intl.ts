/**
 * Bounded caches of `Intl` formatters, one per family so each lookup is typed
 * by construction. Building a formatter costs tens to hundreds of microseconds;
 * using one costs a few. Keys are locale + options; at most `INTL_CACHE_LIMIT`
 * entries per family, dropping the oldest, so callers that vary options cannot
 * grow memory without bound.
 */

import { remember } from './cache.js';

/** Maximum cached formatters per family. */
export const INTL_CACHE_LIMIT = 100;

const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();
const numberFormats = new Map<string, Intl.NumberFormat>();
const listFormats = new Map<string, Intl.ListFormat>();
const relativeTimeFormats = new Map<string, Intl.RelativeTimeFormat>();
const durationFormats = new Map<string, Intl.DurationFormat>();

export function dateTimeFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return remember(
    dateTimeFormats,
    `${locale}:${JSON.stringify(options)}`,
    INTL_CACHE_LIMIT,
    () => new Intl.DateTimeFormat(locale, options),
  );
}

export function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  return remember(
    numberFormats,
    `${locale}:${JSON.stringify(options)}`,
    INTL_CACHE_LIMIT,
    () => new Intl.NumberFormat(locale, options),
  );
}

export function listFormat(locale: string, options: Intl.ListFormatOptions): Intl.ListFormat {
  return remember(
    listFormats,
    `${locale}:${JSON.stringify(options)}`,
    INTL_CACHE_LIMIT,
    () => new Intl.ListFormat(locale, options),
  );
}

export function relativeTimeFormat(locale: string, options: Intl.RelativeTimeFormatOptions): Intl.RelativeTimeFormat {
  return remember(
    relativeTimeFormats,
    `${locale}:${JSON.stringify(options)}`,
    INTL_CACHE_LIMIT,
    () => new Intl.RelativeTimeFormat(locale, options),
  );
}

/** `Intl.DurationFormat` is missing on some engines (Hermes, Node ≤ 22): callers check `hasDurationFormat()` first. */
export function hasDurationFormat(): boolean {
  return typeof Intl.DurationFormat === 'function';
}

export function durationFormat(locale: string, options: Intl.DurationFormatOptions): Intl.DurationFormat {
  return remember(
    durationFormats,
    `${locale}:${JSON.stringify(options)}`,
    INTL_CACHE_LIMIT,
    () => new Intl.DurationFormat(locale, options),
  );
}

/** How many `Intl.DateTimeFormat`s are cached right now (for tests and diagnostics). */
export function intlCacheSize(): number {
  return dateTimeFormats.size;
}
