import { afterEach, describe, expect, it, vi } from 'vitest';

import { decimal } from './decimal.js';
import { InvalidArgumentError, NumberFormatError, NumericRangeError } from './errors.js';
import {
  createFormatter,
  formatCompact,
  formatCurrency,
  formatFileSize,
  formatNumber,
  formatPercent,
  RUNTIME_LOCALE,
} from './format.js';

describe('formatNumber', () => {
  it('formats a Decimal exactly, with no float noise', () => {
    expect(formatNumber(decimal('0.1').plus('0.2'))).toBe('0.3');
  });

  it('keeps every digit of a 30-digit Decimal', () => {
    expect(formatNumber(decimal('123456789012345678901234567890'))).toBe('123,456,789,012,345,678,901,234,567,890');
  });

  it('formats bigint and numeric strings', () => {
    expect(formatNumber(12_345_678_901_234_567_890n)).toBe('12,345,678,901,234,567,890');
    expect(formatNumber('1234.5')).toBe('1,234.5');
  });

  it('honours locale and grouping', () => {
    expect(formatNumber(1234.5, { locale: 'de-DE' })).toBe('1.234,5');
    expect(formatNumber(1234.5, { useGrouping: false })).toBe('1234.5');
  });

  it('rejects non-finite numbers and malformed strings', () => {
    expect(() => formatNumber(Number.NaN)).toThrow(InvalidArgumentError);
    expect(() => formatNumber(Infinity)).toThrow(InvalidArgumentError);
    expect(() => formatNumber('abc')).toThrow(NumberFormatError);
  });

  it('applies the requested rounding mode (ties differ between modes)', () => {
    expect(formatNumber(2.5, { maximumFractionDigits: 0, rounding: 'halfEven' })).toBe('2');
    expect(formatNumber(2.5, { maximumFractionDigits: 0, rounding: 'halfUp' })).toBe('3');
    expect(formatNumber(2.9, { maximumFractionDigits: 0, rounding: 'down' })).toBe('2');
    expect(formatNumber(2.1, { maximumFractionDigits: 0, rounding: 'up' })).toBe('3');
  });

  it('gives the same output on repeated calls (cached formatter)', () => {
    const first = formatNumber(9876.543, { locale: 'fr-FR', maximumFractionDigits: 1 });
    expect(formatNumber(9876.543, { locale: 'fr-FR', maximumFractionDigits: 1 })).toBe(first);
  });
});

describe('formatCurrency', () => {
  it('uses locale conventions', () => {
    expect(formatCurrency(1234.5, 'EUR', { locale: 'de-DE' }).replaceAll('\u00A0', ' ')).toBe('1.234,50 €');
  });

  it('supports accounting negatives', () => {
    expect(formatCurrency(-5, 'USD', { accounting: true })).toBe('($5.00)');
  });

  it('takes fraction digits from the currency', () => {
    expect(formatCurrency(1234, 'JPY', { locale: 'ja-JP' })).toContain('1,234');
  });
});

describe('formatPercent', () => {
  it('takes a fraction, not a percentage', () => {
    expect(formatPercent(0.125)).toBe('12.5%');
    expect(formatPercent(0.153)).toBe('15.3%');
  });

  it('lets the caller narrow the digits', () => {
    expect(formatPercent(0.1256, { maximumFractionDigits: 0 })).toBe('13%');
  });
});

describe('formatCompact', () => {
  it('formats short, long, and with more digits', () => {
    expect(formatCompact(1_230_000)).toBe('1.2M');
    expect(formatCompact(1_230_000, { display: 'long' })).toBe('1.2 million');
    expect(formatCompact(1_230_000, { maximumFractionDigits: 2 })).toBe('1.23M');
  });

  it('formats compact money with a currency', () => {
    expect(formatCompact(1_250_000, { currency: 'USD' })).toBe('$1.3M');
    expect(formatCompact(1_250_000, { currency: 'USD', maximumFractionDigits: 2 })).toBe('$1.25M');
    expect(formatCompact(1_250_000, { currency: 'USD', display: 'long' })).toBe(
      new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        notation: 'compact',
        compactDisplay: 'long',
        minimumFractionDigits: 0,
        maximumFractionDigits: 1,
      }).format(1_250_000),
    );
  });

  it('keeps the exact-input rule: compact money takes whole numbers on the exact path', () => {
    expect(formatCompact('1250000', { currency: 'EUR', locale: 'de-DE' })).toBe(
      new Intl.NumberFormat('de-DE', {
        style: 'currency',
        currency: 'EUR',
        notation: 'compact',
        minimumFractionDigits: 0,
        maximumFractionDigits: 1,
      }).format(1_250_000),
    );
  });
});

