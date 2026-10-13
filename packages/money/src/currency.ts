/**
 * Currencies. The ISO 4217 list ships with the package, so a currency's number
 * of decimals is the same on every runtime and device. `Intl` is only used for
 * display (see `@arki/money/format`); it accepts made-up codes such as `ZZZ`
 * and its decimals can differ from ISO, so it never decides arithmetic.
 *
 * `Currency.of('EUR')` returns the same object every time, so comparing two
 * currencies is a pointer check on the hot path.
 */

import { InvalidArgumentError } from '@arki/math/errors';

import { ISO_4217 } from './data/iso4217.js';
import { CurrencyMismatchError, UnknownCurrencyError } from './errors.js';
import { MAX_SCALE } from './internal/units.js';

export { ISO_4217_VERSION } from './data/iso4217.js';

const BRAND = Symbol('Currency');
const CUSTOM_CODE = /^[a-z][\w.:-]{0,31}$/i;

let byCode: Map<string, Currency> | undefined;
let byNumeric: Map<string, Currency> | undefined;

/** A currency, or the code of an ISO 4217 currency. */
export type CurrencyLike<C extends string = string> = C | Currency<C>;

/** What `Currency.custom` needs. */
export type CurrencyDefinition<C extends string = string> = {
  /** Letters, digits and `. _ : -`, up to 32 characters, not an ISO 4217 code: `'BTC'`, `'crypto:ETH'`, `'points'`. */
  code: C;
  /** Number of decimals, 0–100: 8 for BTC, 18 for ETH, 0 for loyalty points. */
  scale: number;
  /** Optional three-digit numeric code. */
  numeric?: string;
};

/** An immutable currency: its code, its ISO numeric code and its number of decimals. */
export class Currency<C extends string = string> {
  /** `'EUR'`. */
  readonly code: C;
  /** Three-digit ISO numeric code as a string, so `'008'` keeps its zeros. `undefined` for most custom currencies. */
  readonly numeric: string | undefined;
  /** Number of decimals: 2 for EUR, 0 for JPY, 3 for KWD. ISO codes without minor units (XAU, XTS) use 0. */
  readonly scale: number;
  /** `true` for a currency from the shipped ISO 4217 table. */
  readonly iso: boolean;

  private constructor(code: C, numeric: string | undefined, scale: number, iso: boolean, brand: typeof BRAND) {
    if (brand !== BRAND) throw new TypeError('Use Currency.of(code) or Currency.custom(definition)');
    this.code = code;
    this.numeric = numeric;
    this.scale = scale;
    this.iso = iso;
    Object.freeze(this);
  }

  /**
   * The ISO 4217 currency with this upper-case code: `Currency.of('EUR')`.
   * Throws `UnknownCurrencyError` for anything not in the table, including `'eur'`.
   */
  static of<const C extends string>(code: C): Currency<C> {
    const found = Currency.table().get(code);
    if (found === undefined || !hasCode(found, code)) throw new UnknownCurrencyError(String(code));
    return found;
  }

  /** The ISO 4217 currency with this numeric code: `Currency.fromNumeric('978')` or `(978)` → EUR. */
  static fromNumeric(numeric: string | number): Currency {
    const key = typeof numeric === 'number' ? String(numeric).padStart(3, '0') : numeric;
    if (byNumeric === undefined) {
      byNumeric = new Map();
      for (const currency of Currency.table().values()) {
        if (currency.numeric !== undefined) byNumeric.set(currency.numeric, currency);
      }
    }
    const found = byNumeric.get(key);
    if (found === undefined) throw new UnknownCurrencyError(key);
    return found;
  }

  /**
   * A currency that is not in ISO 4217: crypto, loyalty points, a withdrawn
   * currency you still hold data in. It is not registered anywhere; keep the
   * object and pass it where you would pass a code. Two custom currencies with
   * the same code and scale are treated as the same currency.
   */
  static custom<const C extends string>(definition: CurrencyDefinition<C>): Currency<C> {
    const { code, scale, numeric } = definition;
    if (typeof code !== 'string' || !CUSTOM_CODE.test(code)) {
      throw new InvalidArgumentError(
        `A currency code is 1–32 letters, digits or ". _ : -", starting with a letter; got ${JSON.stringify(code)}`,
      );
    }
    if (Currency.table().has(code)) {
      throw new InvalidArgumentError(`${code} is an ISO 4217 currency; use Currency.of('${code}')`);
    }
    if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) {
      throw new InvalidArgumentError(`A currency scale is a whole number from 0 to ${MAX_SCALE}, got ${scale}`);
    }
    if (numeric !== undefined && !/^\d{3}$/.test(numeric)) {
      throw new InvalidArgumentError(`A numeric currency code has three digits, got ${JSON.stringify(numeric)}`);
    }
    return new Currency(code, numeric, scale, false, BRAND);
  }

  /** `true` when `code` is in the shipped ISO 4217 table. */
  static isKnown(code: string): boolean {
    return Currency.table().has(code);
  }

  /** Every ISO 4217 code in the shipped table, sorted. */
  static codes(): string[] {
    return [...Currency.table().keys()];
  }

  /** Same code and same scale. */
  eq(other: Currency): boolean {
    return this === other || (this.code === other.code && this.scale === other.scale);
  }

  toString(): C {
    return this.code;
  }

  toJSON(): C {
    return this.code;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `Currency(${this.code})`;
  }

  [Symbol.for('Deno.customInspect')](): string {
    return `Currency(${this.code})`;
  }

  /** Decodes the packed table on first use. */
  private static table(): Map<string, Currency> {
    if (byCode !== undefined) return byCode;
    const table = new Map<string, Currency>();
    for (let i = 0; i < ISO_4217.length; i += 7) {
      const code = ISO_4217.slice(i, i + 3);
      const digit = ISO_4217.charAt(i + 6);
      table.set(code, new Currency(code, ISO_4217.slice(i + 3, i + 6), digit === '-' ? 0 : Number(digit), true, BRAND));
    }
    byCode = table;
    return table;
  }
}

function hasCode<C extends string>(currency: Currency, code: C): currency is Currency<C> {
  return currency.code === code;
}

/** Accepts a `Currency` or an ISO code. */
export function toCurrency<C extends string>(currency: CurrencyLike<C>): Currency<C> {
  if (currency instanceof Currency) return currency;
  if (typeof currency !== 'string') throw new TypeError('Expected a currency code or a Currency');
  return Currency.of(currency);
}

/** Finds a currency by code among `custom`, then in the ISO table. */
export function resolveCurrency(code: string, custom: readonly Currency[] | undefined): Currency {
  if (custom !== undefined) {
    for (const currency of custom) if (currency.code === code) return currency;
  }
  return Currency.of(code);
}

/** Throws `CurrencyMismatchError` unless the two are the same currency. */
export function assertSameCurrency(a: Currency, b: Currency): void {
  if (a !== b && (a.code !== b.code || a.scale !== b.scale)) throw new CurrencyMismatchError(a.code, b.code);
}
