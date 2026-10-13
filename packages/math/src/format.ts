/**
 * Presentation helpers built on `Intl.NumberFormat`. Numbers are formatted
 * for people, never for storage: the output depends on the locale and must not
 * be parsed back with `Number()` (use `parseNumber` from `./parse.js`).
 *
 * `Decimal` and numeric-string inputs are handed to `Intl` as exact decimal
 * strings, so no digit is lost on the way. `Intl.NumberFormat` instances are
 * cached because constructing one is slow.
 */

import type { Decimal } from './decimal.js';
import type { RoundingMode } from './rounding.js';
import { decimal, isDecimal } from './decimal.js';
import { InvalidArgumentError, NumberFormatError, NumericRangeError, UnsupportedFeatureError } from './errors.js';
import { assertFinite } from './number.js';

/** A formattable value. A string must be a number in plain decimal syntax (`'-1234.50'`). */
export type FormatValue = number | bigint | Decimal | string;

export type FormatOptions = {
  /** BCP 47 locale tag. Default `'en-US'`. */
  locale?: string;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  useGrouping?: boolean;
  /** How digits beyond `maximumFractionDigits` are dropped. Default `'halfUp'`. */
  rounding?: Exclude<RoundingMode, 'unnecessary'>;
  signDisplay?: 'auto' | 'always' | 'exceptZero' | 'negative' | 'never';
};

export type CurrencyOptions = {
  currencyDisplay?: 'symbol' | 'narrowSymbol' | 'code' | 'name';
  /** Show negatives in accounting style: `($5.00)` instead of `-$5.00`. */
  accounting?: boolean;
} & FormatOptions;

export type CompactOptions = {
  /** `'short'` gives `1.2M`, `'long'` gives `1.2 million`. Default `'short'`. */
  display?: 'short' | 'long';
} & FormatOptions;

export type FileSizeOptions = {
  /** `'si'` uses powers of 1000 (`kB`), `'iec'` powers of 1024 (`KiB`). Default `'si'`. */
  system?: 'si' | 'iec';
} & FormatOptions;

const DEFAULT_LOCALE = 'en-US';

const INTL_ROUNDING = {
  up: 'expand',
  down: 'trunc',
  ceiling: 'ceil',
  floor: 'floor',
  halfUp: 'halfExpand',
  halfDown: 'halfTrunc',
  halfEven: 'halfEven',
} as const satisfies Record<Exclude<RoundingMode, 'unnecessary'>, string>;

const MAX_CACHE_ENTRIES = 256;
const formatterCache = new Map<string, Intl.NumberFormat>();

/** Builds the cache key by plain concatenation of the known option fields in a fixed order (no sorting, no JSON). */
function cacheKey(locale: string, o: Intl.NumberFormatOptions): string {
  return `${locale}|${o.style ?? ''}|${o.currency ?? ''}|${o.currencyDisplay ?? ''}|${o.currencySign ?? ''}|${o.notation ?? ''}|${o.compactDisplay ?? ''}|${o.minimumFractionDigits ?? ''}|${o.maximumFractionDigits ?? ''}|${String(o.useGrouping ?? '')}|${o.signDisplay ?? ''}|${o.roundingMode ?? ''}`;
}

function getNumberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = cacheKey(locale, options);
  const cached = formatterCache.get(key);
  if (cached) return cached;
  if (options.roundingMode !== undefined) {
    const echoed = new Intl.NumberFormat(locale, { roundingMode: options.roundingMode }).resolvedOptions().roundingMode;
    if (echoed !== options.roundingMode) {
      throw new UnsupportedFeatureError(
        `This runtime does not support Intl.NumberFormat roundingMode '${options.roundingMode}' (Intl.NumberFormat v3); use the default 'halfUp' rounding.`,
      );
    }
  }
  const created = new Intl.NumberFormat(locale, options);
  if (formatterCache.size >= MAX_CACHE_ENTRIES) formatterCache.clear();
  formatterCache.set(key, created);
  return created;
}

let exactStringsSupported: boolean | undefined;

/** Probes lazily, once. 2^53 + 1 cannot survive a trip through `Number`, so an Intl that coerces fails. */
function hasExactStringSupport(): boolean {
  exactStringsSupported ??=
    new Intl.NumberFormat('en-US', { useGrouping: false }).format('9007199254740993') === '9007199254740993';
  return exactStringsSupported;
}

