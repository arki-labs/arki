/**
 * Payment providers count amounts in their own units, which are not always
 * ISO's. A rule says how many decimals the provider's integer carries and,
 * optionally, which multiple it must be. Conversion never rounds: an amount
 * the provider cannot express throws `ProviderAmountError`.
 *
 * `@arki/money/stripe` ships Stripe's rules. Describe any other provider with
 * a `ProviderUnitRule` and these two functions.
 */

import { NumericRangeError, RoundingNecessaryError } from '@arki/math/errors';

import type { CurrencyLike } from './currency.js';
import type { Units } from './internal/units.js';
import { toCurrency } from './currency.js';
import { ProviderAmountError } from './errors.js';
import { quantize } from './internal/units.js';
import { Money } from './money.js';

export type ProviderUnitRule = {
  /** Decimals in the provider's integer: 2 means `1099` is `10.99`. */
  scale: number;
  /** The integer must be a multiple of this: `100` for whole-unit-only currencies sent with two decimals. */
  step?: number;
};

function checkStep(units: Units, rule: ProviderUnitRule, what: string): void {
  if (rule.step !== undefined && BigInt(units) % BigInt(rule.step) !== 0n) {
    throw new ProviderAmountError(`${what} must be a multiple of ${rule.step} in the provider's units`);
  }
}

/** `toProviderUnits(money('10.99', 'USD'), { scale: 2 })` → `1099`. Throws instead of rounding. */
export function toProviderUnits(amount: Money, rule: ProviderUnitRule): number {
  let units: Units;
  try {
    units = quantize(amount.units, amount.scale, rule.scale);
  } catch (error) {
    if (!(error instanceof RoundingNecessaryError)) throw error;
    throw new ProviderAmountError(`${amount.toString()} has more decimals than the provider accepts (${rule.scale})`, {
      cause: error,
    });
  }
  checkStep(units, rule, amount.toString());
  if (typeof units !== 'number') throw new NumericRangeError(`${amount.toString()} is too large for a provider amount`);
  return units;
}

/** The reverse of `toProviderUnits`, at the currency's own scale. Validates the step. */
export function fromProviderUnits<const C extends string>(
  units: number | bigint | string,
  currency: CurrencyLike<C>,
  rule: ProviderUnitRule,
): Money<C> {
  const target = toCurrency(currency);
  const raw = Money.fromMinor(units, target, rule.scale);
  checkStep(raw.units, rule, `The provider amount ${String(units)}`);
  if (rule.scale <= target.scale) return raw.toScale(target.scale);
  try {
    return raw.toScale(target.scale);
  } catch (error) {
    if (!(error instanceof RoundingNecessaryError)) throw error;
    throw new ProviderAmountError(`The provider amount ${String(units)} has a fraction ${target.code} does not have`, {
      cause: error,
    });
  }
}
