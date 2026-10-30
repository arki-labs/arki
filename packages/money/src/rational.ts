/**
 * Exact in-between money. A `RationalMoney` is a fraction of major units plus
 * a currency, so a chain of steps (split a third, add tax, convert) never
 * rounds until you settle it with `toMoney`, and the currency travels with
 * the value the whole way: EUR and USD still cannot be mixed.
 *
 * ```ts
 * const share = RationalMoney.from(money(100, 'EUR')).dividedBy(3).times('1.19');
 * share.toString();                         // '119/3 EUR'
 * share.toMoney({ rounding: 'halfEven' });  // 39.67 EUR, rounded once
 * ```
 */

import type { Rational } from '@arki/math/rational';
import { ratio } from '@arki/math/rational';

import type { CurrencyLike } from './currency.js';
import type { Amount, FactorInput, MoneyJSON, MoneyOptions } from './money.js';
import { assertSameCurrency, Currency, toCurrency } from './currency.js';
import { InputTooLarge, InvalidMoneyShape, InvalidMoneyText, isMoneyFailure } from './failures.js';
import { MAX_INPUT_LENGTH, parseDecimal, pow10 } from './internal/units.js';
import { Money, toFraction } from './money.js';

const BRAND = Symbol('RationalMoney');

/** Something with an exact value in a currency: a `Money` or a `RationalMoney`. */
export type ExactMoney<C extends string = string> = Money<C> | RationalMoney<C>;

function fraction(value: FactorInput): Rational {
  const [numerator, denominator] = toFraction(value);
  return ratio(BigInt(numerator), BigInt(denominator));
}

function toRationalAmount(value: ExactMoney): Rational {
  return value instanceof RationalMoney ? value.amount : ratio(BigInt(value.units), 10n ** BigInt(value.scale));
}

const RATIO_TEXT = /^([+-]?\d+)\/(\d+)$/;

/** `'1/3'`, `'-7/2'` or plain decimal text (`'5'`, `'19.99'`) as an exact fraction, or a failure. */
function readRatio(text: string) {
  if (text.length > MAX_INPUT_LENGTH) return InputTooLarge();
  const match = RATIO_TEXT.exec(text);
  if (match === null) {
    const parsed = parseDecimal(text);
    if (isMoneyFailure(parsed)) return parsed;
    return ratio(BigInt(parsed.coefficient), BigInt(pow10(parsed.fraction)));
  }
  const denominator = BigInt(match[2] ?? '');
  if (denominator === 0n) return InvalidMoneyText();
  return ratio(BigInt(match[1] ?? ''), denominator);
}

function refuseCoercion(): never {
  throw new TypeError('RationalMoney cannot be turned into a number implicitly; settle it with toMoney()');
}

/** An immutable exact amount: a fraction of major units in one currency. */
export class RationalMoney<C extends string = string> {
  /** Major units as a reduced fraction. */
  readonly amount: Rational;
  readonly currency: Currency<C>;

  private constructor(amount: Rational, currency: Currency<C>, brand: typeof BRAND) {
    if (brand !== BRAND) throw new TypeError('Use RationalMoney.of() or RationalMoney.from() instead of new');
    this.amount = amount;
    this.currency = currency;
  }

  /** `RationalMoney.of('1/3', 'EUR')`, or any `Amount` (`'19.99'`, `ratio(1, 3)`). Never rounds. */
  static of<const C extends string>(amount: Amount | ExactMoney, currency: CurrencyLike<C>): RationalMoney<C> {
    const cur = toCurrency(currency);
    if (amount instanceof Money || amount instanceof RationalMoney) {
      assertSameCurrency(amount.currency, cur);
      return new RationalMoney(toRationalAmount(amount), cur, BRAND);
    }
    if (typeof amount === 'string' && amount.includes('/')) return new RationalMoney(ratio(amount), cur, BRAND);
    return new RationalMoney(fraction(amount), cur, BRAND);
  }

  /** The exact value of a `Money`. */
  static from<C extends string>(value: Money<C>): RationalMoney<C> {
    return new RationalMoney(toRationalAmount(value), value.currency, BRAND);
  }

  /** Zero in this currency. */
  static zero<const C extends string>(currency: CurrencyLike<C>): RationalMoney<C> {
    return new RationalMoney(ratio(0), toCurrency(currency), BRAND);
  }

