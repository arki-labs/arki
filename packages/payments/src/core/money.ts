/**
 * Money at the edges of the payments package
 *
 * Amounts inside the package are `Money` from `@arki/money`: exact, with their
 * currency. Storage keeps its old formats, and these functions are the only
 * crossing between the two:
 *
 * - `plans.price`, `payments.amount` and `payments.refunded_amount` are `real`
 *   columns (4-byte floats), and journal events keep amounts as JSON numbers.
 *   `toStoredNumber` / `fromStoredNumber` cross there.
 * - `refunds.*_amount` are `decimal(10,2)` columns: strings, exact.
 *   `fromDecimalColumn` reads them.
 *
 * Currency codes are stored as given; older rows may hold lower case (`usd`).
 * `@arki/money` reads only upper-case ISO codes, so every reader upper-cases.
 */

import type { Money, MoneyJSON } from '@arki/money';
import { z } from '@arki/contracts';
import { money } from '@arki/money';
import { anyMoneySchema } from '@arki/money/zod';

import type { Payment, Plan } from './types';

/**
 * An amount stored as a JS number, read back as `Money`.
 *
 * The number is only the nearest float to the amount that was written (a
 * `real` column keeps about 7 digits), so it is rounded to the currency's
 * decimals. Half-even: a float sits on either side of the written amount, never
 * on purpose at a half, so the mode only decides true ties without a bias.
 */
export function fromStoredNumber(value: number, currency: string): Money {
  return money(value, currency.toUpperCase(), { rounding: 'halfEven' });
}

/**
 * `Money` as the JS number a `real` column or a journal event holds.
 * The one place an amount becomes a float: storage that already was one.
 */
export function toStoredNumber(amount: Money): number {
  return amount.toNumber();
}

/**
 * A `decimal(10,2)` column read back as `Money`. Exact: `'1000.00'` is
 * 1000 JPY. A value with more decimals than the currency throws.
 */
export function fromDecimalColumn(value: string, currency: string): Money {
  return money(value, currency.toUpperCase());
}

/** A plan's price as `Money`. */
export function planPrice(plan: Pick<Plan, 'price' | 'currency'>): Money {
  return fromStoredNumber(plan.price, plan.currency);
}

/** A payment's amount as `Money`. */
export function paymentAmount(payment: Pick<Payment, 'amount' | 'currency'>): Money {
  return fromStoredNumber(payment.amount, payment.currency);
}

/** What a response sends for an amount: `Money.toJSON()`, `{ amount: '19.99', currency: 'EUR' }`. */
export const moneyJsonSchema = z.object({ amount: z.string(), currency: z.string() }) satisfies z.ZodType<MoneyJSON>;

/**
 * Stripe takes at most 8 digits of minor units (99,999,999). For two-decimal
 * currencies that is the 999,999.99 cap the number schemas had.
 */
const MAX_MINOR_UNITS = 99_999_999n;

const fitsStripe = (amount: Money) => amount.toMinorBigInt() <= MAX_MINOR_UNITS;
const fitsStripeMessage = 'Amount is larger than 99,999,999 minor units';

/**
 * An amount a client sends: `{ amount: '19.99', currency: 'EUR' }` → `Money`.
 * Positive, and small enough for Stripe.
 */
export const positiveMoneySchema = anyMoneySchema()
  .refine(amount => amount.isPositive(), 'Amount must be positive')
  .refine(fitsStripe, fitsStripeMessage);

/** A plan's price: zero for a free plan, and small enough for Stripe. */
export const priceSchema = anyMoneySchema()
  .refine(amount => !amount.isNegative(), 'Price must not be negative')
  .refine(fitsStripe, fitsStripeMessage);

/** An amount already charged, as a command stores it: zero or more, with no upper cap. */
export const nonNegativeMoneySchema = anyMoneySchema().refine(
  amount => !amount.isNegative(),
  'Amount must not be negative',
);
