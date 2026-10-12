/**
 * Exact money: a `Decimal` amount tied to an ISO 4217 currency, always held at
 * the currency's own number of minor-unit digits (2 for EUR, 0 for JPY, 3 for BHD).
 *
 * Rules that protect you from silent loss:
 * - Building a `Money` from a value with more precision than the currency
 *   throws `RoundingNecessaryError` unless you pass a `rounding` mode.
 * - Mixing currencies throws `CurrencyMismatchError`. There is no conversion here.
 * - `allocate` splits an amount so the parts add back to the whole, to the cent.
 * - Where rounding is chosen for you (`times`, `dividedBy`, `percentage`) the
 *   default is `'halfEven'` (banker's rounding), the usual choice for money.
 * - A `Money` never turns into a float by accident: `+money` throws.
 */

import { CurrencyMismatchError, InvalidArgumentError, NumberFormatError } from './errors.js';
import { Decimal } from './decimal.js';
import type { DecimalInput } from './decimal.js';
import type { CurrencyOptions as CurrencyFormatOptions } from './format.js';
import { formatCurrency } from './format.js';
import { pow10 } from './internal/bigint.js';
import type { RoundingMode } from './rounding.js';

export type MoneyInput = Money | DecimalInput;
export type MoneyOptions = {
  /** How to drop digits beyond the currency scale. `Money.from` throws when omitted; `times`/`dividedBy` default to `'halfEven'`. */
  rounding?: RoundingMode;
};

const BRAND = Symbol('Money');
const DEFAULT_ROUNDING: RoundingMode = 'halfEven';
const CODE = /^[A-Z]{3}$/;

const scaleCache = new Map<string, number>();
let knownCodes: Set<string> | null | undefined;

/**
 * Known ISO 4217 codes from `Intl.supportedValuesOf('currency')`, built once.
 * `null` when the runtime lacks that function; then `currencyScale` falls back
 * to the `Intl.NumberFormat` probe, which accepts any well-formed code.
 */
function getKnownCodes(): Set<string> | null {
  if (knownCodes !== undefined) return knownCodes;
  try {
    knownCodes = typeof Intl.supportedValuesOf === 'function' ? new Set(Intl.supportedValuesOf('currency')) : null;
  } catch {
    knownCodes = null;
  }
  return knownCodes;
}

function normalizeCurrency(currency: string): string {
  const code = typeof currency === 'string' ? currency.toUpperCase() : '';
  if (!CODE.test(code)) {
    throw new InvalidArgumentError(`Currency must be a 3-letter ISO 4217 code, got ${JSON.stringify(currency)}`);
  }
  return code;
}

/**
 * Number of minor-unit digits for a currency, from the runtime's `Intl` data:
 * `currencyScale('EUR')` → `2`, `'JPY'` → `0`, `'BHD'` → `3`.
 * Throws `InvalidArgumentError` for a code that is not 3 letters or is unknown to `Intl`.
 */
export function currencyScale(currency: string): number {
  const code = normalizeCurrency(currency);
  const cached = scaleCache.get(code);
  if (cached !== undefined) return cached;
  const known = getKnownCodes();
  if (known !== null && !known.has(code)) {
    throw new InvalidArgumentError(`Unknown currency code "${code}"`);
  }
  try {
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions()
      .maximumFractionDigits;
    const scale = digits ?? 2;
    scaleCache.set(code, scale);
    return scale;
  } catch (error) {
    throw new InvalidArgumentError(`Unknown currency code: ${code}`, { cause: error });
  }
}

function refuseCoercion(): never {
  throw new TypeError('Money cannot be coerced to a primitive; use toString(), toNumber() or toDecimal()');
}

/** An immutable amount of money in one currency. Create it with `money()` or `Money.from()`. */
export class Money {
  /** Always at the currency's scale. */
  readonly amount: Decimal;
  /** Upper-case ISO 4217 code. */
  readonly currency: string;

  private constructor(amount: Decimal, currency: string, brand: typeof BRAND) {
    if (brand !== BRAND) throw new TypeError('Use money(amount, currency) instead of new Money()');
    this.amount = amount;
    this.currency = currency;
    Object.freeze(this);
  }

  /**
   * Rounds `amount` to the currency scale using `options.rounding`. With no
   * `rounding`, extra precision throws `RoundingNecessaryError`:
   * `money('1.005', 'EUR')` throws, `money('1.005', 'EUR', { rounding: 'halfEven' })` → `1.00 EUR`.
   * A `Money` input must already be in the same currency.
   */
  static from(amount: MoneyInput, currency: string, options: MoneyOptions = {}): Money {
    const code = normalizeCurrency(currency);
    const scale = currencyScale(code);
    let value: Decimal;
    if (amount instanceof Money) {
      if (amount.currency !== code) {
        throw new CurrencyMismatchError(`Cannot treat ${amount.currency} as ${code}`);
      }
      value = amount.amount;
    } else {
      value = Decimal.from(amount);
    }
    return new Money(value.toScale(scale, options.rounding ?? 'unnecessary'), code, BRAND);
  }

