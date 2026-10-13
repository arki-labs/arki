/**
 * Stripe amounts. Stripe sends integers in its own units, which differ from
 * ISO 4217 for some currencies. Rules from docs.stripe.com/currencies, read
 * on 2026-10-12:
 *
 * - Zero-decimal: BIF CLP DJF GNF JPY KMF KRW MGA PYG RWF VND VUV XAF XOF XPF
 *   (`500` is 500 JPY). MGA has 2 decimals in ISO but 0 at Stripe.
 * - ISK and UGX: sent with two decimals that are always `00` (`500` is 5 ISK).
 * - HUF and TWD: two-decimal charges; payouts must be divisible by 100.
 * - Other currencies with 2 ISO decimals: two decimals.
 *
 * Stripe documents no rule for currencies with 3 or 4 ISO decimals, so those
 * throw `ProviderAmountError` instead of being guessed. Whether your account
 * can charge a currency, and its minimum and maximum amounts, are Stripe's to
 * enforce; this module only gets the units right.
 */

import type { Currency, CurrencyLike } from './currency.js';
import type { Money } from './money.js';
import type { ProviderUnitRule } from './provider.js';
import { toCurrency } from './currency.js';
import { ProviderAmountError } from './errors.js';
import { fromProviderUnits, toProviderUnits } from './provider.js';

/** When Stripe's rules in this module were last checked. */
export const STRIPE_RULES_VERSION = '2026-10-12';

export type StripeOperation = 'charge' | 'payout';

const ZERO_DECIMAL = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);
const WHOLE_UNITS_TWO_DECIMALS = new Set(['ISK', 'UGX']);
const WHOLE_UNIT_PAYOUTS = new Set(['HUF', 'TWD']);

/** Stripe's unit rule for a currency and operation. Throws `ProviderAmountError` where Stripe documents none. */
export function stripeRule(currency: CurrencyLike, operation: StripeOperation = 'charge'): ProviderUnitRule {
  const target: Currency = toCurrency(currency);
  const code = target.code;
  if (!target.iso) throw new ProviderAmountError(`${code} is a custom currency; Stripe has no rule for it`);
  if (ZERO_DECIMAL.has(code)) return { scale: 0 };
  if (WHOLE_UNITS_TWO_DECIMALS.has(code)) return { scale: 2, step: 100 };
  if (WHOLE_UNIT_PAYOUTS.has(code)) return operation === 'payout' ? { scale: 2, step: 100 } : { scale: 2 };
  if (target.scale === 2) return { scale: 2 };
  throw new ProviderAmountError(`Stripe documents no amount rule for ${code} (${target.scale} decimals in ISO 4217)`);
}

/**
 * `toStripeAmount(money('10.99', 'USD'))` → `1099`; `money(5, 'ISK')` → `500`.
 * Throws `ProviderAmountError` for a negative amount or one Stripe cannot express (`10.50 MGA`).
 */
export function toStripeAmount(amount: Money, operation: StripeOperation = 'charge'): number {
  if (amount.isNegative()) throw new ProviderAmountError('Stripe amounts are never negative');
  return toProviderUnits(amount, stripeRule(amount.currency, operation));
}

/** `fromStripeAmount(1099, 'usd')` → `10.99 USD`. Accepts Stripe's lower-case codes. */
export function fromStripeAmount(
  amount: number | bigint | string,
  currency: string | Currency,
  operation: StripeOperation = 'charge',
): Money {
  const target = typeof currency === 'string' ? toCurrency(currency.toUpperCase()) : currency;
  return fromProviderUnits(amount, target, stripeRule(target, operation));
}

/** The `{ amount, currency }` pair a Stripe request takes: `{ amount: 1099, currency: 'usd' }`. */
export function toStripe(amount: Money, operation: StripeOperation = 'charge'): { amount: number; currency: string } {
  return { amount: toStripeAmount(amount, operation), currency: amount.currency.code.toLowerCase() };
}
