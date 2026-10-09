/**
 * `Decimal` and `Rational` live in one file because each converts to the
 * other (`toRational()` / `toDecimal()`); two modules importing each other
 * would create a load-order cycle. The public entry points are
 * `../decimal.ts` and `../rational.ts`.
 */

import type { RoundingMode } from '../rounding.js';
import type { ScaleOptions } from './fraction.js';
import type { DecimalParts } from './parse.js';
import {
  DivisionByZeroError,
  InvalidArgumentError,
  NumberFormatError,
  NumericRangeError,
  ResourceLimitError,
  RoundingNecessaryError,
} from '../errors.js';
import { abs, digitCount, divideRounded, floorDiv, gcd, pow10, sign } from './bigint.js';
import { assertScale, fractionToDecimalParts } from './fraction.js';
import { MAX_DIGITS, MAX_SCALE } from './limits.js';
import { parseDecimalString, partsFromBigInt, partsFromNumber } from './parse.js';

export type { ScaleOptions } from './fraction.js';

export type DecimalInput = Decimal | string | number | bigint;
export type RationalInput = Rational | DecimalInput;
export type IntegerInput = string | number | bigint;

const BRAND = Symbol('arki.math.exact');

function refuseCoercion(typeName: string): never {
  throw new TypeError(
    `A ${typeName} cannot be used as a number. Call .toNumber() for a float, or use .plus()/.times()/... for exact arithmetic`,
  );
}

function assertSafeExponent(exponent: number): void {
  if (!Number.isSafeInteger(exponent)) {
    throw new InvalidArgumentError(`Exponent must be a safe integer, got ${exponent}`);
  }
}

function toDecimalParts(value: DecimalInput): DecimalParts {
  if (value instanceof Decimal) return { coefficient: value.coefficient, scale: value.scale };
  switch (typeof value) {
    case 'string': {
      return parseDecimalString(value);
    }
    case 'number': {
      return partsFromNumber(value);
    }
    case 'bigint': {
      return partsFromBigInt(value);
    }
    default: {
      throw new TypeError(`Cannot build a Decimal from ${typeof value}`);
    }
  }
}

function toBigIntInput(value: IntegerInput, what: string): bigint {
  switch (typeof value) {
    case 'bigint': {
      return value;
    }
    case 'number': {
      if (!Number.isSafeInteger(value)) {
        throw new NumericRangeError(`${what} must be a safe integer, got ${value}`);
      }
      return BigInt(value);
    }
    case 'string': {
      if (!/^[+-]?\d+$/.test(value)) throw new NumberFormatError(`"${value}" is not an integer`);
      if (value.length > MAX_DIGITS) throw new ResourceLimitError(`${what} exceeds ${MAX_DIGITS} digits`);
      return BigInt(value);
    }
    default: {
      throw new TypeError(`${what} must be a string, number or bigint`);
    }
  }
}

// ---------------------------------------------------------------------------
// Decimal
// ---------------------------------------------------------------------------

/**
 * An exact finite decimal: `coefficient × 10^-scale`. Immutable. The scale
 * is retained, so `'1.10'` stays `1.10` and `'1.10' × 3` is `3.30` — what a
 * person expects from money and measurements. Equality is numeric:
 * `decimal('1.0').eq('1.00')` is `true`.
 */
export class Decimal {
  readonly coefficient: bigint;
  readonly scale: number;

  private constructor(coefficient: bigint, scale: number, brand: typeof BRAND) {
    if (brand !== BRAND) throw new TypeError('Use decimal(value) instead of new Decimal()');
    this.coefficient = coefficient;
    this.scale = scale;
    Object.freeze(this);
  }

  /** @internal */
  static fromParts(parts: DecimalParts): Decimal {
    return new Decimal(parts.coefficient, parts.scale, BRAND);
  }

  static from(value: DecimalInput): Decimal {
    return value instanceof Decimal ? value : Decimal.fromParts(toDecimalParts(value));
  }

  static sum(values: Iterable<DecimalInput>): Decimal {
    let total = ZERO;
    for (const value of values) total = total.plus(value);
    return total;
  }

  static max(first: DecimalInput, ...rest: DecimalInput[]): Decimal {
    let best = Decimal.from(first);
    for (const value of rest) if (Decimal.from(value).gt(best)) best = Decimal.from(value);
    return best;
  }

