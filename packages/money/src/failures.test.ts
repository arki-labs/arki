import { describe, expect, expectTypeOf, it } from 'vitest';

import { orThrow } from '@arki/failure';
import { InvalidArgumentError, ResourceLimitError } from '@arki/math/errors';

import type { MoneyFailure, MoneyFailureCode } from './failures.js';
import {
  AmountOutOfRange,
  Currency,
  InputTooLarge,
  InvalidMoneyShape,
  InvalidMoneyText,
  isMoneyFailure,
  Money,
  money,
  MONEY_FAILURES,
  NumberFormatError,
  NumericRangeError,
  ProviderAmount,
  UnknownCurrency,
  UnknownCurrencyError,
} from './index.js';
import { jsonFromDriver, minorFromDriver } from './internal/columns.js';
import { parseMoney } from './parse.js';
import { fromProviderUnits, toProviderUnits } from './provider.js';
import { fromStripeAmount } from './stripe.js';

describe('money failures', () => {
  it('derives one code union from the one tuple', () => {
    expectTypeOf<MoneyFailureCode>().toEqualTypeOf<
      | 'money.invalid_text'
      | 'money.invalid_shape'
      | 'money.unknown_currency'
      | 'money.rounding_necessary'
      | 'money.out_of_range'
      | 'money.input_too_large'
      | 'money.unsupported_locale'
      | 'money.provider_amount'
      | 'money.invalid_rate'
    >();
    expect(new Set(MONEY_FAILURES.map(definition => definition.code)).size).toBe(MONEY_FAILURES.length);
    // Each one tells the caller what to do, so a client can show it.
    for (const definition of MONEY_FAILURES) expect(definition.remediation).toBeTruthy();
  });

  it('never echoes the outside text, which may be huge or private', () => {
    const secret = `card 4242 4242 ${'9'.repeat(5000)}`;
    for (const failure of [
      Money.parse(secret),
      parseMoney(secret, 'EUR'),
      Money.fromJSON({ amount: secret, currency: 'EUR' }),
    ]) {
      expect(isMoneyFailure(failure)).toBe(true);
      expect(JSON.stringify(failure)).not.toContain('4242');
    }
  });
});

describe('outside values return failures instead of throwing', () => {
  it('Money.parse and Money.fromJSON', () => {
    expect(InvalidMoneyText.is(Money.parse('19,99 EUR'))).toBe(true);
    expect(InvalidMoneyText.is(Money.parse('19.99'))).toBe(true);
    expect(UnknownCurrency.is(Money.parse('19.99 eur'))).toBe(true);
    expect(InputTooLarge.is(Money.parse(`0.${'0'.repeat(150)}1 EUR`))).toBe(true);
    expect(InvalidMoneyShape.is(Money.fromJSON(null))).toBe(true);
    expect(InvalidMoneyShape.is(Money.fromJSON({ amount: 19.99, currency: 'EUR' }))).toBe(true);
    expect(UnknownCurrency.is(Money.fromJSON({ amount: '1', currency: 'ZZZ' }))).toBe(true);
    expectTypeOf(Money.parse('1 EUR')).toEqualTypeOf<
      Money | ReturnType<typeof InvalidMoneyText | typeof InputTooLarge | typeof UnknownCurrency>
    >();
  });

  it('Currency.parse and Currency.parseNumeric, while the builders still throw', () => {
    expect(Currency.parse('EUR')).toBe(Currency.of('EUR'));
    expect(UnknownCurrency.is(Currency.parse('eur'))).toBe(true);
    const btc = Currency.custom({ code: 'BTC', scale: 8 });
    expect(Currency.parse('BTC', [btc])).toBe(btc);
    expect(Currency.parseNumeric(978)).toBe(Currency.of('EUR'));
    expect(UnknownCurrency.is(Currency.parseNumeric('000'))).toBe(true);
    // Literals in your code are bugs when wrong, so they throw.
    expect(() => Currency.of('ZZZ')).toThrow(UnknownCurrencyError);
    expect(() => Currency.fromNumeric('000')).toThrow(UnknownCurrencyError);
  });

  it('provider and Stripe amounts read from a payload', () => {
    expect(AmountOutOfRange.is(fromProviderUnits(10.5, 'EUR', { scale: 2 }))).toBe(true);
    expect(AmountOutOfRange.is(fromProviderUnits(2 ** 60, 'EUR', { scale: 2 }))).toBe(true);
    expect(InvalidMoneyText.is(fromProviderUnits('1e3', 'EUR', { scale: 2 }))).toBe(true);
    expect(InputTooLarge.is(fromProviderUnits(10n ** 20_000n, 'EUR', { scale: 2 }))).toBe(true);
    expect(UnknownCurrency.is(fromStripeAmount(100, 'zzz'))).toBe(true);
    expect(ProviderAmount.is(fromStripeAmount(100, 'kwd'))).toBe(true);
    expect(orThrow(fromStripeAmount('1099', 'usd')).toString()).toBe('10.99 USD');
  });
});

describe('builders and stored values still throw', () => {
  it('a provider rule is your code: a zero step throws instead of dividing by zero', () => {
    expect(() => fromProviderUnits(100, 'EUR', { scale: 2, step: 0 })).toThrow(InvalidArgumentError);
    expect(() => toProviderUnits(money(1, 'EUR'), { scale: 2, step: 0 })).toThrow(InvalidArgumentError);
    expect(() => toProviderUnits(money(1, 'EUR'), { scale: -1 })).toThrow(InvalidArgumentError);
  });

  it('refuses a bigint product past the digit cap before building it (Hermes would crash)', () => {
    const huge = Money.fromMinor(10n ** 6000n, 'EUR');
    expect(() => huge.times(10n ** 6000n)).toThrow(ResourceLimitError);
    expect(() => huge.plus(huge).times(10n ** 6000n)).toThrow(ResourceLimitError);
    expect(huge.times(10n ** 100n).units).toBe(10n ** 6100n);
  });

  it('bad stored data rejects the query instead of becoming a wrong amount', () => {
    const eur = Currency.of('EUR');
    expect(() => jsonFromDriver('{"amount":"1,5","currency":"EUR"}', [])).toThrow(NumberFormatError);
    expect(() => jsonFromDriver('{"amount":"1","currency":"ZZZ"}', [])).toThrow(UnknownCurrencyError);
    expect(() => minorFromDriver(2 ** 60, eur, 2)).toThrow(NumericRangeError);
    expect(() => minorFromDriver('12.5', eur, 2)).toThrow(NumberFormatError);
  });
});

it('every failure is a MoneyFailure', () => {
  const failure: MoneyFailure = UnknownCurrency();
  expect(isMoneyFailure(failure)).toBe(true);
  expect(isMoneyFailure(new Error('x'))).toBe(false);
});
