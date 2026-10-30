/**
 * The exact rounding of `round` / `roundTo`: parse the number's shortest
 * decimal text into a bigint coefficient, divide with the rounding mode, and
 * convert back. Slow (a string round trip and bigint maths) but obviously
 * right, so it handles every case the float fast path in `number.ts` cannot
 * prove, and it is the oracle the fast path is tested against.
 */

import type { RoundingMode } from '../rounding.js';
import type { DecimalParts } from './parse.js';
import { NumericRangeError } from '../errors.js';
import { divideRounded, pow10 } from './bigint.js';
import { decimalParts } from './parse.js';

function noNegativeZero(value: number): number {
  return value === 0 ? 0 : value;
}

/** The rounded value, or `NumericRangeError` when rounding up carried it past the largest double. */
function finiteRounded(value: number, operation: string): number {
  if (!Number.isFinite(value)) throw new NumericRangeError(`${operation} rounds past the largest float`);
  return noNegativeZero(value);
}

// The shortest text, not `partsFromNumber`: that guard stops `decimal(1e20)` from
// pretending to be exact, but a float past 2^53 still rounds as the number you typed.
function shortestParts(value: number): DecimalParts {
  return decimalParts(String(value));
}

/** `round(x, places, mode)` on the shortest decimal text of `x`. Arguments are already validated. */
export function roundExact(x: number, places: number, mode: RoundingMode): number {
  const { coefficient, scale } = shortestParts(x);
  if (places >= scale) return noNegativeZero(x);
  const rounded = divideRounded(coefficient, pow10(scale - places), mode);
  return finiteRounded(Number(`${rounded}e${-places}`), 'round');
}

/** `roundTo(x, step, mode)` on the shortest decimal text of both. Arguments are already validated. */
export function roundToExact(x: number, step: number, mode: RoundingMode): number {
  const value = shortestParts(x);
  const unit = shortestParts(step);
  const multiple = divideRounded(value.coefficient * pow10(unit.scale), unit.coefficient * pow10(value.scale), mode);
  return finiteRounded(Number(`${multiple * unit.coefficient}e${-unit.scale}`), 'roundTo');
}
