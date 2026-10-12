import { describe, expect, it } from 'vitest';

import { ratio } from '@arki/math/rational';

import { MoneyBag } from './bag.js';
import { createConverter, ratesFrom } from './exchange.js';
import {
  CurrencyMismatchError,
  DivisionByZeroError,
  ExchangeRateError,
  InvalidArgumentError,
  money,
  RoundingNecessaryError,
} from './index.js';
import { isRationalMoney, RationalMoney } from './rational.js';

describe('RationalMoney', () => {
  it('keeps every step exact and rounds once when settled', () => {
    const share = RationalMoney.from(money(100, 'EUR')).dividedBy(3).times('1.19');
    expect(share.toString()).toBe('119/3 EUR');
    expect(() => share.toMoney()).toThrow(RoundingNecessaryError);
    expect(share.toMoney({ rounding: 'halfEven' }).toString()).toBe('39.67 EUR');
    expect(share.times(3).toMoney().toString()).toBe('119.00 EUR');
  });

  it('beats rounding at every step', () => {
    // Three thirds of 100 EUR, each rounded, add up to 99.99. Exact thirds add up to 100.
    const third = RationalMoney.of(100, 'EUR').dividedBy(3);
    const exact = third.plus(third).plus(third).toMoney();
    const rounded = money(100, 'EUR').dividedBy(3, 'halfEven');
    expect(exact.toString()).toBe('100.00 EUR');
    expect(rounded.plus(rounded).plus(rounded).toString()).toBe('99.99 EUR');
  });

  it('mixes freely with Money of the same currency and refuses other currencies', () => {
    const half = RationalMoney.of('1/2', 'EUR');
    expect(half.plus(money('0.25', 'EUR')).toString()).toBe('3/4 EUR');
    expect(half.gt(money('0.49', 'EUR'))).toBe(true);
    // @ts-expect-error -- EUR and USD do not mix
    expect(() => half.plus(money(1, 'USD'))).toThrow(CurrencyMismatchError);
    expect(() => half.dividedBy(0)).toThrow(DivisionByZeroError);
  });

  it('accepts fractions, decimals and Rationals', () => {
    expect(RationalMoney.of(ratio(2, 6), 'EUR').toString()).toBe('1/3 EUR');
    expect(RationalMoney.of('19.99', 'EUR').toString()).toBe('1999/100 EUR');
    expect(RationalMoney.of('1/3', 'EUR').percentage(30).toString()).toBe('1/10 EUR');
    expect(RationalMoney.of('-1/3', 'EUR').abs().sign()).toBe(1);
  });

  it('round-trips JSON and never becomes a float', () => {
    const third = RationalMoney.of('1/3', 'EUR');
    expect(JSON.stringify(third)).toBe('{"amount":"1/3","currency":"EUR"}');
    const sent = JSON.stringify(third);
    expect(RationalMoney.fromJSON(JSON.parse(sent)).eq(third)).toBe(true);
    expect(() => RationalMoney.fromJSON({ amount: 1, currency: 'EUR' })).toThrow(InvalidArgumentError);
    expect(() => +third).toThrow(TypeError);
    expect(isRationalMoney(third)).toBe(true);
  });
});

describe('MoneyBag', () => {
  const fx = createConverter(ratesFrom({ base: 'EUR', rates: { USD: '1.0832', GBP: '0.8571' } }), {
    inverse: true,
    via: 'EUR',
  });

  it('keeps one exact balance per currency and drops zeros', () => {
    const bag = MoneyBag.of(money(10, 'EUR'), money(5, 'USD')).plus(money('2.50', 'EUR'));
    expect(bag.toString()).toBe('25/2 EUR + 5 USD');
    expect(bag.get('EUR').toMoney().toString()).toBe('12.50 EUR');
    expect(bag.get('GBP').isZero()).toBe(true);
    expect(bag.minus(money(5, 'USD')).currencies().map(String)).toEqual(['EUR']);
    expect(bag.minus(bag).isZero()).toBe(true);
    expect(MoneyBag.empty().toString()).toBe('0');
  });

  it('converts each balance exactly and rounds the total once', () => {
    const bag = MoneyBag.of(money('1.07', 'USD'), money('1.06', 'GBP'));
    const once = bag.convert(fx, 'EUR', { rounding: 'halfEven' });
    const separately = fx
      .convert(money('1.07', 'USD'), 'EUR', { rounding: 'halfEven' })
      .plus(fx.convert(money('1.06', 'GBP'), 'EUR', { rounding: 'halfEven' }));
    expect(once.toString()).toBe('2.22 EUR');
    expect(separately.toString()).toBe('2.23 EUR'); // rounding each balance first drifts by a cent
    expect(() => MoneyBag.of(money(1, 'JPY')).convert(fx, 'EUR', { rounding: 'halfEven' })).toThrow(ExchangeRateError);
  });

  it('serializes sorted by currency', () => {
    expect(JSON.stringify(MoneyBag.of(money(5, 'USD'), money('0.5', 'EUR')))).toBe(
      '[{"amount":"1/2","currency":"EUR"},{"amount":"5","currency":"USD"}]',
    );
  });
});