  static min(first: DecimalInput, ...rest: DecimalInput[]): Decimal {
    let best = Decimal.from(first);
    for (const value of rest) if (Decimal.from(value).lt(best)) best = Decimal.from(value);
    return best;
  }

  // Arithmetic -------------------------------------------------------------

  plus(other: DecimalInput): Decimal {
    const [a, b, scale] = align(this, Decimal.from(other));
    return new Decimal(a + b, scale, BRAND);
  }

  minus(other: DecimalInput): Decimal {
    const [a, b, scale] = align(this, Decimal.from(other));
    return new Decimal(a - b, scale, BRAND);
  }

  times(other: DecimalInput): Decimal {
    const that = Decimal.from(other);
    return new Decimal(this.coefficient * that.coefficient, this.scale + that.scale, BRAND);
  }

  /**
   * Exact when the result terminates (`1 ÷ 8 = 0.125`). When it does not
   * (`1 ÷ 3`), throws `RoundingNecessaryError` unless you say how to round:
   * `dividedBy(3, { scale: 4, rounding: 'halfEven' })`.
   */
  dividedBy(other: DecimalInput, options?: ScaleOptions): Decimal {
    const that = Decimal.from(other);
    return Decimal.fromParts(
      fractionToDecimalParts(this.coefficient * pow10(that.scale), that.coefficient * pow10(this.scale), options),
    );
  }

  /** Remainder with the sign of the dividend, like JavaScript's `%`. */
  mod(other: DecimalInput): Decimal {
    const that = Decimal.from(other);
    if (that.isZero()) throw new DivisionByZeroError('Division by zero');
    const [a, b, scale] = align(this, that);
    return new Decimal(a % b, scale, BRAND);
  }

  /** Integer exponent. Negative exponents must terminate (`2^-2 = 0.25`) or they throw. */
  pow(exponent: number): Decimal {
    assertSafeExponent(exponent);
    if (exponent === 0) return ONE;
    if (exponent < 0) {
      if (this.isZero()) throw new DivisionByZeroError('Zero cannot be raised to a negative power');
      return ONE.dividedBy(this.pow(-exponent));
    }
    if (digitCount(this.coefficient) * exponent > MAX_DIGITS || this.scale * exponent > MAX_SCALE) {
      throw new ResourceLimitError(`${this.toString()} ^ ${exponent} exceeds the digit limit`);
    }
    return new Decimal(this.coefficient ** BigInt(exponent), this.scale * exponent, BRAND);
  }

  abs(): Decimal {
    return this.coefficient < 0n ? this.negated() : this;
  }

  negated(): Decimal {
    return new Decimal(-this.coefficient, this.scale, BRAND);
  }

  // Scale ------------------------------------------------------------------

  /**
   * Changes the number of fraction digits. Adding digits is always exact;
   * dropping non-zero digits needs a rounding mode or it throws.
   */
  toScale(scale: number, rounding: RoundingMode = 'unnecessary'): Decimal {
    assertScale(scale);
    const diff = scale - this.scale;
    if (diff === 0) return this;
    if (diff > 0) return new Decimal(this.coefficient * pow10(diff), scale, BRAND);
    return new Decimal(divideRounded(this.coefficient, pow10(-diff), rounding), scale, BRAND);
  }

  /** `toScale` with the display-friendly default: half-up. `round(2)` on `1.005` gives `1.01`. */
  round(places = 0, rounding: RoundingMode = 'halfUp'): Decimal {
    return this.toScale(places, rounding);
  }

  /** Drops trailing zeros: `1.500` → `1.5`, `2.00` → `2`. */
  trim(): Decimal {
    let { coefficient, scale } = this;
    while (scale > 0 && coefficient % 10n === 0n) {
      coefficient /= 10n;
      scale--;
    }
    return scale === this.scale ? this : new Decimal(coefficient, scale, BRAND);
  }

  // Comparison -------------------------------------------------------------

  compareTo(other: DecimalInput): -1 | 0 | 1 {
    const [a, b] = align(this, Decimal.from(other));
    return a < b ? -1 : a > b ? 1 : 0;
  }

  eq(other: DecimalInput): boolean {
    return this.compareTo(other) === 0;
  }

  lt(other: DecimalInput): boolean {
    return this.compareTo(other) < 0;
  }

