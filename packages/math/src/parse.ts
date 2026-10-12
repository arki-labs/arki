/**
 * Locale-aware number parsing. `Intl` can format but not parse, so the
 * separators of a locale are read back from `formatToParts`.
 *
 * `parseNumber` / `parseDecimal` are the LENIENT, locale-aware parsers: they
 * accept the locale's digits, group separators, decimal mark, Unicode minus and
 * surrounding spaces. `decimal()` from `./decimal.js` is the STRICT ASCII parser
 * (`'1234.56'` only, `.` as decimal mark, no grouping); use it for data you
 * control (APIs, storage) and these for text a person typed.
 *
 * The locale decides what the separators mean: `'1.234'` is 1.234 in `en-US`
 * but 1234 in `de-DE`. Group separators are only removed, never validated, so
 * `'1,23,4'` is accepted in `en-US` and reads as 1234.
 */

import type { Decimal } from './decimal.js';
import { decimal } from './decimal.js';
import { NumberFormatError, NumericRangeError } from './errors.js';

export type ParseOptions = {
  /** BCP 47 locale tag. Default `'en-US'`. */
  locale?: string;
};

export type LocaleNumberSymbols = {
  decimal: string;
  group: string;
  minusSign: string;
  /** The ten digits `0` to `9` as this locale writes them. */
  digits: string[];
};

const DEFAULT_LOCALE = 'en-US';
// LRM, RLM and Arabic letter mark: invisible direction marks some locales put around signs.
const BIDI_MARKS = /[\u200E\u200F؜]/g;
const symbolCache = new Map<string, LocaleNumberSymbols>();

/** Everything `normalize` needs for one locale, prepared once and frozen. */
type PreparedLocale = {
  readonly digitMap: ReadonlyMap<string, string>;
  readonly decimal: string;
  readonly group: string;
  readonly minusSign: string;
  /** The group separator is a whitespace character, so every space variant is removed. */
  readonly groupIsSpace: boolean;
};

const MAX_PREPARED_LOCALES = 64;
const preparedCache = new Map<string, PreparedLocale>();

function prepare(locale: string): PreparedLocale {
  const cached = preparedCache.get(locale);
  if (cached) return cached;
  const symbols = localeNumberSymbols(locale);
  const group = symbols.group.replaceAll(BIDI_MARKS, '');
  const prepared: PreparedLocale = Object.freeze({
    digitMap: new Map(symbols.digits.map((digit, index) => [digit, String(index)])),
    decimal: symbols.decimal,
    group,
    minusSign: symbols.minusSign,
    groupIsSpace: /^\s$/.test(group),
  });
  if (preparedCache.size >= MAX_PREPARED_LOCALES) preparedCache.clear();
  preparedCache.set(locale, prepared);
  return prepared;
}

/** The decimal, group and minus symbols and the digits a locale uses. Cached per locale. */
export function localeNumberSymbols(locale: string): LocaleNumberSymbols {
  let symbols = symbolCache.get(locale);
  if (!symbols) {
    const parts = new Intl.NumberFormat(locale).formatToParts(-1_234_567.89);
    const find = (type: string, fallback: string): string => parts.find(part => part.type === type)?.value ?? fallback;
    const plain = new Intl.NumberFormat(locale, { useGrouping: false });
    symbols = {
      decimal: find('decimal', '.'),
      group: find('group', ','),
      minusSign: find('minusSign', '-').replaceAll(BIDI_MARKS, ''),
      digits: Array.from({ length: 10 }, (_, digit) => plain.format(digit)),
    };
    symbolCache.set(locale, symbols);
  }
  return { ...symbols, digits: [...symbols.digits] };
}

const STRICT_DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const OUTER_SPACE = /^[ \t\n\r\f\v\u00A0\u202F]+|[ \t\n\r\f\v\u00A0\u202F]+$/g;
const GROUP_SPACES = /[ \u00A0\u202F\u2009]/g;

function normalize(input: string, locale: string): string {
  const prepared = prepare(locale);
  let text = input.replaceAll(OUTER_SPACE, '').replaceAll(BIDI_MARKS, '');
  let mapped = '';
  for (const char of text) mapped += prepared.digitMap.get(char) ?? char;
  text = prepared.groupIsSpace ? mapped.replaceAll(GROUP_SPACES, '') : mapped.split(prepared.group).join('');
  text = text.split(prepared.decimal).join('.');
  return text
    .split(prepared.minusSign)
    .join('-')
    .replaceAll(/[\u2212\u2013]/g, '-');
}

function normalizeOrThrow(input: string, locale: string): string {
  if (typeof input !== 'string') throw new TypeError('input must be a string; convert other types first');
  const normalized = normalize(input, locale);
  if (!STRICT_DECIMAL.test(normalized)) {
    throw new NumberFormatError(
      `Cannot parse '${input}' as a number in locale '${locale}'; check the locale matches the text (the decimal mark differs between locales), or pass an ASCII string to decimal()`,
    );
  }
  return normalized;
}

/**
 * Parses a locale-formatted number: `parseNumber('1.234,56', { locale: 'de-DE' })` → `1234.56`.
 * Lenient and locale-aware; for strict ASCII input use `decimal()`.
 */
export function parseNumber(input: string, options: ParseOptions = {}): number {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const result = Number(normalizeOrThrow(input, locale));
  if (!Number.isFinite(result)) {
    throw new NumericRangeError(`'${input}' is too large for a JS number; use parseDecimal to keep every digit`);
  }
  return result;
}

/** Like `parseNumber` (lenient, locale-aware) but exact: every digit survives in the returned `Decimal`. */
export function parseDecimal(input: string, options: ParseOptions = {}): Decimal {
  return decimal(normalizeOrThrow(input, options.locale ?? DEFAULT_LOCALE));
}
