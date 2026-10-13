/**
 * Exact money. A `Money` is a whole number of units, a scale (how many of the
 * digits are decimals) and a currency: `19.99 EUR` is `1999` units at scale 2.
 *
 * Rules that protect you from silent loss:
 * - Nothing rounds unless you pass a rounding mode. An operation whose exact
 *   result does not fit throws `RoundingNecessaryError`.
 * - Mixing currencies throws `CurrencyMismatchError`. With literal codes the
 *   compiler already rejects it: `Money<'EUR'>` cannot be added to `Money<'USD'>`.
 * - `allocate` and `split` return parts that add back to the whole exactly.
 * - A `Money` never becomes a float by accident: `+price` throws.
 *
 * Speed: units are a plain `number` while they are a safe integer (up to 90
 * trillion in a two-decimal currency) and a `bigint` only beyond that. Values
 * are immutable through `readonly` and a private constructor; they are not
 * frozen, because `Object.freeze` costs more per operation than the arithmetic.
 */

import type { RoundingMode } from '@arki/math/rounding';
import {
  DivisionByZeroError,
  EmptyDataError,
  InvalidArgumentError,
  NumberFormatError,
  NumericRangeError,
  ResourceLimitError,
  RoundingNecessaryError,
} from '@arki/math/errors';

import type { Currency, CurrencyLike } from './currency.js';
import type { Units } from './internal/units.js';
import { assertSameCurrency, resolveCurrency, toCurrency } from './currency.js';
import {
  addUnits,
  canon,
  compareUnits,
  MAX_INPUT_LENGTH,
  MAX_PARTS,
  MAX_SCALE,
  mulDiv,
  mulUnits,
  negUnits,
  parseDecimal,
  parseNumber,
  pow10,
  quantize,
} from './internal/units.js';

export type { Units } from './internal/units.js';

/** An exact decimal such as `@arki/math`'s `Decimal`: `coefficient × 10^-scale`. */
export type DecimalLike = { readonly coefficient: bigint; readonly scale: number };
/** An exact fraction such as `@arki/math`'s `Rational`. */
export type RationalLike = { readonly numerator: bigint; readonly denominator: bigint };

/**
 * An amount in major units: `'19.99'`, `19.99`, `20n`, a `Decimal` or a `Rational`.
 * A `number` is read as written (`19.99` is exactly 19.99); earlier float
 * arithmetic cannot be undone, so prefer strings for computed values.
 */
export type Amount = number | string | bigint | DecimalLike | RationalLike;

/** A multiplier or divisor: an `Amount` or a `Factor` prepared once with `factor()`. */
export type FactorInput = Amount | Factor;

export type MoneyOptions = {
  /** How to drop digits that do not fit. Without it, extra digits throw `RoundingNecessaryError`. */
  rounding?: RoundingMode;
  /** Number of decimals to keep, 0–100. Defaults to the currency's (2 for EUR). Use 4 for unit prices. */
  scale?: number;
};

/** Who gets the leftover units when an amount does not divide evenly. */
export type RemainderPolicy = 'largest' | 'first' | 'last';

export type AllocateOptions = {
  /**
   * `'largest'` (default): one unit each to the parts whose exact share lost
   * the most, earlier parts first on ties. `'first'` / `'last'`: one unit each
   * from the start / end. Parts with a zero ratio never receive a unit.
   */
  remainder?: RemainderPolicy;
};

export type MoneyJSON = { amount: string; currency: string };

const BRAND = Symbol('Money');
const MAX = Number.MAX_SAFE_INTEGER;
const INTEGER = /^[+-]?\d+$/;

// `read()` leaves a factor's fraction here instead of allocating an object.
let num: Units = 0;
let den: Units = 1;

/** A multiplier read once, for loops: `const vat = factor('0.19')`. */
export class Factor {
  readonly numerator: Units;
  /** Always positive. */
  readonly denominator: Units;

