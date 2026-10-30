/**
 * Payment providers count amounts in their own units, which are not always
 * ISO's. A rule says how many decimals the provider's integer carries and,
 * optionally, which multiple it must be. Conversion never rounds.
 *
 * Sending (`toProviderUnits`) takes your own `Money`, so an amount the provider
 * cannot express throws `ProviderAmountError`. Reading (`fromProviderUnits`)
 * takes the provider's payload, so it returns a failure instead of throwing.
 *
 * `@arki/money/stripe` ships Stripe's rules. Describe any other provider with
 * a `ProviderUnitRule` and these two functions.
 */

import { InvalidArgumentError, NumericRangeError } from '@arki/math/errors';

import type { CurrencyLike } from './currency.js';
import type { Units } from './internal/units.js';
import { Currency } from './currency.js';
import { ProviderAmountError } from './errors.js';
import { isMoneyFailure, ProviderAmount } from './failures.js';
import { isExactAtScale, MAX_SCALE, quantize, toUnits } from './internal/units.js';
import { Money } from './money.js';

export type ProviderUnitRule = {
  /** Decimals in the provider's integer: 2 means `1099` is `10.99`. */
  scale: number;
  /** The integer must be a multiple of this: `100` for whole-unit-only currencies sent with two decimals. */
  step?: number;
};

/** A rule is your code's: a bad scale or a step below 1 throws `InvalidArgumentError` (a zero step would divide by zero). */
function checkRule(rule: ProviderUnitRule): void {
  if (!Number.isInteger(rule.scale) || rule.scale < 0 || rule.scale > MAX_SCALE) {
    throw new InvalidArgumentError(`A provider scale is a whole number from 0 to ${MAX_SCALE}, got ${rule.scale}`);
  }
  if (rule.step !== undefined && (!Number.isSafeInteger(rule.step) || rule.step < 1)) {
    throw new InvalidArgumentError(`A provider step is a whole number of at least 1, got ${rule.step}`);
  }
}

function isOnStep(units: Units, rule: ProviderUnitRule): boolean {
  return rule.step === undefined || BigInt(units) % BigInt(rule.step) === 0n;
}

/** `toProviderUnits(money('10.99', 'USD'), { scale: 2 })` → `1099`. Throws `ProviderAmountError` instead of rounding. */
export function toProviderUnits(amount: Money, rule: ProviderUnitRule): number {
  checkRule(rule);
  if (!isExactAtScale(amount.units, amount.scale, rule.scale)) {
    throw new ProviderAmountError(`${amount.toString()} has more decimals than the provider accepts (${rule.scale})`);
  }
  const units = quantize(amount.units, amount.scale, rule.scale);
  if (!isOnStep(units, rule)) {
    throw new ProviderAmountError(`${amount.toString()} must be a multiple of ${rule.step} in the provider's units`);
  }
  if (typeof units !== 'number') throw new NumericRangeError(`${amount.toString()} is too large for a provider amount`);
  return units;
}

/**
 * The reverse of `toProviderUnits`, at the currency's own scale, for a provider's payload.
 * Returns `ProviderAmount` (off the step, or a fraction the currency lacks), `UnknownCurrency`,
 * `AmountOutOfRange`, `InputTooLarge` or `InvalidMoneyText` instead of throwing. The rule is
 * your code's: a bad rule throws `InvalidArgumentError`.
 */
export function fromProviderUnits<const C extends string>(
  units: number | bigint | string,
  currency: CurrencyLike<C>,
  rule: ProviderUnitRule,
) {
  checkRule(rule);
  const target = currency instanceof Currency ? currency : Currency.parse(currency);
  if (isMoneyFailure(target)) return target;
  const raw = toUnits(units);
  if (isMoneyFailure(raw)) return raw;
  if (!isOnStep(raw, rule) || !isExactAtScale(raw, rule.scale, target.scale)) return ProviderAmount();
  return Money.create(quantize(raw, rule.scale, target.scale), target.scale, target);
}
