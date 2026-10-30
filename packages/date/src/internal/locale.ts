/**
 * Locale text from outside (an `Accept-Language` header, a cookie) can be
 * malformed. `Intl` throws a `RangeError` for a bad tag, so every public door
 * that takes a `locale` option passes it through {@link resolveLocale}: a
 * malformed tag falls back to the default locale and is logged at DEBUG.
 */

import { getLogger } from '@arki/log';

import { remember } from './cache.js';

/** The locale used when none is given or the given one is malformed. */
export const DEFAULT_LOCALE = 'en-US';

const debugLocale = getLogger('arki:date:locale');

/** Maximum remembered verdicts; a flood of distinct bad tags cannot grow memory without bound. */
const LOCALE_CACHE_LIMIT = 100;

/** Locale → the locale to use: itself when well formed, else {@link DEFAULT_LOCALE}. */
const verdicts = new Map<string, string>();

function isWellFormed(locale: string): boolean {
  // Hermes has no `Intl.getCanonicalLocales`; there the engine's own formatters judge the tag.
  if (typeof Reflect.get(Intl, 'getCanonicalLocales') !== 'function') return true;
  try {
    Intl.getCanonicalLocales(locale);
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

/** `locale` when it is a well-formed BCP 47 tag, `en-US` when it is missing or malformed (logged at DEBUG). */
export function resolveLocale(locale: string | undefined): string {
  if (locale === undefined) return DEFAULT_LOCALE;
  return remember(verdicts, locale, LOCALE_CACHE_LIMIT, () => {
    if (isWellFormed(locale)) return locale;
    debugLocale.debug('malformed locale {locale} replaced by {fallback}', {
      locale: locale.slice(0, 64),
      fallback: DEFAULT_LOCALE,
    });
    return DEFAULT_LOCALE;
  });
}