describe('formatFileSize', () => {
  it('picks the largest unit with value >= 1', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(999)).toBe('999 B');
    expect(formatFileSize(1000)).toBe('1 kB');
    expect(formatFileSize(1536)).toBe('1.5 kB');
    expect(formatFileSize(1536, { system: 'iec' })).toBe('1.5 KiB');
    expect(formatFileSize(1024, { system: 'iec' })).toBe('1 KiB');
  });

  it('jedec uses powers of 1024 with KB/MB/GB labels', () => {
    expect(formatFileSize(0, { system: 'jedec' })).toBe('0 B');
    expect(formatFileSize(512, { system: 'jedec' })).toBe('512 B');
    expect(formatFileSize(1024, { system: 'jedec' })).toBe('1 KB');
    expect(formatFileSize(1536, { system: 'jedec' })).toBe('1.5 KB');
    expect(formatFileSize(1_048_576, { system: 'jedec' })).toBe('1 MB');
    expect(formatFileSize(1_073_741_824, { system: 'jedec' })).toBe('1 GB');
  });

  it('accepts bigint', () => {
    expect(formatFileSize(5_000_000n)).toBe('5 MB');
  });

  it('rejects negative and non-finite sizes', () => {
    expect(() => formatFileSize(-1)).toThrow(InvalidArgumentError);
    expect(() => formatFileSize(-1n)).toThrow(InvalidArgumentError);
    expect(() => formatFileSize(Infinity)).toThrow(InvalidArgumentError);
  });
});

describe('createFormatter', () => {
  const ro = createFormatter({ locale: 'ro-RO', currency: 'RON' });

  it('uses the bound locale and currency', () => {
    const out = ro.formatCurrency(25);
    expect(out).toContain('25,00');
    expect(out).toContain('RON');
  });

  it('lets an explicit currency and per-call locale override the defaults', () => {
    expect(ro.formatCurrency(25, 'USD', { locale: 'en-US' })).toBe('$25.00');
    expect(ro.formatNumber(1234.5)).toBe('1.234,5');
  });

  it('throws when no currency is available', () => {
    expect(() => createFormatter({ locale: 'en-US' }).formatCurrency(1)).toThrow(InvalidArgumentError);
  });
});

describe('exact-string range and probe', () => {
  it('throws NumericRangeError instead of printing ∞ for values beyond Intl range', () => {
    expect(() => formatNumber(decimal('1'.repeat(400)))).toThrow(NumericRangeError);
    expect(() => formatNumber('9'.repeat(400))).toThrow(NumericRangeError);
    expect(() => formatNumber(10n ** 400n)).toThrow(NumericRangeError);
  });

  it('still formats a 30-digit Decimal exactly', () => {
    expect(formatNumber(decimal('1'.repeat(30)), { useGrouping: false })).toBe('1'.repeat(30));
  });

  it('keeps digits past 2^53 that a Number coercion would destroy', () => {
    expect(formatNumber('9007199254740993', { useGrouping: false })).toBe('9007199254740993');
  });
});

/** Behaves like React Native's Hermes: decimal text goes through a double before formatting. */
class DoubleOnlyNumberFormat extends Intl.NumberFormat {
  override format(value: number | bigint | Intl.StringNumericLiteral): string {
    return super.format(typeof value === 'string' ? Number(value) : value);
  }
}

async function loadWithDoubleOnlyIntl() {
  vi.stubGlobal('Intl', Object.create(Intl, { NumberFormat: { value: DoubleOnlyNumberFormat } }));
  vi.resetModules();
  const [format, exact, errors] = await Promise.all([
    import('./format.js'),
    import('./decimal.js'),
    import('./errors.js'),
  ]);
  return { ...format, decimal: exact.decimal, UnsupportedFeatureError: errors.UnsupportedFeatureError };
}