  lte(other: DecimalInput): boolean {
    return this.compareTo(other) <= 0;
  }

  gt(other: DecimalInput): boolean {
    return this.compareTo(other) > 0;
  }

  gte(other: DecimalInput): boolean {
    return this.compareTo(other) >= 0;
  }

  isZero(): boolean {
    return this.coefficient === 0n;
  }

  isPositive(): boolean {
    return this.coefficient > 0n;
  }

  isNegative(): boolean {
    return this.coefficient < 0n;
  }

  isInteger(): boolean {
    return this.scale === 0 || this.coefficient % pow10(this.scale) === 0n;
  }

  sign(): -1 | 0 | 1 {
    return sign(this.coefficient);
  }

  // Conversion -------------------------------------------------------------

  /** Plain notation, never exponent form: `'0.000001'`, `'-12.30'`. */
  toString(): string {
    const digits = abs(this.coefficient).toString();
    const negative = this.coefficient < 0n ? '-' : '';
    if (this.scale === 0) return negative + digits;
    const padded = digits.padStart(this.scale + 1, '0');
    return `${negative}${padded.slice(0, -this.scale)}.${padded.slice(-this.scale)}`;
  }

  /** Like `Number.prototype.toFixed`, but on the exact value and with a chosen rounding mode. */
  toFixed(places: number, rounding: RoundingMode = 'halfUp'): string {
    return this.toScale(places, rounding).toString();
  }

  /** The nearest double. Throws if that would overflow or collapse a non-zero value to zero. */
  toNumber(): number {
    const result = Number(this.toString());
    if (!Number.isFinite(result)) throw new NumericRangeError(`${this.toString()} overflows a JS number`);
    if (result === 0 && !this.isZero()) {
      throw new NumericRangeError(`${this.toString()} underflows to zero as a JS number`);
    }
    return result === 0 ? 0 : result;
  }

  /** Requires an integral value; round first if needed. */
  toBigInt(): bigint {
    if (!this.isInteger()) {
      throw new RoundingNecessaryError(
        `${this.toString()} is not an integer; round it first, e.g. .toScale(0, 'halfEven')`,
      );
    }
    return this.coefficient / pow10(this.scale);
  }

  toRational(): Rational {
    return Rational.fromParts(this.coefficient, pow10(this.scale));
  }

  toJSON(): string {
    return this.toString();
  }

  /** Throws. A `Decimal` never silently becomes a float. */
  valueOf(): never {
    return refuseCoercion('Decimal');
  }

  [Symbol.toPrimitive](hint: 'string' | 'number' | 'default'): string {
    return hint === 'string' ? this.toString() : refuseCoercion('Decimal');
  }

  readonly [Symbol.toStringTag] = 'Decimal';
}

function align(a: Decimal, b: Decimal): [bigint, bigint, number] {
  if (a.scale === b.scale) return [a.coefficient, b.coefficient, a.scale];
  if (a.scale > b.scale) return [a.coefficient, b.coefficient * pow10(a.scale - b.scale), a.scale];
  return [a.coefficient * pow10(b.scale - a.scale), b.coefficient, b.scale];
}

const ZERO = Decimal.fromParts({ coefficient: 0n, scale: 0 });
const ONE = Decimal.fromParts({ coefficient: 1n, scale: 0 });

export function decimal(value: DecimalInput): Decimal {
  return Decimal.from(value);
}

export function isDecimal(value: unknown): value is Decimal {
  return value instanceof Decimal;
}

// ---------------------------------------------------------------------------
// Rational
// ---------------------------------------------------------------------------

const RATIO_SYNTAX = /^([+-]?\d+)\s*\/\s*([+-]?\d+)$/;
const REPEATING_SYNTAX = /^([+-]?)(\d*)\.(\d*)\((\d+)\)$/;

/** A mixed number: `7/2` is `{ whole: 3n, fraction: 1/2 }`. The fraction carries the sign of the value. */
export type MixedNumber = {
  whole: bigint;
  fraction: Rational;
};

/**
 * An exact fraction of two bigints, always reduced, denominator always
 * positive, zero always `0/1`. Immutable. Where `Decimal` must throw
 * (`1 ÷ 3`), a `Rational` just keeps going.
 */