  private constructor(numerator: Units, denominator: Units, brand: typeof BRAND) {
    if (brand !== BRAND) throw new TypeError('Use factor(value) instead of new Factor()');
    this.numerator = numerator;
    this.denominator = denominator;
  }

  /** @internal */
  static create(numerator: Units, denominator: Units): Factor {
    return new Factor(numerator, denominator, BRAND);
  }
}

/** Prepares a multiplier once so `times` skips parsing: `price.times(vat, 'halfEven')`. */
export function factor(value: Amount): Factor {
  read(value);
  return Factor.create(num, den);
}

function read(value: FactorInput): void {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) {
      num = value + 0;
      den = 1;
      return;
    }
    const parsed = parseNumber(value);
    num = parsed.coefficient;
    den = pow10(parsed.fraction);
    return;
  }
  if (typeof value === 'string') {
    const parsed = parseDecimal(value);
    num = parsed.coefficient;
    den = pow10(parsed.fraction);
    return;
  }
  if (typeof value === 'bigint') {
    num = canon(value);
    den = 1;
    return;
  }
  if (value instanceof Factor) {
    num = value.numerator;
    den = value.denominator;
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- plain JavaScript can pass null
  if (typeof value === 'object' && value !== null) {
    if ('coefficient' in value && typeof value.coefficient === 'bigint' && typeof value.scale === 'number') {
      if (!Number.isInteger(value.scale) || value.scale < 0 || value.scale > MAX_INPUT_LENGTH * 10) {
        throw new InvalidArgumentError(`Unsupported decimal scale ${value.scale}`);
      }
      num = canon(value.coefficient);
      den = pow10(value.scale);
      return;
    }
    if ('numerator' in value && typeof value.numerator === 'bigint' && typeof value.denominator === 'bigint') {
      if (value.denominator === 0n) throw new DivisionByZeroError('A ratio cannot have a zero denominator');
      const negative = value.denominator < 0n;
      num = canon(negative ? -value.numerator : value.numerator);
      den = canon(negative ? -value.denominator : value.denominator);
      return;
    }
  }
  throw new TypeError('Expected a number, string, bigint, Decimal, Rational or Factor');
}

function checkScale(scale: number): number {
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) {
    throw new InvalidArgumentError(`A scale is a whole number from 0 to ${MAX_SCALE}, got ${scale}`);
  }
  return scale;
}

function refuseCoercion(): never {
  throw new TypeError(
    'Money cannot be turned into a number implicitly; use toDecimalString(), toMinorUnits() or toNumber()',
  );
}

/** An immutable amount of money. Create one with `money()` or the `Money.*` factories. */
export class Money<C extends string = string> {
  /** The amount as a whole number of `10^-scale` units, in canonical form: a `number` exactly when it is a safe integer. */
  readonly units: Units;
  /** Number of decimals the amount carries. Equals `currency.scale` unless chosen otherwise. */
  readonly scale: number;
  readonly currency: Currency<C>;

  private constructor(units: Units, scale: number, currency: Currency<C>, brand: typeof BRAND) {
    if (brand !== BRAND) throw new TypeError('Use money(amount, currency) instead of new Money()');
    this.units = units;
    this.scale = scale;
    this.currency = currency;
  }

  /** @internal Builds a value from already-validated parts. */
  static create<C extends string>(units: Units, scale: number, currency: Currency<C>): Money<C> {
    return new Money(units, scale, currency, BRAND);
  }

  // Construction -----------------------------------------------------------

  /**
   * `Money.of('19.99', 'EUR')`. Extra digits throw `RoundingNecessaryError`
   * unless `options.rounding` is given: `Money.of('1.005', 'EUR', { rounding: 'halfEven' })` → `1.00 EUR`.
   * A `Money` input must be in the same currency; this also narrows `Money<string>` to `Money<'EUR'>`.
   */
  static of<const C extends string>(
    amount: Amount | Money,
    currency: CurrencyLike<C>,
    options?: MoneyOptions,
  ): Money<C> {
    const cur = toCurrency(currency);
    const scale = options?.scale === undefined ? cur.scale : checkScale(options.scale);
    const rounding = options?.rounding;
    if (amount instanceof Money) {
      assertSameCurrency(amount.currency, cur);
      return new Money(quantize(amount.units, amount.scale, scale, rounding), scale, cur, BRAND);
    }
    read(amount);
    return new Money(mulDiv(num, pow10(scale), den, rounding), scale, cur, BRAND);
  }

