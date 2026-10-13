/**
 * The value conversions behind the Drizzle columns, shared by every SQL
 * dialect. Each dialect file only says which column type to declare.
 */

import { InvalidArgumentError, NumericRangeError } from '@arki/math/errors';

import type { Currency } from '../currency.js';
import type { Money } from '../money.js';
import type { Units } from './units.js';
import { assertSameCurrency, resolveCurrency } from '../currency.js';
import { Money as MoneyClass } from '../money.js';
import { quantize } from './units.js';

/** What drivers hand back for an integer column. */
export type IntegerDriverValue = number | bigint | string;

/** Minor units at the column's scale, in canonical form. Throws if the value is in another currency or needs rounding. */
export function minorToDriver(value: Money, currency: Currency, scale: number): Units {
  assertSameCurrency(value.currency, currency);
  return quantize(value.units, value.scale, scale);
}

/**
 * Reads an integer column. A `number` that is not a safe integer was already
 * rounded by the driver, so it throws instead of becoming a wrong amount.
 */
export function minorFromDriver<C extends string>(
  value: IntegerDriverValue,
  currency: Currency<C>,
  scale: number,
): Money<C> {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new NumericRangeError(
      `The database driver returned ${value}, which a JavaScript number cannot hold exactly; ` +
        'configure the driver to return big integers as strings or bigint',
    );
  }
  return MoneyClass.fromMinor(
    typeof value === 'number' || typeof value === 'bigint' ? value : String(value),
    currency,
    scale,
  );
}

/** Exact decimal text at the column's scale. */
export function decimalToDriver(value: Money, currency: Currency, scale: number): string {
  assertSameCurrency(value.currency, currency);
  return value.toScale(scale).toDecimalString();
}

/** Reads decimal text (or a driver's number for a whole value) at the column's scale. */
export function decimalFromDriver<C extends string>(
  value: string | number,
  currency: Currency<C>,
  scale: number,
): Money<C> {
  return MoneyClass.of(typeof value === 'number' ? value : String(value), currency, { scale });
}

/** `{ amount, currency }` as JSON text. */
export function jsonToDriver(value: Money): string {
  return JSON.stringify(value.toJSON());
}

/** Reads JSON text, or an object for drivers that parse JSON columns themselves. */
export function jsonFromDriver(value: unknown, currencies: readonly Currency[] | undefined): Money {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (typeof parsed !== 'object' || parsed === null || !('currency' in parsed) || typeof parsed.currency !== 'string') {
    throw new InvalidArgumentError('A money JSON column holds { amount, currency }');
  }
  resolveCurrency(parsed.currency, currencies);
  return MoneyClass.fromJSON(parsed, currencies);
}
