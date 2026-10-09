/**
 * Immutable fluent wrapper for ordinary JS numbers, the counterpart of
 * `str()` in `@arki/string`. Arithmetic here is float arithmetic — fast and
 * approximate. Hop to the exact types with `.toDecimal()` / `.toRatio()`
 * when a result must be exact. Extract with `.value()`.
 */

import type { CompactOptions, CurrencyOptions, FormatOptions } from './format.js';
import type { Bounds } from './number.js';
import type { RoundingMode } from './rounding.js';
import { formatCompact, formatCurrency, formatNumber, formatPercent } from './format.js';
import { Decimal, Rational } from './internal/exact.js';
import { approxEqual, assertFinite, clamp, inRange, lerp, remap, round, roundTo } from './number.js';

export class NumberValue {
  readonly #value: number;

  constructor(value: number) {
    assertFinite(value, 'value');
    this.#value = value === 0 ? 0 : value;
  }

  // Float arithmetic ---------------------------------------------------------

  plus(other: number): NumberValue {
    return num(this.#value + other);
  }

  minus(other: number): NumberValue {
    return num(this.#value - other);
  }

  times(other: number): NumberValue {
    return num(this.#value * other);
  }

  dividedBy(other: number): NumberValue {
    return num(this.#value / other);
  }

  abs(): NumberValue {
    return num(Math.abs(this.#value));
  }

  negated(): NumberValue {
    return num(-this.#value);
  }

  // Shaping ------------------------------------------------------------------

  clamp(min: number, max: number): NumberValue {
    return num(clamp(this.#value, min, max));
  }

  lerp(end: number, t: number): NumberValue {
    return num(lerp(this.#value, end, t));
  }

  remap(inStart: number, inEnd: number, outStart: number, outEnd: number): NumberValue {
    return num(remap(this.#value, inStart, inEnd, outStart, outEnd));
  }

  round(places?: number, mode?: RoundingMode): NumberValue {
    return num(round(this.#value, places, mode));
  }

  roundTo(step: number, mode?: RoundingMode): NumberValue {
    return num(roundTo(this.#value, step, mode));
  }

  // Queries ------------------------------------------------------------------

  inRange(min: number, max: number, bounds?: Bounds): boolean {
    return inRange(this.#value, min, max, bounds);
  }

  approxEqual(other: number, tolerance?: number): boolean {
    return approxEqual(this.#value, other, tolerance);
  }

  isZero(): boolean {
    return this.#value === 0;
  }

  isPositive(): boolean {
    return this.#value > 0;
  }

  isNegative(): boolean {
    return this.#value < 0;
  }

  isInteger(): boolean {
    return Number.isInteger(this.#value);
  }

  // Presentation -------------------------------------------------------------

  formatNumber(options?: FormatOptions): string {
    return formatNumber(this.#value, options);
  }

  formatCurrency(currency: string, options?: CurrencyOptions): string {
    return formatCurrency(this.#value, currency, options);
  }

  /** The wrapped value is a fraction: `num(0.125).formatPercent()` → `'12.5%'`. */
  formatPercent(options?: FormatOptions): string {
    return formatPercent(this.#value, options);
  }

  formatCompact(options?: CompactOptions): string {
    return formatCompact(this.#value, options);
  }

  // Extraction ---------------------------------------------------------------

  /** Exact decimal of the shortest spelling: `num(0.1).toDecimal()` is exactly 1/10. */
  toDecimal(): Decimal {
    return Decimal.from(this.#value);
  }

  toRatio(): Rational {
    return Rational.from(this.#value);
  }

  value(): number {
    return this.#value;
  }

  toString(): string {
    return String(this.#value);
  }

  toJSON(): number {
    return this.#value;
  }

  /** Throws. Use `.value()`; implicit coercion hides the wrapper's boundary. */
  valueOf(): never {
    throw new TypeError('A NumberValue cannot be used as a number; call .value()');
  }

  [Symbol.toPrimitive](hint: 'string' | 'number' | 'default'): string {
    if (hint === 'string') return this.toString();
    throw new TypeError('A NumberValue cannot be used as a number; call .value()');
  }

  readonly [Symbol.toStringTag] = 'NumberValue';
}

export function num(value: number): NumberValue {
  return new NumberValue(value);
}