// A double tells apart every decimal of up to 15 significant digits.
const MAX_EXACT_DOUBLE_DIGITS = 15;

/**
 * For runtimes whose Intl reads decimal text through a double (React Native's
 * Hermes). The value is rounded exactly here, to the digits Intl will show, so
 * Intl has nothing left to round. If the shown digits fit in 15, the double's
 * error is far below half a unit of the last digit and the output is exact.
 * Compact notation picks its scale per locale, so only whole numbers pass there.
 */
function toExactDouble(text: string, nf: Intl.NumberFormat, rounding: RoundingMode): number {
  const resolved = nf.resolvedOptions();
  const value = decimal(text);
  const max = resolved.maximumFractionDigits;
  if (resolved.notation === 'compact' || max === undefined) {
    if (value.isInteger() && integerDigitCount(value.toString()) <= MAX_EXACT_DOUBLE_DIGITS) return Number(text);
    throw unsupportedExactFormat(text);
  }
  const percent = resolved.style === 'percent';
  const shown = (percent ? value.times(100) : value).round(max, rounding === 'unnecessary' ? 'halfUp' : rounding);
  const shownText = shown.trim().toString();
  const dot = shownText.indexOf('.');
  const fractionDigits = Math.max(resolved.minimumFractionDigits ?? 0, dot === -1 ? 0 : shownText.length - dot - 1);
  if (integerDigitCount(shownText) + fractionDigits > MAX_EXACT_DOUBLE_DIGITS) throw unsupportedExactFormat(text);
  const result = Number((percent ? shown.times('0.01') : shown).toString());
  // -0.001 shown with two digits is '-0.00', as exact Intl prints it.
  return result === 0 && value.isNegative() ? -0 : result;
}

function unsupportedExactFormat(text: string): UnsupportedFeatureError {
  return new UnsupportedFeatureError(
    `This runtime's Intl.NumberFormat reads decimal text through a double (Intl.NumberFormat v3 is missing), so it cannot show '${text}' exactly; values up to ${MAX_EXACT_DOUBLE_DIGITS} shown digits work. Print the value with Decimal#toString() instead.`,
  );
}

// Intl.NumberFormat caps its mathematical value near the double range and prints larger values as '∞'.
const MAX_INTL_INTEGER_DIGITS = 308;

function assertIntlRange(integerDigits: number): void {
  if (integerDigits > MAX_INTL_INTEGER_DIGITS) {
    throw new NumericRangeError(
      `Value has ${integerDigits} integer digits, which exceeds what Intl.NumberFormat can represent (about ${MAX_INTL_INTEGER_DIGITS}); format it as a string with Decimal#toString().`,
    );
  }
}

const PLAIN_DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

function isNumericString(value: string): value is `${number}` {
  return PLAIN_DECIMAL.test(value);
}

const MAX_SAFE_BIGINT_FAST = 10n ** 300n;

function integerDigitCount(text: string): number {
  let start = text[0] === '+' || text[0] === '-' ? 1 : 0;
  while (start < text.length - 1 && text[start] === '0') start += 1;
  const dot = text.indexOf('.', start);
  return (dot === -1 ? text.length : dot) - start;
}

function toIntlInput(
  value: FormatValue,
  nf: Intl.NumberFormat,
  rounding: RoundingMode = 'halfUp',
): number | bigint | `${number}` {
  if (typeof value === 'number') {
    assertFinite(value, 'value');
    return value;
  }
  if (typeof value === 'bigint') {
    // A bigint below 2^1024 has at most 309 digits; only longer-looking ones need the exact count.
    if (value > MAX_SAFE_BIGINT_FAST || value < -MAX_SAFE_BIGINT_FAST) {
      assertIntlRange(value.toString().replace('-', '').length);
    }
    return value;
  }
  const text = isDecimal(value) ? value.toString() : value;
  if (typeof text !== 'string')
    throw new TypeError('value must be a number, bigint, Decimal or string; convert other types first');
  if (!isNumericString(text)) {
    throw new NumberFormatError(
      `Cannot format '${text}': not a plain decimal number; pass digits with an optional sign and '.' (e.g. '-1234.50'), or use parseDecimal for locale-formatted text`,
    );
  }
  assertIntlRange(integerDigitCount(text));
  return hasExactStringSupport() ? text : toExactDouble(text, nf, rounding);
}

