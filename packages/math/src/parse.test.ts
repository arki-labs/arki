import { describe, expect, it } from 'vitest';

import { NumberFormatError, NumericRangeError } from './errors.js';
import { localeNumberSymbols, parseDecimal, parseNumber } from './parse.js';

describe('parseNumber', () => {
  it('parses en-US by default', () => {
    expect(parseNumber('1,234.56')).toBe(1234.56);
    expect(parseNumber('+7')).toBe(7);
    expect(parseNumber('-.5')).toBe(-0.5);
  });

  it('lets the locale decide what the separators mean', () => {
    expect(parseNumber('1.234')).toBe(1.234);
    expect(parseNumber('1.234', { locale: 'de-DE' })).toBe(1234);
    expect(parseNumber('1.234,56', { locale: 'de-DE' })).toBe(1234.56);
  });

  it('accepts both narrow no-break and plain spaces as fr-FR groups', () => {
    expect(parseNumber('1\u202F234,56', { locale: 'fr-FR' })).toBe(1234.56);
    expect(parseNumber('1\u00A0234,56', { locale: 'fr-FR' })).toBe(1234.56);
    expect(parseNumber('1 234,56', { locale: 'fr-FR' })).toBe(1234.56);
  });

  it('accepts the Unicode minus', () => {
    expect(parseNumber('\u22125', { locale: 'sv-SE' })).toBe(-5);
    expect(parseNumber('\u22125')).toBe(-5);
  });

  it('parses locale digits built from the symbols the runtime reports', () => {
    const { digits, decimal: dec } = localeNumberSymbols('ar-EG');
    const text = `${digits[1]}${digits[2]}${digits[3]}${dec}${digits[4]}${digits[5]}`;
    expect(parseNumber(text, { locale: 'ar-EG' })).toBe(123.45);
  });

  it('rejects text that is not a number', () => {
    for (const bad of ['abc', '', ' ', '1.2.3', 'Infinity', 'NaN', '1e', '--1']) {
      expect(() => parseNumber(bad)).toThrow(NumberFormatError);
    }
  });

  it('error message names the input and the locale', () => {
    expect(() => parseNumber('xyz', { locale: 'de-DE' })).toThrow(/xyz.*de-DE/);
  });

  it('accepts misplaced group separators because groups are just removed', () => {
    expect(parseNumber('1,23,4')).toBe(1234);
  });

  it('throws NumericRangeError when the value overflows a JS number', () => {
    expect(() => parseNumber('1e400')).toThrow(NumericRangeError);
  });
});

describe('parseDecimal', () => {
  it('parses exactly', () => {
    expect(parseDecimal('1,234.56').toString()).toBe('1234.56');
    expect(parseDecimal('1.234,56', { locale: 'de-DE' }).toString()).toBe('1234.56');
  });

  it('keeps all 30 digits', () => {
    expect(parseDecimal('123456789012345678901234567890').toString()).toBe('123456789012345678901234567890');
    expect(parseDecimal('0.123456789012345678901234567890').toString()).toBe('0.123456789012345678901234567890');
  });

  it('succeeds where parseNumber overflows', () => {
    expect(() => parseDecimal('1e400')).not.toThrow();
  });

  it('rejects garbage', () => {
    expect(() => parseDecimal('abc')).toThrow(NumberFormatError);
  });
});

describe('explicit symbols', () => {
  it('parses without Intl, for runtimes that lack formatToParts (Hermes on iOS)', () => {
    const german = { symbols: { decimal: ',', group: '.' } };
    expect(parseNumber('1.234,56', german)).toBe(1234.56);
    expect(parseDecimal('-1.234.567,891', german).toString()).toBe('-1234567.891');
    expect(parseNumber('\u22125', german)).toBe(-5);
  });

  it('reads custom digits and space groups', () => {
    const arabic = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
    expect(parseNumber('١٢٣٫٥', { symbols: { decimal: '٫', group: '٬', digits: arabic } })).toBe(123.5);
    expect(parseNumber('1\u202F234,5', { symbols: { decimal: ',', group: '\u202F' } })).toBe(1234.5);
  });

  it('names the symbols in the error, not a locale', () => {
    expect(() => parseNumber('1,2,3', { symbols: { decimal: ',', group: '.' } })).toThrow(
      "Cannot parse '1,2,3' as a number with decimal mark ',' and group separator '.'",
    );
  });
});

describe('localeNumberSymbols', () => {
  it('reports en-US and de-DE symbols', () => {
    expect(localeNumberSymbols('en-US')).toMatchObject({ decimal: '.', group: ',', minusSign: '-' });
    expect(localeNumberSymbols('de-DE')).toMatchObject({ decimal: ',', group: '.' });
    expect(localeNumberSymbols('en-US').digits).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
  });
});
