/**
 * `@arki/math/decimal`: exact decimals with a retained scale. `decimal('0.1').plus('0.2')` is `0.3`,
 * and a result that needs rounding throws until you pass a mode.
 */
export { Decimal, decimal, isDecimal } from './internal/exact.js';
export type { DecimalInput, ScaleOptions } from './internal/exact.js';
export type { RoundingMode } from './rounding.js';