/** Builds Intl options from the shared ones, filling fraction-digit defaults without creating min > max. */
function baseOptions(options: FormatOptions, defaults: { min?: number; max?: number } = {}): Intl.NumberFormatOptions {
  const result: Intl.NumberFormatOptions = {};
  let min = options.minimumFractionDigits;
  let max = options.maximumFractionDigits;
  if (defaults.min !== undefined || defaults.max !== undefined) {
    if (min === undefined && max === undefined) {
      min = defaults.min;
      max = defaults.max;
    } else if (max === undefined) {
      max = Math.max(defaults.max ?? 0, min ?? 0);
    } else if (min === undefined) {
      min = Math.min(defaults.min ?? 0, max);
    }
  }
  if (min !== undefined) result.minimumFractionDigits = min;
  if (max !== undefined) result.maximumFractionDigits = max;
  if (options.useGrouping !== undefined) result.useGrouping = options.useGrouping;
  if (options.signDisplay !== undefined) result.signDisplay = options.signDisplay;
  const rounding = options.rounding ?? 'halfUp';
  if (rounding !== 'halfUp') result.roundingMode = INTL_ROUNDING[rounding];
  return result;
}

function run(value: FormatValue, options: FormatOptions, intlOptions: Intl.NumberFormatOptions): string {
  const nf = getNumberFormat(options.locale ?? DEFAULT_LOCALE, intlOptions);
  return nf.format(toIntlInput(value, nf, options.rounding));
}

const percentOptions = (options: FormatOptions): Intl.NumberFormatOptions => ({
  ...baseOptions(options, { min: 0, max: 2 }),
  style: 'percent',
});

const compactOptions = (options: CompactOptions): Intl.NumberFormatOptions => ({
  ...baseOptions(options, { min: 0, max: 1 }),
  notation: 'compact',
  compactDisplay: options.display ?? 'short',
});

const currencyOptions = (currency: string, options: CurrencyOptions): Intl.NumberFormatOptions => {
  const intlOptions: Intl.NumberFormatOptions = { ...baseOptions(options), style: 'currency', currency };
  if (options.currencyDisplay !== undefined) intlOptions.currencyDisplay = options.currencyDisplay;
  if (options.accounting) intlOptions.currencySign = 'accounting';
  return intlOptions;
};

/** Formats a number for display: `formatNumber(1234.5)` → `'1,234.5'`. Intl defaults: 0–3 fraction digits. */
export function formatNumber(value: FormatValue, options: FormatOptions = {}): string {
  return run(value, options, baseOptions(options));
}

/**
 * Formats money. Fraction digits come from the currency (2 for USD, 0 for JPY)
 * unless overridden: `formatCurrency(1234.5, 'EUR', { locale: 'de-DE' })` → `'1.234,50 €'`.
 */
export function formatCurrency(value: FormatValue, currency: string, options: CurrencyOptions = {}): string {
  return run(value, options, currencyOptions(currency, options));
}

/**
 * Formats a FRACTION as a percent. The input is a fraction, NOT a percentage:
 * `formatPercent(0.125)` → `'12.5%'`, while `formatPercent(12.5)` → `'1,250%'`.
 * Default 0–2 fraction digits.
 */
export function formatPercent(fraction: FormatValue, options: FormatOptions = {}): string {
  return run(fraction, options, percentOptions(options));
}

/** Short or long compact form: `formatCompact(1230000)` → `'1.2M'`. Default max 1 fraction digit. */
export function formatCompact(value: FormatValue, options: CompactOptions = {}): string {
  return run(value, options, compactOptions(options));
}

