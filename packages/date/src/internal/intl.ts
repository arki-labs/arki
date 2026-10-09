/**
 * A bounded cache of `Intl.DateTimeFormat` instances.
 *
 * Building a formatter is far slower than using one, and `format` asks for the
 * same few (month names, weekday names, AM/PM) on every call. The cache keys on
 * locale + options and keeps at most `INTL_CACHE_LIMIT` entries, dropping the
 * oldest insert when full, so a caller that varies time zones or options
 * cannot grow it without bound.
 */

/** Maximum number of cached formatters. */
export const INTL_CACHE_LIMIT = 100;

const cache = new Map<string, Intl.DateTimeFormat>();

/** A cached `Intl.DateTimeFormat` for `locale` + `options` (created on first use). */
export function dateTimeFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}\u0000${JSON.stringify(options)}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const created = new Intl.DateTimeFormat(locale, options);
  if (cache.size >= INTL_CACHE_LIMIT) {
    const oldest = cache.keys().next();
    // eslint-disable-next-line drizzle/enforce-delete-with-where -- Map#delete, not a Drizzle query
    if (oldest.done !== true) cache.delete(oldest.value);
  }
  cache.set(key, created);
  return created;
}

/** How many formatters are cached right now (for tests and diagnostics). */
export function intlCacheSize(): number {
  return cache.size;
}