export class Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;

  private constructor(numerator: bigint, denominator: bigint, brand: typeof BRAND) {
    if (brand !== BRAND) throw new TypeError('Use ratio(value) instead of new Rational()');
    this.numerator = numerator;
    this.denominator = denominator;
    Object.freeze(this);
  }

  /** Normalizes sign and reduces by the GCD. */
  static fromParts(numerator: bigint, denominator: bigint): Rational {
    if (denominator === 0n) throw new DivisionByZeroError('A ratio cannot have a zero denominator');
    if (denominator < 0n) {
      numerator = -numerator;
      denominator = -denominator;
    }
    const divisor = gcd(numerator, denominator);
    return new Rational(numerator / divisor, denominator / divisor, BRAND);
  }

  static from(value: RationalInput): Rational {
    if (value instanceof Rational) return value;
    if (value instanceof Decimal) return value.toRational();
    if (typeof value === 'string') return parseRational(value);
    const parts = toDecimalParts(value);
    return Rational.fromParts(parts.coefficient, pow10(parts.scale));
  }

  // Arithmetic -------------------------------------------------------------

  plus(other: RationalInput): Rational {
    const that = Rational.from(other);
    return Rational.fromParts(
      this.numerator * that.denominator + that.numerator * this.denominator,
      this.denominator * that.denominator,
    );
  }

  minus(other: RationalInput): Rational {
    return this.plus(Rational.from(other).negated());
  }

  times(other: RationalInput): Rational {
    const that = Rational.from(other);
    return Rational.fromParts(this.numerator * that.numerator, this.denominator * that.denominator);
  }

  dividedBy(other: RationalInput): Rational {
    const that = Rational.from(other);
    if (that.isZero()) throw new DivisionByZeroError('Division by zero');
    return Rational.fromParts(this.numerator * that.denominator, this.denominator * that.numerator);
  }

  /** Integer exponent; negative exponents invert. */
  pow(exponent: number): Rational {
    assertSafeExponent(exponent);
    if (exponent === 0) return Rational.fromParts(1n, 1n);
    if (exponent < 0) return this.inverse().pow(-exponent);
    if ((digitCount(this.numerator) + digitCount(this.denominator)) * exponent > MAX_DIGITS) {
      throw new ResourceLimitError(`${this.toString()} ^ ${exponent} exceeds the digit limit`);
    }
    const e = BigInt(exponent);
    return new Rational(this.numerator ** e, this.denominator ** e, BRAND);
  }

  /** The reciprocal: `2/3` → `3/2`. */
  inverse(): Rational {
    if (this.isZero()) throw new DivisionByZeroError('Zero has no reciprocal');
    return Rational.fromParts(this.denominator, this.numerator);
  }

  abs(): Rational {
    return this.numerator < 0n ? this.negated() : this;
  }

  negated(): Rational {
    return new Rational(-this.numerator, this.denominator, BRAND);
  }

  /**
   * The closest fraction whose denominator is at most `maxDenominator`
   * (continued-fraction search, like Python's `limit_denominator`):
   * `ratio('3.14159').approximate(1000)` → `355/113`.
   */
  approximate(maxDenominator: IntegerInput): Rational {
    const max = toBigIntInput(maxDenominator, 'maxDenominator');
    if (max < 1n) throw new InvalidArgumentError('maxDenominator must be at least 1');
    if (this.denominator <= max) return this;

    let [p0, q0, p1, q1] = [0n, 1n, 1n, 0n];
    let [n, d] = [this.numerator, this.denominator];
    for (;;) {
      const a = floorDiv(n, d);
      const q2 = q0 + a * q1;
      if (q2 > max) break;
      [p0, q0, p1, q1] = [p1, q1, p0 + a * p1, q2];
      [n, d] = [d, n - a * d];
    }
    const k = (max - q0) / q1;
    const first = Rational.fromParts(p0 + k * p1, q0 + k * q1);
    const second = Rational.fromParts(p1, q1);
    return second.minus(this).abs().lte(first.minus(this).abs()) ? second : first;
  }

  // Comparison -------------------------------------------------------------

  compareTo(other: RationalInput): -1 | 0 | 1 {
    const that = Rational.from(other);
    const left = this.numerator * that.denominator;
    const right = that.numerator * this.denominator;
    return left < right ? -1 : left > right ? 1 : 0;
  }

  eq(other: RationalInput): boolean {
    return this.compareTo(other) === 0;
  }

  lt(other: RationalInput): boolean {
    return this.compareTo(other) < 0;
  }

  lte(other: RationalInput): boolean {
    return this.compareTo(other) <= 0;
  }

  gt(other: RationalInput): boolean {
    return this.compareTo(other) > 0;
  }

  gte(other: RationalInput): boolean {
    return this.compareTo(other) >= 0;
  }

  isZero(): boolean {
    return this.numerator === 0n;
  }

  isPositive(): boolean {
    return this.numerator > 0n;
  }

  isNegative(): boolean {
    return this.numerator < 0n;
  }

  isInteger(): boolean {
    return this.denominator === 1n;
  }

  sign(): -1 | 0 | 1 {
    return sign(this.numerator);
  }

  // Conversion -------------------------------------------------------------

  /** Exact when the fraction terminates; otherwise needs `{ scale, rounding }` or it throws. */
  toDecimal(options?: ScaleOptions): Decimal {
    return Decimal.fromParts(fractionToDecimalParts(this.numerator, this.denominator, options));
  }

  /** `7/2` → `{ whole: 3n, fraction: 1/2 }`; `-7/2` → `{ whole: -3n, fraction: -1/2 }`. */
  toMixed(): MixedNumber {
    return {
      whole: this.numerator / this.denominator,
      fraction: Rational.fromParts(this.numerator % this.denominator, this.denominator),
    };
  }

  /** The nearest double, computed through ~20 significant decimal digits. */
  toNumber(): number {
    const scale = Math.min(MAX_SCALE, Math.max(0, 20 + digitCount(this.denominator) - digitCount(this.numerator)));
    return this.toDecimal({ scale, rounding: 'halfEven' }).toNumber();
  }

  /** Requires an integral value. */
  toBigInt(): bigint {
    if (!this.isInteger()) {
      throw new RoundingNecessaryError(
        `${this.toString()} is not an integer; convert with .toDecimal({ scale: 0, rounding }) first`,
      );
    }
    return this.numerator;
  }

  /** `'1/3'`, `'-7/2'`, or just `'4'` for integers. */
  toString(): string {
    return this.denominator === 1n ? `${this.numerator}` : `${this.numerator}/${this.denominator}`;
  }

  toJSON(): string {
    return this.toString();
  }

  /** Throws. A `Rational` never silently becomes a float. */
  valueOf(): never {
    return refuseCoercion('Rational');
  }

  [Symbol.toPrimitive](hint: 'string' | 'number' | 'default'): string {
    return hint === 'string' ? this.toString() : refuseCoercion('Rational');
  }

  readonly [Symbol.toStringTag] = 'Rational';
}