  /**
   * From whole minor units: `Money.fromMinor(1999, 'EUR')` → `19.99 EUR`. Accepts a
   * safe-integer `number`, a `bigint`, or an integer string (as databases return
   * `BIGINT`). `scale` says how many decimals the units carry; it defaults to the currency's.
   */
  static fromMinor<const C extends string>(
    units: number | bigint | string,
    currency: CurrencyLike<C>,
    scale?: number,
  ): Money<C> {
    const cur = toCurrency(currency);
    return new Money(toUnits(units), scale === undefined ? cur.scale : checkScale(scale), cur, BRAND);
  }

  /** Zero in this currency. */
  static zero<const C extends string>(currency: CurrencyLike<C>, scale?: number): Money<C> {
    const cur = toCurrency(currency);
    return new Money(0, scale === undefined ? cur.scale : checkScale(scale), cur, BRAND);
  }

  /**
   * Reads what `toString()` writes: `'19.99 EUR'`, also `'EUR 19.99'`. Keeps the
   * text's decimals when there are more than the currency's (`'1.2345 EUR'`
   * stays at scale 4). Pass `currencies` to resolve custom codes.
   */
  static parse(text: string, currencies?: readonly Currency[]): Money {
    if (typeof text !== 'string') throw new TypeError('Money.parse expects a string');
    const parts = text.trim().split(/\s+/);
    const [first = '', second = ''] = parts;
    if (parts.length !== 2) {
      throw new NumberFormatError(`Cannot read ${JSON.stringify(text.slice(0, 40))} as money; expected '19.99 EUR'`);
    }
    const amountFirst = /^[+-]?\d/.test(first);
    return fromText(amountFirst ? first : second, resolveCurrency(amountFirst ? second : first, currencies));
  }

  /** Reads `{ amount: '19.99', currency: 'EUR' }`, keeping the amount's decimals. Validates the shape. */
  static fromJSON(value: unknown, currencies?: readonly Currency[]): Money {
    if (typeof value !== 'object' || value === null || !('amount' in value) || !('currency' in value)) {
      throw new InvalidArgumentError('Expected { amount: string, currency: string }');
    }
    const { amount, currency } = value;
    if (typeof amount !== 'string' || typeof currency !== 'string') {
      throw new InvalidArgumentError('Expected { amount: string, currency: string }');
    }
    return fromText(amount, resolveCurrency(currency, currencies));
  }

  /** Comparator for sorting: `prices.sort(Money.compare)`. Throws on mixed currencies. */
  static compare(this: void, a: Money, b: Money): -1 | 0 | 1 {
    return a.compareTo(b);
  }

  // Arithmetic -------------------------------------------------------------

  /** Exact sum. Different scales are aligned upward, never rounded. */
  plus(other: Money<C>): Money<C> {
    const cur = this.currency;
    if (cur !== other.currency) assertSameCurrency(cur, other.currency);
    const scale = this.scale;
    if (scale !== other.scale) return combine(this, other, false);
    const a = this.units;
    const b = other.units;
    if (typeof a === 'number' && typeof b === 'number') {
      const sum = a + b;
      if (sum <= MAX && sum >= -MAX) return new Money(sum, scale, cur, BRAND);
    }
    return new Money(addUnits(a, b), scale, cur, BRAND);
  }

