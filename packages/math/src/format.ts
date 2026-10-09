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
import { isDecimal } from './decimal.js';
import { InvalidArgumentError, NumberFormatError, UnsupportedFeatureError } from './errors.js';
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

function cacheKey(locale: string, options: Intl.NumberFormatOptions): string {
  const sorted = Object.entries(options).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${locale}|${JSON.stringify(sorted)}`;
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

function assertExactStringSupport(): void {
  exactStringsSupported ??=
    new Intl.NumberFormat('en-US', { maximumFractionDigits: 20, useGrouping: false }).format('0.30000000000000004') ===
    '0.30000000000000004';
  if (!exactStringsSupported) {
    throw new UnsupportedFeatureError(
      'This runtime cannot format decimal strings exactly (Intl.NumberFormat v3 is missing); pass a number or bigint instead.',
    );
  }
}

const PLAIN_DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

function isNumericString(value: string): value is `${number}` {
  return PLAIN_DECIMAL.test(value);
}

function toIntlInput(value: FormatValue): number | bigint | `${number}` {
  if (typeof value === 'number') {
    assertFinite(value, 'value');
    return value;
  }
  if (typeof value === 'bigint') return value;
  const text = isDecimal(value) ? value.toString() : value;
  if (typeof text !== 'string') throw new TypeError('value must be a number, bigint, Decimal or string');
  if (!isNumericString(text)) {
    throw new NumberFormatError(`Cannot format '${text}': not a plain decimal number`);
  }
  assertExactStringSupport();
  return text;
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
  const input = toIntlInput(value);
  return getNumberFormat(options.locale ?? DEFAULT_LOCALE, intlOptions).format(input);
}

/** Formats a number for display: `formatNumber(1234.5)` → `'1,234.5'`. Intl defaults: 0–3 fraction digits. */
export function formatNumber(value: FormatValue, options: FormatOptions = {}): string {
  return run(value, options, baseOptions(options));
}

/**
 * Formats money. Fraction digits come from the currency (2 for USD, 0 for JPY)
 * unless overridden: `formatCurrency(1234.5, 'EUR', { locale: 'de-DE' })` → `'1.234,50 €'`.
 */
export function formatCurrency(value: FormatValue, currency: string, options: CurrencyOptions = {}): string {
  const intlOptions: Intl.NumberFormatOptions = { ...baseOptions(options), style: 'currency', currency };
  if (options.currencyDisplay !== undefined) intlOptions.currencyDisplay = options.currencyDisplay;
  if (options.accounting) intlOptions.currencySign = 'accounting';
  return run(value, options, intlOptions);
}

/** Formats a FRACTION as a percent: `formatPercent(0.125)` → `'12.5%'`. Default 0–2 fraction digits. */
export function formatPercent(fraction: FormatValue, options: FormatOptions = {}): string {
  return run(fraction, options, { ...baseOptions(options, { min: 0, max: 2 }), style: 'percent' });
}

/** Short or long compact form: `formatCompact(1230000)` → `'1.2M'`. Default max 1 fraction digit. */
export function formatCompact(value: FormatValue, options: CompactOptions = {}): string {
  return run(value, options, {
    ...baseOptions(options, { min: 0, max: 1 }),
    notation: 'compact',
    compactDisplay: options.display ?? 'short',
  });
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
  const amount = typeof bytes === 'bigint' ? Number(bytes) : bytes;
  assertFinite(amount, 'bytes');
  if (amount < 0) throw new InvalidArgumentError(`bytes must be non-negative, got ${bytes}`);
  const { base, labels } = FILE_UNITS[options.system ?? 'si'];
  let index = 0;
  let scaled = amount;
  while (index < labels.length - 1 && scaled >= base) {
    scaled /= base;
    index += 1;
  }
  const text = run(scaled, options, baseOptions(options, { min: 0, max: 1 }));
  return `${text} ${labels[index]}`;
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

/**
 * Binds a default locale (and optionally a currency) once. Per-call `locale`
 * overrides the default; an explicit currency overrides the bound one.
 * `formatCurrency` with no currency anywhere throws `InvalidArgumentError`.
 */
export function createFormatter(defaults: { locale?: string; currency?: string }): Formatter {
  const withLocale = <T extends FormatOptions>(options: T | undefined): T =>
    ({
      ...options,
      locale: options?.locale ?? defaults.locale,
    }) as T;

  function boundCurrency(
    value: FormatValue,
    currencyOrOptions?: string | CurrencyOptions,
    maybeOptions?: CurrencyOptions,
  ): string {
    const explicit = typeof currencyOrOptions === 'string' ? currencyOrOptions : undefined;
    const options = typeof currencyOrOptions === 'string' ? maybeOptions : currencyOrOptions;
    const currency = explicit ?? defaults.currency;
    if (currency === undefined) {
      throw new InvalidArgumentError('No currency: pass one or bind it with createFormatter({ currency })');
    }
    return formatCurrency(value, currency, withLocale(options));
  }

  return {
    formatNumber: (value, options) => formatNumber(value, withLocale(options)),
    formatPercent: (value, options) => formatPercent(value, withLocale(options)),
    formatCompact: (value, options) => formatCompact(value, withLocale(options)),
    formatFileSize: (bytes, options) => formatFileSize(bytes, withLocale(options)),
    formatCurrency: boundCurrency,
  };
}
