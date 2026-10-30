/**
 * Locale text from outside (an `Accept-Language` header, a cookie) can be
 * malformed, and `Intl` throws a `RangeError` for a bad tag. Every door that
 * takes a `locale` passes it through {@link resolveLocale}: a malformed tag
 * falls back to {@link DEFAULT_LOCALE} and is logged at DEBUG.
 */
import { getLogger } from '@arki/log';

/** The locale used when none is given or the given one is malformed. */
export const DEFAULT_LOCALE = 'en-US';

const debugLocale = getLogger('arki:math:locale');

/** Most remembered verdicts; a flood of distinct bad tags cannot grow memory without bound. */
const MAX_VERDICTS = 100;
const verdicts = new Map<string, string>();

/** True when the runtime's `Intl.NumberFormat` accepts the tag. It asks the engine itself, so it holds on Hermes, which has no `Intl.getCanonicalLocales`. */
function isWellFormed(locale: string): boolean {
  try {
    new Intl.NumberFormat(locale);
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

/** `locale` when the runtime accepts it as a BCP 47 tag, else `en-US` (logged at DEBUG). */
export function resolveLocale(locale: string): string {
  const known = verdicts.get(locale);
  if (known !== undefined) return known;
  const resolved = isWellFormed(locale) ? locale : DEFAULT_LOCALE;
  if (resolved !== locale) {
    debugLocale.debug('malformed locale {locale} replaced by {fallback}', {
      locale: locale.slice(0, 64),
      fallback: DEFAULT_LOCALE,
    });
  }
  if (verdicts.size >= MAX_VERDICTS) verdicts.clear();
  verdicts.set(locale, resolved);
  return resolved;
}