  /** Exact difference. Different scales are aligned upward, never rounded. */
  minus(other: Money<C>): Money<C> {
    const cur = this.currency;
    if (cur !== other.currency) assertSameCurrency(cur, other.currency);
    const scale = this.scale;
    if (scale !== other.scale) return combine(this, other, true);
    const a = this.units;
    const b = other.units;
    if (typeof a === 'number' && typeof b === 'number') {
      const difference = a - b;
      if (difference <= MAX && difference >= -MAX) return new Money(difference, scale, cur, BRAND);
    }
    return new Money(addUnits(a, negUnits(b)), scale, cur, BRAND);
  }

  /**
   * Multiplies and keeps this scale. `money('10.00', 'EUR').times(3)` → `30.00`.
   * `times('1.19')` on `9.99` is `11.8881`, which does not fit two decimals, so
   * it throws unless you pass a rounding mode: `times('1.19', 'halfEven')` → `11.89`.
   */
  times(multiplier: FactorInput, rounding?: RoundingMode): Money<C> {
    if (typeof multiplier === 'number' && Number.isSafeInteger(multiplier)) {
      return new Money(mulUnits(this.units, multiplier), this.scale, this.currency, BRAND);
    }
    read(multiplier);
    return new Money(mulDiv(this.units, num, den, rounding), this.scale, this.currency, BRAND);
  }

  /** Divides and keeps this scale. Inexact results need a rounding mode. Zero throws `DivisionByZeroError`. */
  dividedBy(divisor: FactorInput, rounding?: RoundingMode): Money<C> {
    read(divisor);
    const n = num;
    const d = den;
    if (n === 0) throw new DivisionByZeroError('Division by zero');
    const units = n < 0 ? mulDiv(negUnits(this.units), d, negUnits(n), rounding) : mulDiv(this.units, d, n, rounding);
    return new Money(units, this.scale, this.currency, BRAND);
  }

  /** `money(200, 'EUR').percentage(15)` → `30.00 EUR`. Same as `times(percent / 100)`. */
  percentage(percent: FactorInput, rounding?: RoundingMode): Money<C> {
    read(percent);
    return new Money(mulDiv(this.units, num, mulUnits(den, 100), rounding), this.scale, this.currency, BRAND);
  }

  negated(): Money<C> {
    return new Money(negUnits(this.units), this.scale, this.currency, BRAND);
  }

  abs(): Money<C> {
    return this.units < 0 ? this.negated() : this;
  }

  /** Changes the number of decimals. Dropping non-zero digits needs a rounding mode. */
  toScale(scale: number, rounding?: RoundingMode): Money<C> {
    checkScale(scale);
    if (scale === this.scale) return this;
    return new Money(quantize(this.units, this.scale, scale, rounding), scale, this.currency, BRAND);
  }

  /**
   * Rounds to a multiple of `step`, for cash: `chf.roundToStep('0.05', 'halfUp')`.
   * Cash steps are set by each country's law (CHF 0.05, SEK 1, EUR 0.05 in some
   * euro countries), so the package does not guess them. The step must fit this scale.
   */
  roundToStep(step: FactorInput, rounding?: RoundingMode): Money<C> {
    read(step);
    if (!(num > 0)) throw new InvalidArgumentError('A rounding step must be positive');
    let stepUnits: Units;
    try {
      stepUnits = mulDiv(num, pow10(this.scale), den);
    } catch (error) {
      if (!(error instanceof RoundingNecessaryError)) throw error;
      throw new InvalidArgumentError(`The step has more decimals than this amount's ${this.scale}`, { cause: error });
    }
    const units = mulUnits(mulDiv(this.units, 1, stepUnits, rounding), stepUnits);
    return new Money(units, this.scale, this.currency, BRAND);
  }

  // Allocation -------------------------------------------------------------

