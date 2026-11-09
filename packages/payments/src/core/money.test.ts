/**
 * The money builders over stored rows throw on a row this package could not have written: their
 * JSDoc states it as a precondition. A caller holding outside JSON parses it with the amount schemas
 * first, which answer with `schema.invalid_input` instead.
 */
import { describe, expect, it } from 'vitest';

import { money, NumberFormatError, NumericRangeError, RoundingNecessaryError, UnknownCurrencyError } from '@arki/money';

import {
  fromMinorColumn,
  nonNegativeMoneySchema,
  paymentAmount,
  planPrice,
  positiveMoneySchema,
  priceSchema,
  toMinorColumn,
} from './money.js';

describe('the builders over stored rows', () => {
  it('read a stored row exactly, lower-case currency too', () => {
    expect(paymentAmount({ amountMinor: 1999, currency: 'usd' }).toJSON()).toEqual({
      amount: '19.99',
      currency: 'USD',
    });
    expect(planPrice({ priceMinor: 1500, currency: 'JPY' }).toJSON()).toEqual({ amount: '1500', currency: 'JPY' });
    expect(fromMinorColumn('2500', 'EUR').toJSON()).toEqual({ amount: '25.00', currency: 'EUR' });
  });

  it('throw the documented errors for a row the insert schemas would have refused', () => {
    expect(() => paymentAmount({ amountMinor: 1.5, currency: 'EUR' })).toThrow(NumericRangeError);
    expect(() => paymentAmount({ amountMinor: 2 ** 60, currency: 'EUR' })).toThrow(NumericRangeError);
    expect(() => paymentAmount({ amountMinor: 1, currency: 'ZZZ' })).toThrow(UnknownCurrencyError);
    expect(() => planPrice({ priceMinor: Number.NaN, currency: 'EUR' })).toThrow(NumericRangeError);
    expect(() => fromMinorColumn('12.5', 'EUR')).toThrow(NumberFormatError);
  });

  it('toMinorColumn throws the documented errors for an amount no amount schema accepts', () => {
    expect(() => toMinorColumn(money('1.001', 'EUR'))).toThrow(RoundingNecessaryError);
    expect(() => toMinorColumn(money('1e30', 'EUR'))).toThrow(NumericRangeError);
  });
});

describe('the amount schemas, the door for outside amounts', () => {
  it.each([
    ['digits below the minor unit', { amount: '1.001', currency: 'EUR' }],
    ['a fraction of a yen', { amount: '1.5', currency: 'JPY' }],
    ['an amount past 2^53 minor units', { amount: '1e30', currency: 'EUR' }],
    ['a currency outside ISO 4217', { amount: '1', currency: 'ZZZ' }],
  ])('refuse %s instead of throwing', (_what, value) => {
    for (const schema of [positiveMoneySchema, priceSchema, nonNegativeMoneySchema]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });
});
