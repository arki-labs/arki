/**
 * A wallet of several currencies: `10 EUR + 5 USD` stays two balances. It never
 * pretends mixed amounts have one total until you convert it, and then it
 * converts each balance exactly and rounds once.
 *
 * ```ts
 * const cart = MoneyBag.of(money(10, 'EUR'), money(5, 'USD')).plus(money('2.50', 'EUR'));
 * cart.get('EUR').toString();                                   // '25/2 EUR'
 * cart.convert(fx, 'EUR', { rounding: 'halfEven' });            // one EUR total
 * ```
 */

import { ratio } from '@arki/math/rational';

import type { Currency, CurrencyLike } from './currency.js';
import type { Converter } from './exchange.js';
import type { MoneyJSON, MoneyOptions } from './money.js';
import type { ExactMoney } from './rational.js';
import { assertSameCurrency, toCurrency } from './currency.js';
import { Money } from './money.js';
import { RationalMoney } from './rational.js';

const BRAND = Symbol('MoneyBag');

function exact(value: ExactMoney): RationalMoney {
  return value instanceof RationalMoney ? value : RationalMoney.from(value);
}

/** An immutable set of balances, at most one per currency. Zero balances are dropped. */
export class MoneyBag {
  private readonly balances: ReadonlyMap<string, RationalMoney>;

  private constructor(balances: ReadonlyMap<string, RationalMoney>, brand: typeof BRAND) {
    if (brand !== BRAND) throw new TypeError('Use MoneyBag.of() instead of new MoneyBag()');
    this.balances = balances;
  }

  static empty(): MoneyBag {
    return new MoneyBag(new Map(), BRAND);
  }

  /** `MoneyBag.of(money(10, 'EUR'), money(5, 'USD'))`. */
  static of(...items: (ExactMoney | MoneyBag)[]): MoneyBag {
    return MoneyBag.empty().plus(...items);
  }

  /** Adds amounts or whole bags. Returns a new bag. */
  plus(...items: (ExactMoney | MoneyBag)[]): MoneyBag {
    return this.combine(items, false);
  }

  /** Subtracts amounts or whole bags. Balances may go negative. Returns a new bag. */
  minus(...items: (ExactMoney | MoneyBag)[]): MoneyBag {
    return this.combine(items, true);
  }

  /** The exact balance in one currency; zero when the bag holds none. */
  get<const C extends string>(currency: CurrencyLike<C>): RationalMoney<C> {
    const target = toCurrency(currency);
    const found = this.balances.get(target.code);
    if (found === undefined) return RationalMoney.zero(target);
    assertSameCurrency(found.currency, target);
    return RationalMoney.create(found.amount, target);
  }

  /** The currencies with a non-zero balance, sorted by code. */
  currencies(): Currency[] {
    return this.entries().map(entry => entry.currency);
  }

  /** The non-zero balances, sorted by currency code. */
  entries(): RationalMoney[] {
    return [...this.balances.values()].sort((a, b) => (a.currency.code < b.currency.code ? -1 : 1));
  }

  /** `true` when every balance is zero. */
  isZero(): boolean {
    return this.balances.size === 0;
  }

  /**
   * One total in `currency`: each balance is converted exactly, the results are
   * added, and the sum is rounded once. Missing rates throw `ExchangeRateError`.
   */
  convert<const C extends string>(converter: Converter, currency: CurrencyLike<C>, options?: MoneyOptions): Money<C> {
    const target = toCurrency(currency);
    let total = ratio(0);
    for (const balance of this.balances.values()) {
      const rate = converter.rate(balance.currency, target);
      total = total.plus(balance.amount.times(ratio(BigInt(rate.numerator), BigInt(rate.denominator))));
    }
    return Money.of(total, target, options);
  }

  /** `[{ amount: '25/2', currency: 'EUR' }, ...]`, sorted by currency code. */
  toJSON(): MoneyJSON[] {
    return this.entries().map(entry => entry.toJSON());
  }

  /** `'12.5 EUR + 5 USD'`-style text with exact fractions: `'25/2 EUR + 5 USD'`. Empty bag: `'0'`. */
  toString(): string {
    const entries = this.entries();
    return entries.length === 0 ? '0' : entries.map(String).join(' + ');
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `MoneyBag(${this.toString()})`;
  }

  [Symbol.for('Deno.customInspect')](): string {
    return `MoneyBag(${this.toString()})`;
  }

  private combine(items: readonly (ExactMoney | MoneyBag)[], subtract: boolean): MoneyBag {
    const next = new Map(this.balances);
    const add = (value: RationalMoney): void => {
      const code = value.currency.code;
      const current = next.get(code);
      const delta = subtract ? value.negated() : value;
      next.set(code, current === undefined ? delta : current.plus(delta));
    };
    for (const item of items) {
      if (item instanceof MoneyBag) for (const balance of item.balances.values()) add(balance);
      else add(exact(item));
    }
    return new MoneyBag(new Map([...next].filter(([, balance]) => !balance.isZero())), BRAND);
  }
}
