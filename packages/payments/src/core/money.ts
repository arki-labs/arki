/**
 * Money at the edges of the payments package
 *
 * Amounts inside the package are `Money` from `@arki/money`: exact, with their
 * currency. These functions are the only crossing to storage:
 *
 * - Amount columns are `bigint` whole minor units next to the row's `currency`
 *   column: `plans.price_minor`, `payments.amount_minor`,
 *   `payments.refunded_amount_minor`, `refunds.original_amount_minor` and
 *   `refunds.refund_amount_minor`. 1999 USD units are 19.99 USD; 1500 JPY units
 *   are 1500 JPY. `toMinorColumn` / `fromMinorColumn` cross there, exactly.
 * - Journal events keep amounts as `Money` JSON. Events written before the
 *   minor-unit columns kept a JSON number; `fromStoredNumber` reads those.
 *
 * Currency codes are stored as given; older rows may hold lower case (`usd`).
 * `@arki/money` reads only upper-case ISO codes, so every reader upper-cases.
 */

import type { MoneyJSON } from '@arki/money';
import { z } from '@arki/contracts';
import { invariant } from '@arki/failure';
import { Currency, Money, money } from '@arki/money';
import { anyMoneySchema } from '@arki/money/zod';

import type { Payment, Plan } from './types.js';

/**
 * `Money` as the whole minor units an amount column holds. Exact: an amount
 * the schemas accepted has no digits below the currency's minor unit.
 *
 * Precondition: `amount` passed one of the amount schemas below (or `@arki/money`
 * built it from minor units). Anything else is a caller bug and throws:
 * `RoundingNecessaryError` for digits below the minor unit (`1.001 EUR`), and
 * `NumericRangeError` past 2^53 - 1 minor units.
 */
export function toMinorColumn(amount: Money): number {
  return amount.toMinorNumber();
}

/**
 * An amount column read back as `Money`. Also takes the text Postgres sends
 * for `SUM(bigint)`.
 *
 * A builder over stored values, so it throws an invariant failure (callers pass a row this package
 * wrote through its insert schemas, which allow only these) when `units` is not a safe whole number
 * (a fraction, `NaN`, past 2^53 - 1, or text that is not whole minor units) or `currency` is a code
 * outside ISO 4217 (any case).
 */
export function fromMinorColumn(units: number | string, currency: string): Money {
  invariant(
    typeof units === 'number'
      ? Number.isSafeInteger(units)
      : /^-?\d{1,16}$/.test(units) && Number.isSafeInteger(Number(units)),
    '[@arki/payments] units must be a safe whole number of minor units',
  );
  invariant(Currency.isKnown(currency.toUpperCase()), '[@arki/payments] currency must be an ISO 4217 code');
  return Money.fromMinor(units, currency.toUpperCase());
}

/**
 * An amount stored as a JS number, read back as `Money`: the major-unit floats
 * of journal events written before the minor-unit columns.
 *
 * The number is only the nearest float to the amount that was written, so it
 * is rounded to the currency's decimals. Half-even: a float sits on either side
 * of the written amount, never on purpose at a half, so the mode only decides
 * true ties without a bias. The column migration rounds the same way.
 *
 * A builder for stored values, so it throws an invariant failure for a number that is not finite
 * or past 2^53 minor units, and for a code outside ISO 4217. Its callers
 * are journal folds over events this package wrote, which cannot return a failure: a throw there
 * means a corrupt event log.
 */
export function fromStoredNumber(value: number, currency: string): Money {
  const code = currency.toUpperCase();
  invariant(Currency.isKnown(code), '[@arki/payments] currency must be an ISO 4217 code');
  invariant(
    Number.isFinite(value) && Math.abs(value) * 10 ** Currency.of(code).scale < Number.MAX_SAFE_INTEGER,
    '[@arki/payments] value must be a finite amount within 2^53 minor units',
  );
  return money(value, currency.toUpperCase(), { rounding: 'halfEven' });
}

/**
 * A plan's price as `Money`. Precondition: a plan row as stored (whole `priceMinor`, an ISO 4217
 * `currency`); anything else throws an invariant failure as `fromMinorColumn` does.
 */
export function planPrice(plan: Pick<Plan, 'priceMinor' | 'currency'>): Money {
  return fromMinorColumn(plan.priceMinor, plan.currency);
}

/**
 * A payment's amount as `Money`. Precondition: a payment row as stored (whole `amountMinor`, an ISO
 * 4217 `currency`); anything else throws an invariant failure as `fromMinorColumn` does.
 */
export function paymentAmount(payment: Pick<Payment, 'amountMinor' | 'currency'>): Money {
  return fromMinorColumn(payment.amountMinor, payment.currency);
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

/** The most minor units an amount column holds exactly: 2^53 - 1, what `toMinorColumn` can return. */
const MAX_COLUMN_MINOR_UNITS = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * An amount already charged, as a command stores it: zero or more, and at most 2^53 - 1 minor units
 * (what `toMinorColumn` and the bigint column hold exactly). No Stripe cap: a provider may report
 * amounts past it.
 */
export const nonNegativeMoneySchema = anyMoneySchema()
  .refine(amount => !amount.isNegative(), 'Amount must not be negative')
  .refine(
    amount => amount.toMinorBigInt() <= MAX_COLUMN_MINOR_UNITS,
    'Amount is larger than 9,007,199,254,740,991 minor units',
  );