const FILE_UNITS = {
  si: { base: 1000, labels: ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB'] },
  iec: { base: 1024, labels: ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'] },
} as const;

/**
 * Human file size: `formatFileSize(1536)` → `'1.5 kB'`. Picks the largest unit
 * where the value is at least 1. The number part is locale-aware; the unit label
 * is appended in English (`Intl` has no IEC units). Very large bigints lose
 * precision beyond 2^53, which is invisible at one fraction digit.
 * Rounding can show `'1000 kB'` for 999999 bytes; it does not promote to MB.
 */
export function formatFileSize(bytes: number | bigint, options: FileSizeOptions = {}): string {
  const nf = getNumberFormat(options.locale ?? DEFAULT_LOCALE, baseOptions(options, { min: 0, max: 1 }));
  return fileSizeWith(bytes, options.system ?? 'si', nf);
}

function fileSizeWith(bytes: number | bigint, system: 'si' | 'iec', nf: Intl.NumberFormat): string {
  const amount = typeof bytes === 'bigint' ? Number(bytes) : bytes;
  assertFinite(amount, 'bytes');
  if (amount < 0)
    throw new InvalidArgumentError(
      `bytes must be non-negative, got ${bytes}; pass Math.abs(bytes) and add the sign yourself`,
    );
  const { base, labels } = FILE_UNITS[system];
  let index = 0;
  let scaled = amount;
  while (index < labels.length - 1 && scaled >= base) {
    scaled /= base;
    index += 1;
  }
  return `${nf.format(scaled)} ${labels[index]}`;
}

export type Formatter = {
  formatNumber(value: FormatValue, options?: FormatOptions): string;
  formatPercent(value: FormatValue, options?: FormatOptions): string;
  formatCompact(value: FormatValue, options?: CompactOptions): string;
  formatFileSize(bytes: number | bigint, options?: FileSizeOptions): string;
  /** Uses the bound currency. */
  formatCurrency(value: FormatValue, options?: CurrencyOptions): string;
  /** An explicit currency overrides the bound one. */
  formatCurrency(value: FormatValue, currency: string, options?: CurrencyOptions): string;
};

function formatWith(nf: Intl.NumberFormat, value: FormatValue): string {
  return nf.format(toIntlInput(value, nf));
}

/**
 * Binds a default locale (and optionally a currency) once. The defaults are
 * copied at creation, so later changes to the caller's object have no effect.
 * Per-call `locale` overrides the default; an explicit currency overrides the
 * bound one. Calls without per-call options reuse a pre-resolved
 * `Intl.NumberFormat` and skip cache-key building.
 * `formatCurrency` with no currency anywhere throws `InvalidArgumentError`.
 */
export function createFormatter(defaults: { locale?: string; currency?: string }): Formatter {
  const locale = defaults.locale;
  const currency = defaults.currency;
  const resolvedLocale = locale ?? DEFAULT_LOCALE;

  const withLocale = <T extends FormatOptions>(options: T | undefined): T =>
    ({
      ...options,
      locale: options?.locale ?? locale,
    }) as T;

  // Resolved on first use, then reused for every call without per-call options.
  const lazy = (build: () => Intl.NumberFormatOptions): (() => Intl.NumberFormat) => {
    let resolved: Intl.NumberFormat | undefined;
    return () => (resolved ??= getNumberFormat(resolvedLocale, build()));
  };
  const plain = lazy(() => baseOptions({}));
  const percent = lazy(() => percentOptions({}));
  const compact = lazy(() => compactOptions({}));
  const fileSize = lazy(() => baseOptions({}, { min: 0, max: 1 }));
  const money = lazy(() => (currency === undefined ? {} : currencyOptions(currency, {})));

  function boundCurrency(
    value: FormatValue,
    currencyOrOptions?: string | CurrencyOptions,
    maybeOptions?: CurrencyOptions,
  ): string {
    const explicit = typeof currencyOrOptions === 'string' ? currencyOrOptions : undefined;
    const options = typeof currencyOrOptions === 'string' ? maybeOptions : currencyOrOptions;
    const chosen = explicit ?? currency;
    if (chosen === undefined) {
      throw new InvalidArgumentError('No currency: pass one or bind it with createFormatter({ currency })');
    }
    if (explicit === undefined && options === undefined) return formatWith(money(), value);
    return formatCurrency(value, chosen, withLocale(options));
  }

  return {
    formatNumber: (value, options) =>
      options === undefined ? formatWith(plain(), value) : formatNumber(value, withLocale(options)),
    formatPercent: (value, options) =>
      options === undefined ? formatWith(percent(), value) : formatPercent(value, withLocale(options)),
    formatCompact: (value, options) =>
      options === undefined ? formatWith(compact(), value) : formatCompact(value, withLocale(options)),
    formatFileSize: (bytes, options) =>
      options === undefined ? fileSizeWith(bytes, 'si', fileSize()) : formatFileSize(bytes, withLocale(options)),
    formatCurrency: boundCurrency,
  };
}