/** Accepts `'3/4'`, `'0.(3)'`, `'1.2(34)'` and any plain decimal string. */
function parseRational(input: string): Rational {
  const ratioMatch = RATIO_SYNTAX.exec(input);
  if (ratioMatch) {
    return Rational.fromParts(toBigIntInput(ratioMatch[1]!, 'numerator'), toBigIntInput(ratioMatch[2]!, 'denominator'));
  }
  const repeating = REPEATING_SYNTAX.exec(input);
  if (repeating) {
    const [, signText, integerDigits, fractionDigits, repeatDigits] = repeating;
    const fixed = BigInt((integerDigits || '0') + (fractionDigits ?? ''));
    const period = pow10(repeatDigits!.length) - 1n;
    const numerator = fixed * period + BigInt(repeatDigits!);
    const denominator = period * pow10(fractionDigits!.length);
    return Rational.fromParts(signText === '-' ? -numerator : numerator, denominator);
  }
  const parts = parseDecimalString(input);
  return Rational.fromParts(parts.coefficient, pow10(parts.scale));
}

export function ratio(value: RationalInput): Rational;
export function ratio(numerator: IntegerInput, denominator: IntegerInput): Rational;
export function ratio(first: RationalInput, second?: IntegerInput): Rational {
  if (second === undefined) return Rational.from(first);
  return Rational.fromParts(toBigIntInput(first as IntegerInput, 'numerator'), toBigIntInput(second, 'denominator'));
}

export function isRational(value: unknown): value is Rational {
  return value instanceof Rational;
}