  /**
   * Splits by ratios into parts that add back to this amount exactly:
   * `money(100, 'EUR').allocate([1, 1, 1])` → `[33.34, 33.33, 33.33]`.
   * Ratios are non-negative numbers, bigints or decimal strings, not all zero.
   * A negative amount is split like a positive one and each part re-signed.
   */
  allocate(ratios: readonly (number | bigint | string)[], options?: AllocateOptions): Money<C>[] {
    const count = ratios.length;
    if (count === 0) throw new InvalidArgumentError('allocate needs at least one ratio');
    if (count > MAX_PARTS) throw new ResourceLimitError(`allocate makes at most ${MAX_PARTS} parts`);
    const coefficients: Units[] = [];
    const fractions: number[] = [];
    let common = 0;
    for (const ratio of ratios) {
      const parsed =
        typeof ratio === 'number'
          ? parseNumber(ratio)
          : typeof ratio === 'string'
            ? parseDecimal(ratio)
            : typeof ratio === 'bigint'
              ? { coefficient: canon(ratio), fraction: 0 }
              : badRatio();
      if (parsed.coefficient < 0) throw new InvalidArgumentError(`Ratios must not be negative, got ${String(ratio)}`);
      coefficients.push(parsed.coefficient);
      fractions.push(parsed.fraction);
      if (parsed.fraction > common) common = parsed.fraction;
    }
    const weights: Units[] = [];
    let total: Units = 0;
    for (let i = 0; i < count; i++) {
      const weight = mulUnits(coefficients[i] ?? 0, pow10(common - (fractions[i] ?? 0)));
      weights.push(weight);
      total = addUnits(total, weight);
    }
    if (total === 0) throw new InvalidArgumentError('Ratios must not all be zero');
    return distribute(this, weights, total, options?.remainder ?? 'largest');
  }

  /** Splits into `parts` equal shares that differ by at most one unit: `money(10, 'EUR').split(3)` → `[3.34, 3.33, 3.33]`. */
  split(parts: number, options?: AllocateOptions): Money<C>[] {
    if (!Number.isInteger(parts) || parts < 1)
      throw new InvalidArgumentError(`split needs a whole number of parts ≥ 1, got ${parts}`);
    if (parts > MAX_PARTS) throw new ResourceLimitError(`split makes at most ${MAX_PARTS} parts`);
    const negative = this.units < 0;
    const magnitude = negative ? negUnits(this.units) : this.units;
    const share = mulDiv(magnitude, 1, parts, 'down');
    const left = Number(addUnits(magnitude, negUnits(mulUnits(share, parts))));
    const bigger = addUnits(share, 1);
    const fromEnd = options?.remainder === 'last';
    const result: Money<C>[] = [];
    for (let i = 0; i < parts; i++) {
      const gets = fromEnd ? i >= parts - left : i < left;
      const units = gets ? bigger : share;
      result.push(new Money(negative ? negUnits(units) : units, this.scale, this.currency, BRAND));
    }
    return result;
  }

  // Comparison -------------------------------------------------------------

  /** Compares values across scales (`1.5` equals `1.50`). Throws on mixed currencies. */
  compareTo(other: Money<C>): -1 | 0 | 1 {
    if (this.currency !== other.currency) assertSameCurrency(this.currency, other.currency);
    if (this.scale === other.scale) return compareUnits(this.units, other.units);
    const scale = Math.max(this.scale, other.scale);
    return compareUnits(
      mulUnits(this.units, pow10(scale - this.scale)),
      mulUnits(other.units, pow10(scale - other.scale)),
    );
  }

  eq(other: Money<C>): boolean {
    return this.compareTo(other) === 0;
  }

  lt(other: Money<C>): boolean {
    return this.compareTo(other) < 0;
  }

  lte(other: Money<C>): boolean {
    return this.compareTo(other) <= 0;
  }

  gt(other: Money<C>): boolean {
    return this.compareTo(other) > 0;
  }

  gte(other: Money<C>): boolean {
    return this.compareTo(other) >= 0;
  }

  isZero(): boolean {
    return this.units === 0;
  }

  isPositive(): boolean {
    return this.units > 0;
  }

  isNegative(): boolean {
    return this.units < 0;
  }

  sign(): -1 | 0 | 1 {
    return compareUnits(this.units, 0);
  }

