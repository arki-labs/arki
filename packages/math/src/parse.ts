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
 *
 * Parsers return, they do not throw: text that is not a number returns the
 * `InvalidNumber` failure, a value past the limits returns `NumberOutOfRange`.
 * Runtimes without `Intl.NumberFormat#formatToParts` (React Native's Hermes on
 * iOS) throw `UnsupportedFeatureError`, a setup fault; pass `symbols` to parse without `Intl`.
 */

import { isFailure } from '@arki/failure';

import { Decimal } from './decimal.js';
import { InvalidNumber, NumberOutOfRange, UnsupportedFeatureError } from './errors.js';
import { DEFAULT_LOCALE, resolveLocale } from './internal/locale.js';
import { parseDecimalString } from './internal/parse.js';

export type ParseOptions = {
  /** BCP 47 locale tag. Default `'en-US'`. Ignored when `symbols` is given. */
  locale?: string;
  /**
   * The separators to read, instead of asking `Intl` for the locale's:
   * `{ decimal: ',', group: '.' }`. Minus defaults to `'-'`, digits to ASCII.
   */
  symbols?: ParseSymbols;
};

export type ParseSymbols = {
  decimal: string;
  group: string;
  minusSign?: string;
  /** The ten digits `0` to `9`. Default ASCII. */
  digits?: readonly string[];
};

export type LocaleNumberSymbols = {
  decimal: string;
  group: string;
  minusSign: string;
  /** The ten digits `0` to `9` as this locale writes them. */
  digits: string[];
};

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
const ASCII_DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const preparedCache = new Map<string, PreparedLocale>();

function prepareSymbols(symbols: ParseSymbols): PreparedLocale {
  const group = symbols.group.replaceAll(BIDI_MARKS, '');
  return Object.freeze({
    digitMap: new Map((symbols.digits ?? ASCII_DIGITS).map((digit, index) => [digit, String(index)])),
    decimal: symbols.decimal,
    group,
    minusSign: (symbols.minusSign ?? '-').replaceAll(BIDI_MARKS, ''),
    groupIsSpace: /^\s$/.test(group),
  });
}

function prepare(locale: string): PreparedLocale {
  const cached = preparedCache.get(locale);
  if (cached) return cached;
  const prepared = prepareSymbols(localeNumberSymbols(locale));
  if (preparedCache.size >= MAX_PREPARED_LOCALES) preparedCache.clear();
  preparedCache.set(locale, prepared);
  return prepared;
}

/** The decimal, group and minus symbols and the digits a locale uses. Cached per locale. */
export function localeNumberSymbols(requested: string): LocaleNumberSymbols {
  const locale = resolveLocale(requested);
  let symbols = symbolCache.get(locale);
  if (!symbols) {
    const formatter = new Intl.NumberFormat(locale);
    // React Native's Hermes on Apple platforms has Intl.NumberFormat but no formatToParts.
    if (typeof formatter.formatToParts !== 'function') {
      throw new UnsupportedFeatureError(
        "This runtime lacks Intl.NumberFormat#formatToParts, which locale-aware parsing needs (React Native's Hermes on iOS); pass options.symbols instead",
      );
    }
    const parts = formatter.formatToParts(-1_234_567.89);
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
const OUTER_SPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v', '\u00A0', '\u202F']);
const GROUP_SPACES = /[ \u00A0\u202F\u2009]/g;

/** The text without leading and trailing {@link OUTER_SPACE}. A scan from both ends: a regex with a `$` alternative is quadratic on a long run of spaces. */
function trimOuterSpace(input: string): string {
  let start = 0;
  let end = input.length;
  while (start < end && OUTER_SPACE.has(input[start]!)) start++;
  while (end > start && OUTER_SPACE.has(input[end - 1]!)) end--;
  return input.slice(start, end);
}

function normalize(input: string, prepared: PreparedLocale): string {
  let text = trimOuterSpace(input).replaceAll(BIDI_MARKS, '');
  let mapped = '';
  for (const char of text) mapped += prepared.digitMap.get(char) ?? char;
  text = prepared.groupIsSpace ? mapped.replaceAll(GROUP_SPACES, '') : mapped.split(prepared.group).join('');
  text = text.split(prepared.decimal).join('.');
  return text
    .split(prepared.minusSign)
    .join('-')
    .replaceAll(/[\u2212\u2013]/g, '-');
}

/** The text in strict ASCII syntax, or `InvalidNumber` when it does not read as a number in the locale or symbols. */
function normalizeText(input: string, options: ParseOptions) {
  if (typeof input !== 'string') throw new TypeError('input must be a string; convert other types first');
  const symbols = options.symbols;
  const normalized = normalize(
    input,
    symbols === undefined ? prepare(options.locale ?? DEFAULT_LOCALE) : prepareSymbols(symbols),
  );
  return STRICT_DECIMAL.test(normalized) ? normalized : InvalidNumber();
}

/**
 * Parses a locale-formatted number: `parseNumber('1.234,56', { locale: 'de-DE' })` → `1234.56`.
 * Lenient and locale-aware. Returns `InvalidNumber` for text that is not a number in the locale,
 * and `NumberOutOfRange` past the float range (use `parseDecimal` to keep every digit).
 */
export function parseNumber(input: string, options: ParseOptions = {}) {
  const normalized = normalizeText(input, options);
  if (isFailure(normalized)) return normalized;
  const result = Number(normalized);
  return Number.isFinite(result) ? result : NumberOutOfRange();
}

/**
 * Like `parseNumber` (lenient, locale-aware) but exact: every digit survives in the returned `Decimal`.
 * Returns `InvalidNumber` for text that is not a number, `NumberOutOfRange` past 10 000 digits or a scale of ±10 000.
 */
export function parseDecimal(input: string, options: ParseOptions = {}) {
  const normalized = normalizeText(input, options);
  if (isFailure(normalized)) return normalized;
  const parts = parseDecimalString(normalized);
  return isFailure(parts) ? parts : Decimal.fromParts(parts);
}
