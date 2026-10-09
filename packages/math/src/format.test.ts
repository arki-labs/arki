import { describe, expect, it } from 'vitest';

import { decimal } from './decimal.js';
import { InvalidArgumentError, NumberFormatError } from './errors.js';
import {
  createFormatter,
  formatCompact,
  formatCurrency,
  formatFileSize,
  formatNumber,
  formatPercent,
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