  /**
   * Reads `{ amount: '1/3', currency: 'EUR' }`, as written by `toJSON`: a door for outside values,
   * like `Money.fromJSON`. Returns `InvalidMoneyShape`, `UnknownCurrency`, `InvalidMoneyText` (also
   * for a zero denominator) or `InputTooLarge` (text over 1000 characters) instead of throwing.
   */
  static fromJSON(value: unknown, currencies?: readonly Currency[]) {
    if (typeof value !== 'object' || value === null || !('amount' in value) || !('currency' in value)) {
      return InvalidMoneyShape();
    }
    const { amount, currency: code } = value;
    if (typeof amount !== 'string' || typeof code !== 'string') return InvalidMoneyShape();
    const currency = Currency.parse(code, currencies);
    if (isMoneyFailure(currency)) return currency;
    const exact = readRatio(amount);
    if (isMoneyFailure(exact)) return exact;
    return new RationalMoney(exact, currency, BRAND);
  }

  /** @internal */
  static create<C extends string>(amount: Rational, currency: Currency<C>): RationalMoney<C> {
    return new RationalMoney(amount, currency, BRAND);
  }

  // Arithmetic: always exact ------------------------------------------------

  plus(other: ExactMoney<C>): RationalMoney<C> {
    assertSameCurrency(this.currency, other.currency);
    return new RationalMoney(this.amount.plus(toRationalAmount(other)), this.currency, BRAND);
  }

  minus(other: ExactMoney<C>): RationalMoney<C> {
    assertSameCurrency(this.currency, other.currency);
    return new RationalMoney(this.amount.minus(toRationalAmount(other)), this.currency, BRAND);
  }

  times(multiplier: FactorInput): RationalMoney<C> {
    return new RationalMoney(this.amount.times(fraction(multiplier)), this.currency, BRAND);
  }

  /** Zero throws `DivisionByZeroError`. */
  dividedBy(divisor: FactorInput): RationalMoney<C> {
    return new RationalMoney(this.amount.dividedBy(fraction(divisor)), this.currency, BRAND);
  }

  /** `percentage(15)` is `times(15 / 100)`. */
  percentage(percent: FactorInput): RationalMoney<C> {
    return new RationalMoney(this.amount.times(fraction(percent)).dividedBy(100), this.currency, BRAND);
  }

  negated(): RationalMoney<C> {
    return new RationalMoney(this.amount.negated(), this.currency, BRAND);
  }

  abs(): RationalMoney<C> {
    return this.amount.isNegative() ? this.negated() : this;
  }

  // Comparison --------------------------------------------------------------

  compareTo(other: ExactMoney<C>): -1 | 0 | 1 {
    assertSameCurrency(this.currency, other.currency);
    return this.amount.compareTo(toRationalAmount(other));
  }

  eq(other: ExactMoney<C>): boolean {
    return this.compareTo(other) === 0;
  }

  lt(other: ExactMoney<C>): boolean {
    return this.compareTo(other) < 0;
  }

  lte(other: ExactMoney<C>): boolean {
    return this.compareTo(other) <= 0;
  }

  gt(other: ExactMoney<C>): boolean {
    return this.compareTo(other) > 0;
  }

  gte(other: ExactMoney<C>): boolean {
    return this.compareTo(other) >= 0;
  }

  isZero(): boolean {
    return this.amount.isZero();
  }

  isPositive(): boolean {
    return this.amount.isPositive();
  }

  isNegative(): boolean {
    return this.amount.isNegative();
  }

  sign(): -1 | 0 | 1 {
    return this.amount.sign();
  }

  // Settling and output -----------------------------------------------------

  /**
   * Rounds once to a `Money` at the currency's scale (or `options.scale`).
   * An inexact value needs `options.rounding`: `'1/3 EUR'` throws without it.
   */
  toMoney(options?: MoneyOptions): Money<C> {
    return Money.of(this.amount, this.currency, options);
  }

  /** `'1/3 EUR'`, `'5 EUR'`. */
  toString(): string {
    return `${this.amount.toString()} ${this.currency.code}`;
  }

  /** `{ amount: '1/3', currency: 'EUR' }`. */
  toJSON(): MoneyJSON {
    return { amount: this.amount.toString(), currency: this.currency.code };
  }

  /** Throws. Settle with `toMoney()` first. */
  valueOf(): never {
    return refuseCoercion();
  }

  [Symbol.toPrimitive](hint: string): string {
    return hint === 'string' ? this.toString() : refuseCoercion();
  }

  // A getter lives on the prototype; a field would add a slot to every value.
  // eslint-disable-next-line @typescript-eslint/class-literal-property-style
  get [Symbol.toStringTag](): string {
    return 'RationalMoney';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `RationalMoney(${this.toString()})`;
  }

  [Symbol.for('Deno.customInspect')](): string {
    return `RationalMoney(${this.toString()})`;
  }
}

export function isRationalMoney(value: unknown): value is RationalMoney {
  return value instanceof RationalMoney;
}
