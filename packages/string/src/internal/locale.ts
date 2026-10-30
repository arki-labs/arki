/**
 * Locale-independent by default; locale-sensitive only when a BCP 47 tag is passed explicitly.
 * A malformed tag (an `Accept-Language` header, a cookie) makes `Intl` throw a `RangeError`: it falls back to
 * the default, locale-independent casing and is logged at DEBUG.
 */

import { getLogger } from '@arki/log';

const debugLocale = getLogger('arki:string:locale');

function malformed(locale: string, error: unknown): void {
  if (!(error instanceof RangeError)) throw error;
  debugLocale.debug('malformed locale {locale} ignored, using locale-independent casing', {
    locale: locale.slice(0, 64),
  });
}

export function lower(text: string, locale: string | undefined): string {
  if (locale === undefined) return text.toLowerCase();
  try {
    return text.toLocaleLowerCase(locale);
  } catch (error) {
    malformed(locale, error);
    return text.toLowerCase();
  }
}

export function upper(text: string, locale: string | undefined): string {
  if (locale === undefined) return text.toUpperCase();
  try {
    return text.toLocaleUpperCase(locale);
  } catch (error) {
    malformed(locale, error);
    return text.toUpperCase();
  }
}
