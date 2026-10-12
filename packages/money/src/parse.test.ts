import { describe, expect, it } from 'vitest';

import type { Money } from './index.js';
import { formatMoney } from './format.js';
import { Currency, money, NumberFormatError, RoundingNecessaryError } from './index.js';
import { createMoneyParser, parseMoney } from './parse.js';

const NBSP = String.fromCodePoint(160);
const NNBSP = String.fromCodePoint(8239);
const LRM = String.fromCodePoint(8206);

describe('parseMoney', () => {
  it('reads each locale’s own format', () => {
    expect(parseMoney('1.234,56 €', 'EUR', { locale: 'de-DE' }).toString()).toBe('1234.56 EUR');
    expect(parseMoney('$1,234.56', 'USD').toString()).toBe('1234.56 USD');
    expect(parseMoney(`1${NNBSP}234,56${NBSP}€`, 'EUR', { locale: 'fr-FR' }).toString()).toBe('1234.56 EUR');
    expect(parseMoney('1 234,56 €', 'EUR', { locale: 'fr-FR' }).toString()).toBe('1234.56 EUR');
    expect(parseMoney('₹1,23,456.78', 'INR', { locale: 'en-IN' }).toString()).toBe('123456.78 INR');
    expect(parseMoney('¥1,234', 'JPY', { locale: 'ja-JP' }).toString()).toBe('1234 JPY');
    expect(parseMoney('١٬٢٣٤٫٥٠ ج.م.‏', 'EGP', { locale: 'ar-EG' }).toString()).toBe('1234.50 EGP');
  });

  it('accepts ungrouped digits, the ISO code, signs and accounting parentheses', () => {
    expect(parseMoney('1234.5', 'USD').toString()).toBe('1234.50 USD');
    expect(parseMoney('USD 5', 'USD').toString()).toBe('5.00 USD');
    expect(parseMoney('5 USD', 'USD').toString()).toBe('5.00 USD');
    expect(parseMoney('-$5', 'USD').toString()).toBe('-5.00 USD');
    expect(parseMoney('$-5', 'USD').toString()).toBe('-5.00 USD');
    expect(parseMoney('($1,234.56)', 'USD').toString()).toBe('-1234.56 USD');
    expect(parseMoney(`${LRM}-5,00 €`, 'EUR', { locale: 'de-DE' }).toString()).toBe('-5.00 EUR');
  });

  it('lets the expected currency resolve an ambiguous symbol', () => {
    expect(parseMoney('$10', 'CAD').toString()).toBe('10.00 CAD');
    expect(parseMoney('CA$10', 'CAD').toString()).toBe('10.00 CAD');
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
      expect(() => parseMoney(text, code, { locale }), `${text} (${locale ?? 'en-US'})`).toThrow(NumberFormatError);
    }
  });

  it('never drops digits silently', () => {
    expect(() => parseMoney('1.005', 'USD')).toThrow(RoundingNecessaryError);
    expect(parseMoney('1.005', 'USD', { rounding: 'halfUp' }).toString()).toBe('1.01 USD');
    expect(parseMoney('0.1234', 'USD', { scale: 4 }).toString()).toBe('0.1234 USD');
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
      expect(parseMoney(text, value.currency.code, { locale }).eq(value), `${text} (${locale})`).toBe(true);
    }
  });
});

describe('createMoneyParser', () => {
  it('binds the grammar once and offers tryParse for forms', () => {
    const parser = createMoneyParser('EUR', { locale: 'de-DE' });
    expect(parser.parse('12,50 €').toString()).toBe('12.50 EUR');
    expect(parser.tryParse('12,505 €')).toBeUndefined();
    expect(parser.tryParse('abc')).toBeUndefined();
  });

  it('works without Intl when given the separators', () => {
    const parser = createMoneyParser('EUR', { symbols: { decimal: ',', group: '.', currency: ['€'] } });
    expect(parser.parse('€ 1.234,56').toString()).toBe('1234.56 EUR');
    const indian = createMoneyParser('INR', { symbols: { decimal: '.', group: ',', groupSizes: [3, 2] } });
    expect(indian.parse('12,34,567.00').toString()).toBe('1234567.00 INR');
    expect(() => indian.parse('1,234,567.00')).toThrow(NumberFormatError);
  });

  it('parses custom currencies by code', () => {
    const btc = Currency.custom({ code: 'BTC', scale: 8 });
    expect(parseMoney('0.00012 BTC', btc).toString()).toBe('0.00012000 BTC');
  });
});
