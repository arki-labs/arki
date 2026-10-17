/**
 * `@arki/math/rational`: exact fractions on `bigint`. `ratio(1, 3).plus(ratio(1, 6))` is `1/2`, with
 * no rounding at any step.
 */
export { Rational, ratio, isRational } from './internal/exact.js';
export type { IntegerInput, MixedNumber, RationalInput, ScaleOptions } from './internal/exact.js';
export type { RoundingMode } from './rounding.js';
