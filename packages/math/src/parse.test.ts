import { describe, expect, expectTypeOf, it } from 'vitest';

import { orThrow } from '@arki/failure';

import type { Decimal } from './decimal.js';
import type { MathParseFailure } from './errors.js';
import { InvalidNumber, NumberOutOfRange } from './errors.js';
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

  it('returns InvalidNumber for text that is not a number, because typed text is an expected outcome', () => {
    for (const bad of ['abc', '', ' ', '1.2.3', 'Infinity', 'NaN', '1e', '--1']) {
      expect(InvalidNumber.is(parseNumber(bad)), bad).toBe(true);
    }
    expect(parseNumber('xyz', { locale: 'de-DE' })).toMatchObject({ code: 'math.invalid_number', status: 400 });
  });

  it('types the result as the number or the parse failures, nothing wider', () => {
    expectTypeOf(parseNumber('1')).toEqualTypeOf<number | MathParseFailure>();
    expectTypeOf(parseDecimal('1')).toEqualTypeOf<Decimal | MathParseFailure>();
  });

  it('accepts misplaced group separators because groups are just removed', () => {
    expect(parseNumber('1,23,4')).toBe(1234);
  });

  it('returns NumberOutOfRange when the value overflows a JS number', () => {
    expect(NumberOutOfRange.is(parseNumber('1e400'))).toBe(true);
  });
});

describe('parseDecimal', () => {
  it('parses exactly', () => {
    expect(orThrow(parseDecimal('1,234.56')).toString()).toBe('1234.56');
    expect(orThrow(parseDecimal('1.234,56', { locale: 'de-DE' })).toString()).toBe('1234.56');
  });

  it('keeps all 30 digits', () => {
    expect(orThrow(parseDecimal('123456789012345678901234567890')).toString()).toBe('123456789012345678901234567890');
    expect(orThrow(parseDecimal('0.123456789012345678901234567890')).toString()).toBe(
      '0.123456789012345678901234567890',
    );
  });

  it('succeeds where parseNumber overflows', () => {
    expect(orThrow(parseDecimal('1e400')).toString()).toBe(`1${'0'.repeat(400)}`);
  });

  it('returns InvalidNumber for garbage', () => {
    expect(InvalidNumber.is(parseDecimal('abc'))).toBe(true);
  });

  it('returns NumberOutOfRange when the text passes the digit or scale limit, instead of throwing', () => {
    expect(NumberOutOfRange.is(parseDecimal('1'.repeat(10_001)))).toBe(true);
    expect(NumberOutOfRange.is(parseDecimal('1e10001'))).toBe(true);
    expect(NumberOutOfRange.is(parseDecimal('1e-10001'))).toBe(true);
  });
});

describe('explicit symbols', () => {
  it('parses without Intl, for runtimes that lack formatToParts (Hermes on iOS)', () => {
    const german = { symbols: { decimal: ',', group: '.' } };
    expect(parseNumber('1.234,56', german)).toBe(1234.56);
    expect(orThrow(parseDecimal('-1.234.567,891', german)).toString()).toBe('-1234567.891');
    expect(parseNumber('\u22125', german)).toBe(-5);
  });

  it('reads custom digits and space groups', () => {
    const arabic = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
    expect(parseNumber('١٢٣٫٥', { symbols: { decimal: '٫', group: '٬', digits: arabic } })).toBe(123.5);
    expect(parseNumber('1\u202F234,5', { symbols: { decimal: ',', group: '\u202F' } })).toBe(1234.5);
  });

  it('returns InvalidNumber when the text does not fit the given symbols', () => {
    expect(InvalidNumber.is(parseNumber('1,2,3', { symbols: { decimal: ',', group: '.' } }))).toBe(true);
  });
});

describe('localeNumberSymbols', () => {
  it('reports en-US and de-DE symbols', () => {
    expect(localeNumberSymbols('en-US')).toMatchObject({ decimal: '.', group: ',', minusSign: '-' });
    expect(localeNumberSymbols('de-DE')).toMatchObject({ decimal: ',', group: '.' });
    expect(localeNumberSymbols('en-US').digits).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
  });
});

describe('long runs of spaces in outside text', () => {
  it('parseNumber and parseDecimal trim 200,000 spaces in linear time, not quadratic', () => {
    const text = `1${' '.repeat(200_000)}x`;
    const start = Date.now();
    expect(InvalidNumber.is(parseNumber(text))).toBe(true);
    expect(InvalidNumber.is(parseDecimal(text))).toBe(true);
    expect(InvalidNumber.is(parseDecimal(text, { locale: 'fr-FR' }))).toBe(true);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('still trims the spaces and no-break spaces around a number', () => {
    expect(parseNumber(`${' '.repeat(50_000)}12.5\u00A0\u202F\t `)).toBe(12.5);
  });
});

describe('a malformed locale tag', () => {
  it('falls back to the default locale instead of throwing a RangeError', () => {
    expect(parseNumber('1,234.5', { locale: 'not a locale' })).toBe(1234.5);
    expect(parseNumber('1,234.5', { locale: '' })).toBe(1234.5);
    expect(localeNumberSymbols('xx_yy').decimal).toBe('.');
  });
});