  /** `fromMinorUnits(1999n, 'EUR')` → `19.99 EUR`. A `number` must be a safe integer. */
  static fromMinorUnits(minor: bigint | number, currency: string): Money {
    if (typeof minor !== 'bigint' && typeof minor !== 'number') {
      throw new TypeError('Minor units must be a bigint or a safe integer number');
    }
    if (typeof minor === 'number' && !Number.isSafeInteger(minor)) {
      throw new InvalidArgumentError(`Minor units must be a safe integer, got ${minor}`);
    }
    const code = normalizeCurrency(currency);
    const scale = currencyScale(code);
    const amount = Decimal.from(BigInt(minor)).dividedBy(pow10(scale), { scale });
    return new Money(amount, code, BRAND);
  }

  /**
   * Adds up values of one currency. An empty list needs `currency` (the result
   * is zero); otherwise it throws `InvalidArgumentError`.
   */
  static sum(values: Iterable<Money>, currency?: string): Money {
    let code = currency === undefined ? undefined : normalizeCurrency(currency);
    const amounts: Decimal[] = [];
    for (const value of values) {
      if (!isMoney(value)) throw new TypeError('Money.sum expects Money values');
      if (code === undefined) code = value.currency;
      else if (value.currency !== code) {
        throw new CurrencyMismatchError(`Cannot combine ${code} with ${value.currency}`);
      }
      amounts.push(value.amount);
    }
    if (code === undefined) {
      throw new InvalidArgumentError('Money.sum of an empty list needs a currency');
    }
    return new Money(Decimal.sum(amounts).toScale(currencyScale(code), 'unnecessary'), code, BRAND);
  }

  /** Comparator for sorting: `prices.sort(Money.compare)`. Throws on mixed currencies. */
  static compare(a: Money, b: Money): -1 | 0 | 1 {
    return a.compareTo(b);
  }

  /** Reads `'19.99 EUR'` or `'EUR 19.99'`. Extra precision throws `RoundingNecessaryError`. */
  static parse(text: string): Money {
    const trimmed = typeof text === 'string' ? text.trim() : '';
    const amountFirst = /^([+-]?\d+(?:\.\d+)?)\s+([A-Z]{3})$/i.exec(trimmed);
    const codeFirst = /^([A-Z]{3})\s+([+-]?\d+(?:\.\d+)?)$/i.exec(trimmed);
    const amount = amountFirst?.[1] ?? codeFirst?.[2];
    const code = amountFirst?.[2] ?? codeFirst?.[1];
    if (amount === undefined || code === undefined) {
      throw new NumberFormatError(`Cannot parse ${JSON.stringify(text)} as money; expected '19.99 EUR'`);
    }
    return Money.from(amount, code);
  }

  static fromJSON(value: { amount: string; currency: string }): Money {
    if (
      typeof value !== 'object' ||
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- untrusted JSON can be null
      value === null ||
      typeof value.amount !== 'string' ||
      typeof value.currency !== 'string'
    ) {
      throw new InvalidArgumentError('Expected { amount: string, currency: string }');
    }
    return Money.from(value.amount, value.currency);
  }

  // Arithmetic -------------------------------------------------------------

  plus(other: Money): Money {
    this.assertSame(other);
    return new Money(this.amount.plus(other.amount), this.currency, BRAND);
  }

  minus(other: Money): Money {
    this.assertSame(other);
    return new Money(this.amount.minus(other.amount), this.currency, BRAND);
  }

  /** Exact product, then rounded to the currency scale (default `'halfEven'`). */
  times(factor: DecimalInput, options: MoneyOptions = {}): Money {
    return this.withAmount(this.amount.times(factor), options);
  }

  /** Divides and rounds to the currency scale (default `'halfEven'`). Zero throws `DivisionByZeroError`. */
  dividedBy(divisor: DecimalInput, options: MoneyOptions = {}): Money {
    const amount = this.amount.dividedBy(divisor, {
      scale: this.amount.scale,
      rounding: options.rounding ?? DEFAULT_ROUNDING,
    });
    return new Money(amount, this.currency, BRAND);
  }

