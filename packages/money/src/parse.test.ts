import { describe, expect, it } from 'vitest';

import { orThrow } from '@arki/failure';

import type { Money } from './index.js';
import { InputTooLarge, InvalidMoneyText, RoundingNecessary, UnsupportedLocale } from './failures.js';
import { formatMoney } from './format.js';
import { Currency, money } from './index.js';
import { createMoneyParser, parseMoney } from './parse.js';

const NBSP = String.fromCodePoint(160);
const NNBSP = String.fromCodePoint(8239);
const LRM = String.fromCodePoint(8206);

describe('parseMoney', () => {
  it('reads each locale’s own format', () => {
    expect(orThrow(parseMoney('1.234,56 €', 'EUR', { locale: 'de-DE' })).toString()).toBe('1234.56 EUR');
    expect(orThrow(parseMoney('$1,234.56', 'USD')).toString()).toBe('1234.56 USD');
    expect(orThrow(parseMoney(`1${NNBSP}234,56${NBSP}€`, 'EUR', { locale: 'fr-FR' })).toString()).toBe('1234.56 EUR');
    expect(orThrow(parseMoney('1 234,56 €', 'EUR', { locale: 'fr-FR' })).toString()).toBe('1234.56 EUR');
    expect(orThrow(parseMoney('₹1,23,456.78', 'INR', { locale: 'en-IN' })).toString()).toBe('123456.78 INR');
    expect(orThrow(parseMoney('¥1,234', 'JPY', { locale: 'ja-JP' })).toString()).toBe('1234 JPY');
    expect(orThrow(parseMoney('١٬٢٣٤٫٥٠ ج.م.‏', 'EGP', { locale: 'ar-EG' })).toString()).toBe('1234.50 EGP');
  });

  it('accepts ungrouped digits, the ISO code, signs and accounting parentheses', () => {
    expect(orThrow(parseMoney('1234.5', 'USD')).toString()).toBe('1234.50 USD');
    expect(orThrow(parseMoney('USD 5', 'USD')).toString()).toBe('5.00 USD');
    expect(orThrow(parseMoney('5 USD', 'USD')).toString()).toBe('5.00 USD');
    expect(orThrow(parseMoney('-$5', 'USD')).toString()).toBe('-5.00 USD');
    expect(orThrow(parseMoney('$-5', 'USD')).toString()).toBe('-5.00 USD');
    expect(orThrow(parseMoney('($1,234.56)', 'USD')).toString()).toBe('-1234.56 USD');
    expect(orThrow(parseMoney(`${LRM}-5,00 €`, 'EUR', { locale: 'de-DE' })).toString()).toBe('-5.00 EUR');
  });

  it('lets the expected currency resolve an ambiguous symbol', () => {
    expect(orThrow(parseMoney('$10', 'CAD')).toString()).toBe('10.00 CAD');
    expect(orThrow(parseMoney('CA$10', 'CAD')).toString()).toBe('10.00 CAD');
  });

  it('refuses instead of guessing', () => {
    const bad: [string, string, string?][] = [
      ['1,23,4', 'USD'],
      ['1,2345.00', 'USD'],
      ['$1.234,56', 'USD'],
      ['1,234.56', 'EUR', 'de-DE'],
      ['1.2.3', 'USD'],
      ['€5', 'USD'],
      ['$5 USD', 'USD'],
      ['--5', 'USD'],
      ['-(5)', 'USD'],
      ['5 dollars', 'USD'],
      ['', 'USD'],
      ['5.', 'USD'],
      ['١2', 'EGP', 'ar-EG'],
    ];
    for (const [text, code, locale] of bad) {
      expect(InvalidMoneyText.is(parseMoney(text, code, { locale })), `${text} (${locale ?? 'en-US'})`).toBe(true);
    }
  });

  it('never drops digits silently', () => {
    expect(RoundingNecessary.is(parseMoney('1.005', 'USD'))).toBe(true);
    expect(orThrow(parseMoney('1.005', 'USD', { rounding: 'halfUp' })).toString()).toBe('1.01 USD');
    expect(orThrow(parseMoney('0.1234', 'USD', { scale: 4 })).toString()).toBe('0.1234 USD');
  });

  it('round-trips what formatMoney writes', () => {
    const cases: [Money, string][] = [
      [money('-1234567.89', 'EUR'), 'de-DE'],
      [money('1234567.89', 'EUR'), 'fr-FR'],
      [money('1234567.89', 'INR'), 'en-IN'],
      [money('1234567', 'JPY'), 'ja-JP'],
      [money('1234567.5', 'CHF'), 'de-CH'],
      [money('-1234.5', 'USD'), 'en-US'],
    ];
    for (const [value, locale] of cases) {
      const text = formatMoney(value, { locale });
      expect(orThrow(parseMoney(text, value.currency.code, { locale })).eq(value), `${text} (${locale})`).toBe(true);
    }
  });
});

describe('createMoneyParser', () => {
  it('binds the grammar once and returns failures for forms instead of throwing', () => {
    const parser = orThrow(createMoneyParser('EUR', { locale: 'de-DE' }));
    expect(orThrow(parser.parse('12,50 €')).toString()).toBe('12.50 EUR');
    // A form shows the person why; a dropped decimal would be a wrong amount.
    expect(RoundingNecessary.is(parser.parse('12,505 €'))).toBe(true);
    expect(InvalidMoneyText.is(parser.parse('abc'))).toBe(true);
    expect(InputTooLarge.is(parser.parse('1'.repeat(2000)))).toBe(true);
  });

  it('returns UnsupportedLocale for a locale tag from outside that Intl rejects', () => {
    // Locales often come from Accept-Language, so a bad one is an expected outcome, not a bug.
    expect(UnsupportedLocale.is(createMoneyParser('EUR', { locale: 'not a locale!' }))).toBe(true);
    expect(UnsupportedLocale.is(parseMoney('5', 'EUR', { locale: 'not a locale!' }))).toBe(true);
  });

  it('works without Intl when given the separators', () => {
    const parser = orThrow(createMoneyParser('EUR', { symbols: { decimal: ',', group: '.', currency: ['€'] } }));
    expect(orThrow(parser.parse('€ 1.234,56')).toString()).toBe('1234.56 EUR');
    const indian = orThrow(createMoneyParser('INR', { symbols: { decimal: '.', group: ',', groupSizes: [3, 2] } }));
    expect(orThrow(indian.parse('12,34,567.00')).toString()).toBe('1234567.00 INR');
    expect(InvalidMoneyText.is(indian.parse('1,234,567.00'))).toBe(true);
  });

  it('parses custom currencies by code', () => {
    const btc = Currency.custom({ code: 'BTC', scale: 8 });
    expect(orThrow(parseMoney('0.00012 BTC', btc)).toString()).toBe('0.00012000 BTC');
  });
});
