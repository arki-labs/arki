import { describe, expect, it } from 'vitest';

import { Currency, money, NumericRangeError, ProviderAmountError } from './index.js';
import { fromProviderUnits, toProviderUnits } from './provider.js';
import { fromStripeAmount, stripeRule, toStripe, toStripeAmount } from './stripe.js';

describe('Stripe amounts', () => {
  it('uses two decimals for ordinary currencies and none for zero-decimal ones', () => {
    expect(toStripeAmount(money('10.99', 'USD'))).toBe(1099);
    expect(toStripeAmount(money(500, 'JPY'))).toBe(500);
    expect(toStripe(money('10.99', 'EUR'))).toEqual({ amount: 1099, currency: 'eur' });
    expect(fromStripeAmount(1099, 'usd').toString()).toBe('10.99 USD');
    expect(fromStripeAmount(500, 'jpy').toString()).toBe('500 JPY');
  });

  it('follows Stripe where it differs from ISO 4217', () => {
    // MGA has 2 decimals in ISO, 0 at Stripe.
    expect(toStripeAmount(money(10, 'MGA'))).toBe(10);
    expect(() => toStripeAmount(money('10.50', 'MGA'))).toThrow(ProviderAmountError);
    expect(fromStripeAmount(10, 'mga').toString()).toBe('10.00 MGA');
    // ISK and UGX have 0 decimals in ISO, but Stripe wants two that are always 00.
    expect(toStripeAmount(money(5, 'ISK'))).toBe(500);
    expect(toStripeAmount(money(5, 'UGX'))).toBe(500);
    expect(fromStripeAmount(500, 'isk').toString()).toBe('5 ISK');
    expect(() => fromStripeAmount(550, 'isk')).toThrow(ProviderAmountError);
  });

  it('applies the HUF and TWD payout rule only to payouts', () => {
    expect(toStripeAmount(money('10.45', 'HUF'))).toBe(1045);
    expect(() => toStripeAmount(money('10.45', 'HUF'), 'payout')).toThrow(ProviderAmountError);
    expect(toStripeAmount(money(10, 'HUF'), 'payout')).toBe(1000);
    expect(toStripeAmount(money(800, 'TWD'), 'payout')).toBe(80_000);
  });

  it('refuses what Stripe does not document instead of guessing', () => {
    expect(() => stripeRule('KWD')).toThrow(ProviderAmountError);
    expect(() => stripeRule('CLF')).toThrow(ProviderAmountError);
    expect(() => stripeRule('XAU')).toThrow(ProviderAmountError);
    expect(() => stripeRule(Currency.custom({ code: 'BTC', scale: 8 }))).toThrow(ProviderAmountError);
    expect(() => toStripeAmount(money(-1, 'USD'))).toThrow(ProviderAmountError);
    expect(() => toStripeAmount(money('0.001', 'USD', { scale: 3 }))).toThrow(ProviderAmountError);
  });
});

describe('provider units', () => {
  it('converts to and from any provider’s scale without rounding', () => {
    expect(toProviderUnits(money('1.5', 'EUR'), { scale: 4 })).toBe(15_000);
    expect(fromProviderUnits(15_000, 'EUR', { scale: 4 }).toString()).toBe('1.50 EUR');
    expect(() => fromProviderUnits(15_001, 'EUR', { scale: 4 })).toThrow(ProviderAmountError);
    expect(() => toProviderUnits(money(1, 'EUR'), { scale: 2, step: 3 })).toThrow(ProviderAmountError);
    expect(() => toProviderUnits(money('100000000000000', 'EUR'), { scale: 4 })).toThrow(NumericRangeError);
  });
});