  /**
   * Splits into `ratios.length` parts that add up to this amount exactly.
   * Each part first gets `floor(amount × ratio ÷ total)` minor units. The
   * minor units left over go one each to the parts with the largest
   * remainder; equal remainders favor the earlier part.
   * `money(100, 'EUR').allocate([1, 1, 1])` → `[33.34, 33.33, 33.33]`.
   * Ratios must be finite and non-negative, and not all zero. Fractions such
   * as `0.5` are fine. A negative amount is split as a positive one and
   * re-signed, so the earlier parts take the extra unit there too.
   */
  allocate(ratios: readonly number[] | readonly bigint[]): Money[] {
    if (ratios.length === 0) throw new InvalidArgumentError('allocate needs at least one ratio');
    const weights: Decimal[] = [];
    let commonScale = 0;
    for (const ratio of ratios) {
      const weight = Decimal.from(ratio);
      if (weight.isNegative()) throw new InvalidArgumentError(`Ratios must be non-negative, got ${weight.toString()}`);
      commonScale = Math.max(commonScale, weight.scale);
      weights.push(weight);
    }
    const parts = weights.map((w) => w.toScale(commonScale).coefficient);
    const total = parts.reduce((a, b) => a + b, 0n);
    if (total === 0n) throw new InvalidArgumentError('Ratios must not all be zero');

    const minor = this.amount.coefficient;
    const magnitude = minor < 0n ? -minor : minor;
    const shares = parts.map((p) => (magnitude * p) / total);
    const remainders = parts.map((p, i) => ({ index: i, rest: (magnitude * p) % total }));
    let left = magnitude - shares.reduce((a, b) => a + b, 0n);
    remainders.sort((a, b) => (a.rest === b.rest ? a.index - b.index : a.rest < b.rest ? 1 : -1));
    for (const { index } of remainders) {
      if (left === 0n) break;
      shares[index] = (shares[index] ?? 0n) + 1n;
      left -= 1n;
    }
    const direction = minor < 0n ? -1n : 1n;
    return shares.map((share) => Money.fromMinorUnits(share * direction, this.currency));
  }

  /** `money(200, 'EUR').percentage(15)` → `30.00 EUR`. Same as `times(percent / 100)`. */
  percentage(percent: DecimalInput, options: MoneyOptions = {}): Money {
    return this.times(Decimal.from(percent).dividedBy(100), options);
  }

  negated(): Money {
    return new Money(this.amount.negated(), this.currency, BRAND);
  }

  abs(): Money {
    return new Money(this.amount.abs(), this.currency, BRAND);
  }

  // Comparison -------------------------------------------------------------

  compareTo(other: Money): -1 | 0 | 1 {
    this.assertSame(other);
    return this.amount.compareTo(other.amount);
  }

  eq(other: Money): boolean {
    return this.compareTo(other) === 0;
  }

  lt(other: Money): boolean {
    return this.compareTo(other) < 0;
  }

  lte(other: Money): boolean {
    return this.compareTo(other) <= 0;
  }

  gt(other: Money): boolean {
    return this.compareTo(other) > 0;
  }

  gte(other: Money): boolean {
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

  hasSameCurrency(other: Money): boolean {
    return this.currency === other.currency;
  }

  // Conversion -------------------------------------------------------------

  toDecimal(): Decimal {
    return this.amount;
  }

  /** `19.99 EUR` → `1999n`. */
  toMinorUnits(): bigint {
    return this.amount.coefficient;
  }

  /** The nearest double. Fine for display math, not for further money math. */
  toNumber(): number {
    return this.amount.toNumber();
  }

  /** Locale-free and round-trippable through `Money.parse`: `'19.99 EUR'`. */
  toString(): string {
    return `${this.amount.toString()} ${this.currency}`;
  }

  /** Localized text via `formatCurrency`: `'$19.99'` by default, `'19,99 €'` with `{ locale: 'de-DE' }`. */
  format(options?: CurrencyFormatOptions): string {
    return formatCurrency(this.amount, this.currency, options);
  }

  toJSON(): { amount: string; currency: string } {
    return { amount: this.amount.toString(), currency: this.currency };
  }

  /** Throws. A `Money` never silently becomes a float. */
  valueOf(): never {
    return refuseCoercion();
  }

  [Symbol.toPrimitive](hint: 'string' | 'number' | 'default'): string {
    return hint === 'string' ? this.toString() : refuseCoercion();
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `Money(${this.toString()})`;
  }

  [Symbol.for('Deno.customInspect')](): string {
    return `Money(${this.toString()})`;
  }

  readonly [Symbol.toStringTag] = 'Money';

  private withAmount(amount: Decimal, options: MoneyOptions): Money {
    const scaled = amount.toScale(this.amount.scale, options.rounding ?? DEFAULT_ROUNDING);
    return new Money(scaled, this.currency, BRAND);
  }

  private assertSame(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`Cannot combine ${this.currency} with ${other.currency}`);
    }
  }
}

/** Shorthand for `Money.from`. */
export function money(amount: MoneyInput, currency: string, options?: MoneyOptions): Money {
  return Money.from(amount, currency, options);
}

export function isMoney(value: unknown): value is Money {
  return value instanceof Money;
}
