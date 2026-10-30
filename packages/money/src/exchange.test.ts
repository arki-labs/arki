import { describe, expect, it } from 'vitest';

import { ratio } from '@arki/math/rational';

import { toRational } from './exact.js';
import { convert, createConverter, exchangeRate, parseRates, ratesFrom } from './exchange.js';
import { AmountOutOfRange, InvalidExchangeRate, InvalidMoneyText, UnknownCurrency } from './failures.js';
import {
  CurrencyMismatchError,
  ExchangeRateError,
  InvalidArgumentError,
  Money,
  money,
  RoundingNecessaryError,
  UnknownCurrencyError,
} from './index.js';

const ecb = ratesFrom({ base: 'EUR', rates: { USD: '1.0832', GBP: '0.8571', JPY: '161.25' } });

describe('exchange rates', () => {
  it('stores rates as exact fractions', () => {
    const rate = exchangeRate('EUR', 'USD', '1.0832');
    expect(rate.toString()).toBe('EUR/USD 1.0832');
    expect([rate.numerator, rate.denominator]).toEqual([677, 625]);
    expect(rate.inverse().toString()).toBe('USD/EUR 625/677');
    expect(rate.inverse().inverse().eq(rate)).toBe(true);
  });

  it('chains rates exactly', () => {
    const usdToGbp = exchangeRate('EUR', 'USD', '1.0832')
      .inverse()
      .chain(exchangeRate('EUR', 'GBP', '0.8571'));
    expect(usdToGbp.toString()).toBe('USD/GBP 8571/10832');
    // @ts-expect-error -- a EUR→USD rate cannot be followed by a EUR→GBP rate
    expect(() => exchangeRate('EUR', 'USD', 2).chain(exchangeRate('EUR', 'GBP', 1))).toThrow(CurrencyMismatchError);
  });

  it('rejects zero, negative and self rates other than 1', () => {
    expect(() => exchangeRate('EUR', 'USD', 0)).toThrow(ExchangeRateError);
    expect(() => exchangeRate('EUR', 'USD', '-1.2')).toThrow(ExchangeRateError);
    expect(() => exchangeRate('EUR', 'EUR', 2)).toThrow(ExchangeRateError);
    expect(exchangeRate('EUR', 'EUR', 1).toString()).toBe('EUR/EUR 1');
  });

  it('is not mistaken for a promise', async () => {
    const rate = exchangeRate('EUR', 'USD', 2);
    expect(await Promise.resolve(rate)).toBe(rate);
  });
});

describe('convert', () => {
  it('converts with one rate and the quote currency’s scale', () => {
    const usd = exchangeRate('EUR', 'USD', '1.0832');
    const jpy = exchangeRate('EUR', 'JPY', '161.25');
    expect(convert(money(100, 'EUR'), usd).toString()).toBe('108.32 USD');
    expect(convert(money('12.34', 'EUR'), jpy, { rounding: 'halfEven' }).toString()).toBe('1990 JPY');
    expect(() => convert(money('12.34', 'EUR'), jpy)).toThrow(RoundingNecessaryError);
    // @ts-expect-error -- a USD amount cannot use a EUR→USD rate
    expect(() => convert(money(1, 'USD'), usd)).toThrow(CurrencyMismatchError);
  });
});

