import type { RoundingMode } from '../rounding.js';
import type { DecimalParts } from './parse.js';
import { DivisionByZeroError, InvalidArgumentError, RoundingNecessaryError } from '../errors.js';
import { divideRounded, gcd, pow10, stripFactor } from './bigint.js';
import { assertScaleLimit } from './limits.js';

export type ScaleOptions = {
  /** Number of fraction digits in the result. */
  scale: number;
  /** How to drop digits that do not fit. Defaults to `'unnecessary'`, which throws instead. */
  rounding?: RoundingMode;
};

export function assertScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0) {
    throw new InvalidArgumentError(`Scale must be a non-negative integer, got ${scale}`);
  }
  assertScaleLimit(scale, 'Scale');
}

/**
 * Turns `numerator / denominator` into decimal parts.
 *
 * With `options.scale` the result has exactly that many fraction digits,
 * rounded as requested. Without it, the result is the shortest decimal that
 * is exactly equal — and if no finite decimal is (1/3, 2/7, ...), it throws
 * rather than round behind the caller's back.
 */
export function fractionToDecimalParts(numerator: bigint, denominator: bigint, options?: ScaleOptions): DecimalParts {
  if (denominator === 0n) throw new DivisionByZeroError('Division by zero');

  if (options) {
    assertScale(options.scale);
    const scaled = divideRounded(numerator * pow10(options.scale), denominator, options.rounding ?? 'unnecessary');
    return { coefficient: scaled, scale: options.scale };
  }

  const divisor = gcd(numerator, denominator);
  let p = numerator / divisor;
  let q = denominator / divisor;
  if (q < 0n) {
    p = -p;
    q = -q;
  }
  const [afterTwos, twos] = stripFactor(q, 2n);
  const [rest, fives] = stripFactor(afterTwos, 5n);
  if (rest !== 1n) {
    throw new RoundingNecessaryError(
      `${p}/${q} has no exact decimal form; pass { scale, rounding } to round it, or keep it as a ratio()`,
    );
  }
  const scale = Math.max(twos, fives);
  return { coefficient: (p * pow10(scale)) / q, scale };
}