  /** Same currency. Never throws. */
  hasSameCurrency(other: Money): boolean {
    return this.currency.eq(other.currency);
  }

  // Output -----------------------------------------------------------------

  /** Units at the currency's scale: `19.99 EUR` → `1999`. Throws `RoundingNecessaryError` if sub-cent digits are not zero. */
  toMinorUnits(): Units {
    return quantize(this.units, this.scale, this.currency.scale);
  }

  /** `toMinorUnits()` as a `bigint`. */
  toMinorBigInt(): bigint {
    return BigInt(this.toMinorUnits());
  }

  /** `toMinorUnits()` as a `number`, as payment APIs want. Throws `NumericRangeError` past 2^53. */
  toMinorNumber(): number {
    const units = this.toMinorUnits();
    if (typeof units !== 'number')
      throw new NumericRangeError(`${this.toString()} has too many minor units for a number`);
    return units;
  }

  /** Plain decimal text with exactly `scale` decimals: `'19.99'`, `'-0.50'`, `'1000'` for JPY. For databases. */
  toDecimalString(): string {
    const units = this.units;
    const negative = units < 0;
    let digits = String(negative ? negUnits(units) : units);
    const scale = this.scale;
    if (scale === 0) return negative ? `-${digits}` : digits;
    if (digits.length <= scale) digits = '0'.repeat(scale - digits.length + 1) + digits;
    const text = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
    return negative ? `-${text}` : text;
  }

  /** The nearest double. For charts and display math only, never for more money math. */
  toNumber(): number {
    return Number(this.toDecimalString());
  }

  /** `'19.99 EUR'`. Locale-free; `Money.parse` reads it back. */
  toString(): string {
    return `${this.toDecimalString()} ${this.currency.code}`;
  }

  /** `{ amount: '19.99', currency: 'EUR' }`. The amount is a string, so no digit is ever lost. */
  toJSON(): MoneyJSON {
    return { amount: this.toDecimalString(), currency: this.currency.code };
  }

  /** Throws. A `Money` never silently becomes a float. */
  valueOf(): never {
    return refuseCoercion();
  }

  [Symbol.toPrimitive](hint: string): string {
    return hint === 'string' ? this.toString() : refuseCoercion();
  }

  // A getter lives on the prototype; a field would add a slot to every Money.
  // eslint-disable-next-line @typescript-eslint/class-literal-property-style
  get [Symbol.toStringTag](): string {
    return 'Money';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `Money(${this.toString()})`;
  }

  [Symbol.for('Deno.customInspect')](): string {
    return `Money(${this.toString()})`;
  }
}

function badRatio(): never {
  throw new TypeError('Ratios must be numbers, bigints or decimal strings');
}

function toUnits(value: number | bigint | string): Units {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new NumericRangeError(`Minor units must be a safe integer, got ${value}`);
    return value + 0;
  }
  if (typeof value === 'bigint') return canon(value);
  if (typeof value === 'string' && value.length <= MAX_INPUT_LENGTH && INTEGER.test(value)) return canon(BigInt(value));
  throw new NumberFormatError(`Minor units must be a whole number, got ${JSON.stringify(String(value).slice(0, 40))}`);
}

function fromText(text: string, currency: Currency): Money {
  const parsed = parseDecimal(text);
  const scale = checkScale(Math.max(parsed.fraction, currency.scale));
  return Money.create(quantize(parsed.coefficient, parsed.fraction, scale), scale, currency);
}

function combine<C extends string>(a: Money<C>, b: Money<C>, subtract: boolean): Money<C> {
  const scale = Math.max(a.scale, b.scale);
  const left = mulUnits(a.units, pow10(scale - a.scale));
  const right = mulUnits(b.units, pow10(scale - b.scale));
  return Money.create(addUnits(left, subtract ? negUnits(right) : right), scale, a.currency);
}