describe('Converter', () => {
  it('uses direct rates only unless told otherwise', () => {
    const direct = createConverter(ecb);
    expect(direct.convert(money(100, 'EUR'), 'USD').toString()).toBe('108.32 USD');
    expect(() => direct.convert(money(100, 'USD'), 'EUR', { rounding: 'halfEven' })).toThrow(ExchangeRateError);
    expect(direct.has('USD', 'EUR')).toBe(false);

    const both = createConverter(ecb, { inverse: true });
    expect(() => both.convert(money(100, 'USD'), 'EUR')).toThrow(RoundingNecessaryError);
    expect(both.convert(money(100, 'USD'), 'EUR', { rounding: 'halfEven' }).toString()).toBe('92.32 EUR');
  });

  it('routes through a base currency and rounds once at the end', () => {
    const converter = createConverter(ecb, { inverse: true, via: 'EUR' });
    const amount = money('1234.56', 'USD');
    const once = converter.convert(amount, 'GBP', { rounding: 'halfEven' });
    const exact = toRational(amount).times(ratio(625, 677)).times(ratio(8571, 10_000));
    expect(once.eq(money(exact, 'GBP', { rounding: 'halfEven' }))).toBe(true);

    const twice = converter.convert(converter.convert(amount, 'EUR', { rounding: 'halfEven' }), 'GBP', {
      rounding: 'halfEven',
    });
    expect(once.toString()).toBe('976.87 GBP');
    expect(twice.toString()).toBe('976.86 GBP'); // rounding twice drifts by a cent
  });

  it('converts within one currency by changing only the scale', () => {
    const converter = createConverter([]);
    expect(converter.convert(money('1.5', 'EUR'), 'EUR', { scale: 4 }).toString()).toBe('1.5000 EUR');
  });

  it('refuses conflicting rates for one pair', () => {
    expect(() => createConverter([exchangeRate('EUR', 'USD', '1.08'), exchangeRate('EUR', 'USD', '1.09')])).toThrow(
      ExchangeRateError,
    );
    expect(() =>
      createConverter([exchangeRate('EUR', 'USD', '1.08'), exchangeRate('EUR', 'USD', '1.080')]),
    ).not.toThrow();
  });

  it('returns the exact rate it used', () => {
    const converter = createConverter(ecb, { inverse: true, via: 'EUR' });
    expect(converter.rate('GBP', 'JPY').toString()).toBe('GBP/JPY 537500/2857');
    expect(Money.of(money(1, 'GBP'), 'GBP').currency.code).toBe('GBP');
  });
});

// A rate table usually comes from a feed, so one bad entry is an expected outcome, not a crash.
describe('parseRates', () => {
  it('reads a feed into exact rates', () => {
    const rates = parseRates({ base: 'EUR', rates: { USD: '1.0832', JPY: 161.25 } });
    expect(Array.isArray(rates) && rates.map(rate => rate.toString())).toEqual(['EUR/USD 1.0832', 'EUR/JPY 161.25']);
  });

  it('returns a failure for a bad code or value instead of throwing', () => {
    expect(UnknownCurrency.is(parseRates({ base: 'EUR', rates: { XYZ: '1.5' } }))).toBe(true);
    expect(UnknownCurrency.is(parseRates({ base: 'ZZZ', rates: { USD: '1.5' } }))).toBe(true);
    expect(InvalidMoneyText.is(parseRates({ base: 'EUR', rates: { USD: 'n/a' } }))).toBe(true);
    expect(AmountOutOfRange.is(parseRates({ base: 'EUR', rates: { USD: Number.NaN } }))).toBe(true);
    expect(InvalidExchangeRate.is(parseRates({ base: 'EUR', rates: { USD: '0' } }))).toBe(true);
    expect(InvalidExchangeRate.is(parseRates({ base: 'EUR', rates: { USD: '-1.2' } }))).toBe(true);
    expect(InvalidExchangeRate.is(parseRates({ base: 'EUR', rates: { EUR: '2' } }))).toBe(true);
  });

  it('keeps ratesFrom as the throwing builder for tables in your own code', () => {
    expect(() => ratesFrom({ base: 'EUR', rates: { USD: '0' } })).toThrow(ExchangeRateError);
    expect(() => ratesFrom({ base: 'EUR', rates: { XYZ: '1' } })).toThrow(UnknownCurrencyError);
  });
});

// A scale is checked before pow10 runs: a huge scale would otherwise build a giant bigint and crash with a RangeError.
describe('conversion scale', () => {
  it('refuses a scale outside 0 to 100 in every conversion path', () => {
    const rate = exchangeRate('EUR', 'USD', '1.0832');
    const converter = createConverter(ecb);
    expect(() => convert(money(1, 'EUR'), rate, { scale: 1e10 })).toThrow(InvalidArgumentError);
    expect(() => converter.convert(money(1, 'EUR'), 'USD', { scale: 1e10 })).toThrow(InvalidArgumentError);
    expect(() => converter.convert(money(1, 'EUR'), 'EUR', { scale: 1e10 })).toThrow(InvalidArgumentError);
    expect(() => convert(money(1, 'EUR'), rate, { scale: -1 })).toThrow(InvalidArgumentError);
  });
});