describe('runtimes whose Intl reads decimal text through a double (Hermes)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('formats money exactly, because amounts fit in 15 digits', async () => {
    const m = await loadWithDoubleOnlyIntl();
    expect(m.formatCurrency(m.decimal('1234.5'), 'EUR', { locale: 'de-DE' })).toBe('1.234,50\u00A0€');
    expect(m.formatCurrency(m.decimal('999999999999.99'), 'USD')).toBe('$999,999,999,999.99');
    expect(m.createFormatter({ currency: 'USD' }).formatCurrency(m.decimal('19.99'))).toBe('$19.99');
  });

  it('rounds the Decimal itself, so a long value still prints the right short result', async () => {
    const m = await loadWithDoubleOnlyIntl();
    // 1.005 as a double is 1.00499999…; exact halfUp rounding must still give 1.01.
    expect(m.formatNumber(m.decimal('1.005'), { maximumFractionDigits: 2 })).toBe('1.01');
    expect(m.formatNumber(m.decimal('0.12345678901234567891'), { maximumFractionDigits: 3 })).toBe('0.123');
    expect(m.formatNumber(m.decimal('2.5'), { maximumFractionDigits: 0, rounding: 'halfEven' })).toBe('2');
    expect(m.formatNumber(m.decimal('-0.001'), { maximumFractionDigits: 2 })).toBe('-0');
    expect(m.formatPercent(m.decimal('0.123456'))).toBe('12.35%');
  });

  it('refuses digits a double would change instead of printing a wrong value', async () => {
    const m = await loadWithDoubleOnlyIntl();
    expect(() => m.formatNumber('9007199254740993', { useGrouping: false })).toThrow(m.UnsupportedFeatureError);
    expect(() => m.formatNumber(m.decimal('1234567890123.456'), { maximumFractionDigits: 3 })).toThrow(
      m.UnsupportedFeatureError,
    );
  });

  it('accepts only whole numbers in compact notation, whose scale depends on the locale', async () => {
    const m = await loadWithDoubleOnlyIntl();
    expect(m.formatCompact(m.decimal('1230000'))).toBe('1.2M');
    expect(() => m.formatCompact(m.decimal('1.25'))).toThrow(m.UnsupportedFeatureError);
  });
});

describe('createFormatter snapshot', () => {
  it('ignores later mutation of the defaults object', () => {
    const defaults = { locale: 'de-DE', currency: 'EUR' };
    const fmt = createFormatter(defaults);
    defaults.locale = 'en-US';
    defaults.currency = 'USD';
    expect(fmt.formatCurrency(1234.5)).toBe(formatCurrency(1234.5, 'EUR', { locale: 'de-DE' }));
    expect(fmt.formatNumber(1234.5)).toBe('1.234,5');
  });

  it('bound calls with and without options agree', () => {
    const fmt = createFormatter({ locale: 'de-DE', currency: 'EUR' });
    expect(fmt.formatPercent(0.125)).toBe(fmt.formatPercent(0.125, {}));
    expect(fmt.formatCompact(1_230_000)).toBe(fmt.formatCompact(1_230_000, {}));
    expect(fmt.formatFileSize(1536)).toBe(fmt.formatFileSize(1536, {}));
  });
});

describe('runtime default locale', () => {
  const sample = 1_234_567.891;

  it('stays en-US unless the caller opts in', () => {
    expect(formatNumber(sample)).toBe('1,234,567.891');
    expect(formatNumber(sample, { locale: undefined })).toBe('1,234,567.891');
  });

  it("forwards locale: 'default' to Intl as no locale, like toLocaleString()", () => {
    const runtime = new Intl.NumberFormat(undefined, {});
    expect(formatNumber(sample, { locale: RUNTIME_LOCALE })).toBe(runtime.format(sample));
    expect(formatNumber(sample, { locale: 'default' })).toBe(sample.toLocaleString());
  });

  it('applies to every formatter', () => {
    const locale = RUNTIME_LOCALE;
    expect(formatCurrency(1234.5, 'USD', { locale })).toBe(
      new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(1234.5),
    );
    expect(formatPercent(0.125, { locale })).toBe(
      new Intl.NumberFormat(undefined, { style: 'percent', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(
        0.125,
      ),
    );
    expect(formatCompact(1_250_000, { locale, currency: 'USD' })).toBe(
      new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: 'USD',
        notation: 'compact',
        minimumFractionDigits: 0,
        maximumFractionDigits: 1,
      }).format(1_250_000),
    );
    expect(formatFileSize(1536, { locale })).toBe(
      `${new Intl.NumberFormat(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 1 }).format(1.536)} kB`,
    );
  });

  it('works through createFormatter, bound or per call', () => {
    const bound = createFormatter({ locale: RUNTIME_LOCALE, currency: 'USD' });
    expect(bound.formatNumber(sample)).toBe(new Intl.NumberFormat(undefined).format(sample));
    expect(bound.formatCurrency(1234.5)).toBe(
      new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(1234.5),
    );
    const english = createFormatter({ locale: 'en-US' });
    expect(english.formatNumber(sample, { locale: RUNTIME_LOCALE })).toBe(
      new Intl.NumberFormat(undefined).format(sample),
    );
  });
});