function distribute<C extends string>(
  whole: Money<C>,
  weights: readonly Units[],
  total: Units,
  policy: RemainderPolicy,
): Money<C>[] {
  const negative = whole.units < 0;
  const magnitude = negative ? negUnits(whole.units) : whole.units;
  const count = weights.length;
  const shares: Units[] = [];
  const rests: Units[] = [];
  let given: Units = 0;
  for (let i = 0; i < count; i++) {
    const exact = mulUnits(magnitude, weights[i] ?? 0);
    const share = mulDiv(exact, 1, total, 'down');
    shares.push(share);
    rests.push(addUnits(exact, negUnits(mulUnits(share, total))));
    given = addUnits(given, share);
  }
  // Fewer than `count` units are left, and only parts with a non-zero rest can need one.
  let left = Number(addUnits(magnitude, negUnits(given)));
  if (left > 0) {
    const order: number[] = [];
    for (let i = 0; i < count; i++) if (weights[i] !== 0) order.push(i);
    if (policy === 'largest') order.sort((x, y) => compareUnits(rests[y] ?? 0, rests[x] ?? 0) || x - y);
    else if (policy === 'last') order.reverse();
    for (const index of order) {
      if (left === 0) break;
      shares[index] = addUnits(shares[index] ?? 0, 1);
      left -= 1;
    }
  }
  return shares.map(share => Money.create(negative ? negUnits(share) : share, whole.scale, whole.currency));
}

// Shorthands and aggregates ------------------------------------------------

/** Shorthand for `Money.of`: `money('19.99', 'EUR')`. */
export function money<const C extends string>(
  amount: Amount | Money,
  currency: CurrencyLike<C>,
  options?: MoneyOptions,
): Money<C> {
  return Money.of(amount, currency, options);
}

export function isMoney(value: unknown): value is Money {
  return value instanceof Money;
}

/**
 * Exact total of one currency, with one allocation for the result. An empty
 * list needs `currency` and returns zero; otherwise it throws `InvalidArgumentError`.
 */
export function sum<const C extends string>(items: Iterable<Money<C>>, currency?: CurrencyLike<C>): Money<C> {
  let cur: Currency<C> | undefined = currency === undefined ? undefined : toCurrency(currency);
  let scale = cur?.scale ?? -1;
  let units: Units = 0;
  for (const item of items) {
    if (cur === undefined) {
      cur = item.currency;
      scale = item.scale;
    } else if (cur !== item.currency) {
      assertSameCurrency(cur, item.currency);
    }
    let value = item.units;
    if (item.scale > scale) {
      units = mulUnits(units, pow10(item.scale - scale));
      scale = item.scale;
    } else if (item.scale < scale) {
      value = mulUnits(value, pow10(scale - item.scale));
    }
    if (typeof units === 'number' && typeof value === 'number') {
      const next: number = units + value;
      units = next <= MAX && next >= -MAX ? next : addUnits(units, value);
    } else {
      units = addUnits(units, value);
    }
  }
  if (cur === undefined) throw new InvalidArgumentError('sum of an empty list needs a currency');
  return Money.create(units, scale, cur);
}

/** Mean of one currency. Inexact results need a rounding mode. An empty list throws `EmptyDataError`. */
export function average<const C extends string>(items: Iterable<Money<C>>, rounding?: RoundingMode): Money<C> {
  const list = [...items];
  if (list.length === 0) throw new EmptyDataError('average of an empty list');
  return sum(list).dividedBy(list.length, rounding);
}

/** The smallest value; ties return the first. */
export function min<const C extends string>(first: Money<C>, ...rest: Money<C>[]): Money<C> {
  let best = first;
  for (const item of rest) if (item.lt(best)) best = item;
  return best;
}

/** The largest value; ties return the first. */
export function max<const C extends string>(first: Money<C>, ...rest: Money<C>[]): Money<C> {
  let best = first;
  for (const item of rest) if (item.gt(best)) best = item;
  return best;
}

/** @internal Reads an amount or factor as an exact fraction whose denominator is positive. */
export function toFraction(value: FactorInput): [numerator: Units, denominator: Units] {
  read(value);
  return [num, den];
}
