import { describe, expect, expectTypeOf, it } from 'vitest';

import type { RoundingMode } from '@arki/math/rounding';
import { decimal } from '@arki/math/decimal';
import { ratio } from '@arki/math/rational';
import { ROUNDING_MODES } from '@arki/math/rounding';

import { toDecimal, toRational } from './exact.js';
import {
  average,
  Currency,
  CurrencyMismatchError,
  DivisionByZeroError,
  EmptyDataError,
  factor,
  InvalidArgumentError,
  isMoney,
  MathError,
  max,
  min,
  Money,
  money,
  NumberFormatError,
  NumericRangeError,
  ResourceLimitError,
  RoundingNecessaryError,
  sum,
  UnknownCurrencyError,
} from './index.js';

const SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Deterministic generator so failures reproduce. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 1_831_565_813) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Random bigints clustered around the 2^53 boundary, where the number and bigint paths meet. */
function boundaryInts(seed: number, count: number): bigint[] {
  const next = rng(seed);
  const values: bigint[] = [];
  for (let i = 0; i < count; i++) {
    const pick = next();
    const offset = BigInt(Math.floor(next() * 2000)) - 1000n;
    const base = pick < 0.3 ? SAFE : pick < 0.6 ? SAFE / 2n : pick < 0.8 ? 2n ** 70n : BigInt(Math.floor(next() * 1e6));
    values.push((next() < 0.5 ? -1n : 1n) * (base + offset));
  }
  return values;
}

/** Reference rounding of n/d (d > 0) in pure bigint, written independently of the library. */
function oracleDivide(n: bigint, d: bigint, mode: RoundingMode): bigint {
  const q = n / d;
  const r = n % d;
  if (r === 0n) return q;
  const neg = n < 0n;
  const away = neg ? q - 1n : q + 1n;
  const twice = (r < 0n ? -r : r) * 2n;
  switch (mode) {
    case 'down': {
      return q;
    }
    case 'up': {
      return away;
    }
    case 'ceiling': {
      return neg ? q : away;
    }
    case 'floor': {
      return neg ? away : q;
    }
    case 'halfUp': {
      return twice >= d ? away : q;
    }
    case 'halfDown': {
      return twice > d ? away : q;
    }
    case 'halfEven': {
      return twice > d || (twice === d && q % 2n !== 0n) ? away : q;
    }
    case 'unnecessary': {
      throw new RoundingNecessaryError('inexact');
    }
  }
}

describe('construction', () => {
  it('reads strings, numbers as written, bigints, Decimals and Rationals', () => {
    expect(money('19.99', 'EUR').toString()).toBe('19.99 EUR');
    expect(money(19.99, 'EUR').toString()).toBe('19.99 EUR');
    expect(money(20n, 'EUR').toString()).toBe('20.00 EUR');
    expect(money(decimal('1.5'), 'EUR').toString()).toBe('1.50 EUR');
    expect(money(ratio(1, 4), 'EUR').toString()).toBe('0.25 EUR');
    expect(money('1e3', 'JPY').toString()).toBe('1000 JPY');
  });

  it('throws instead of silently dropping digits', () => {
    expect(() => money('1.005', 'EUR')).toThrow(RoundingNecessaryError);
    expect(() => money(ratio(1, 3), 'EUR')).toThrow(RoundingNecessaryError);
    expect(money('1.005', 'EUR', { rounding: 'halfEven' }).toString()).toBe('1.00 EUR');
    expect(money('1.005', 'EUR', { rounding: 'halfUp' }).toString()).toBe('1.01 EUR');
    expect(() => money(0.1 + 0.2, 'EUR')).toThrow(RoundingNecessaryError);
  });

  it('uses each currency’s ISO decimals, not Intl’s', () => {
    expect(money(1, 'JPY').scale).toBe(0);
    expect(money(1, 'KWD').toString()).toBe('1.000 KWD');
    expect(money(1, 'CLF').scale).toBe(4);
    expect(money(1, 'ISK').scale).toBe(0);
    expect(money(1, 'XAU').scale).toBe(0);
  });

  it('keeps a chosen scale for unit prices', () => {
    expect(money('0.1234', 'EUR', { scale: 4 }).toString()).toBe('0.1234 EUR');
  });

  it('rejects bad input with typed errors', () => {
    expect(() => money('1,5', 'EUR')).toThrow(NumberFormatError);
    expect(() => money(' 1', 'EUR')).toThrow(NumberFormatError);
    expect(() => money(Number.NaN, 'EUR')).toThrow(NumericRangeError);
    expect(() => money(2 ** 60, 'EUR')).toThrow(NumericRangeError);
    expect(() => money('1'.repeat(2000), 'EUR')).toThrow(ResourceLimitError);
    expect(() => money(1, 'EUR', { scale: 101 })).toThrow(InvalidArgumentError);
    // @ts-expect-error -- plain JavaScript may pass anything
    expect(() => money(null, 'EUR')).toThrow(TypeError);
  });

  it('builds from minor units, including database strings', () => {
    expect(Money.fromMinor(1999, 'EUR').toString()).toBe('19.99 EUR');
    expect(Money.fromMinor('-500', 'JPY').toString()).toBe('-500 JPY');
    expect(Money.fromMinor(123_456_789_012_345_678_901n, 'USD').toString()).toBe('1234567890123456789.01 USD');
    expect(() => Money.fromMinor(1.5, 'EUR')).toThrow(NumericRangeError);
    expect(() => Money.fromMinor('1.5', 'EUR')).toThrow(NumberFormatError);
  });

  it('cannot be constructed directly', () => {
    const Ctor: new (...args: unknown[]) => unknown = Object.getPrototypeOf(money(1, 'EUR')).constructor;
    expect(() => new Ctor(1, 2, Currency.of('EUR'))).toThrow(TypeError);
  });
});

describe('currencies', () => {
  it('ships the ISO table with numeric codes', () => {
    expect(Currency.of('EUR').numeric).toBe('978');
    expect(Currency.fromNumeric(8).code).toBe('ALL');
    expect(Currency.fromNumeric('978')).toBe(Currency.of('EUR'));
    expect(Currency.codes()).toHaveLength(178);
    expect(Currency.isKnown('BGN')).toBe(false); // Bulgaria adopted the euro on 2026-01-01.
  });

  it('rejects codes ISO does not know, which Intl would accept', () => {
    expect(() => Currency.of('ZZZ')).toThrow(UnknownCurrencyError);
    const lower = String('eur');
    expect(() => money(1, lower)).toThrow(UnknownCurrencyError);
  });

  it('supports custom currencies without a global registry', () => {
    const btc = Currency.custom({ code: 'BTC', scale: 8 });
    expect(money('0.00012', btc).toString()).toBe('0.00012000 BTC');
    expect(() => Currency.custom({ code: 'EUR', scale: 4 })).toThrow(InvalidArgumentError);
    const eth = Currency.custom({ code: 'ETH', scale: 18 });
    expect(money('1.000000000000000001', eth).units).toBe(1_000_000_000_000_000_001n);
  });

  it('treats equal custom definitions as one currency and conflicting ones as a mismatch', () => {
    const a = Currency.custom({ code: 'PTS', scale: 0 });
    const b = Currency.custom({ code: 'PTS', scale: 0 });
    const c = Currency.custom({ code: 'PTS', scale: 2 });
    expect(money(1, a).plus(money(2, b)).toString()).toBe('3 PTS');
    expect(() => money(1, a).plus(money(2, c))).toThrow(CurrencyMismatchError);
  });
});

const eur = (amount: string) => money(amount, 'EUR');

describe('arithmetic', () => {
  it('adds and subtracts exactly, aligning scales upward', () => {
    expect(eur('0.10').plus(eur('0.20')).toString()).toBe('0.30 EUR');
    expect(eur('5').minus(eur('7.25')).toString()).toBe('-2.25 EUR');
    expect(
      eur('1')
        .plus(money('0.0001', 'EUR', { scale: 4 }))
        .toString(),
    ).toBe('1.0001 EUR');
  });

  it('refuses to mix currencies, at compile time and at run time', () => {
    const usd = money(1, 'USD');
    // @ts-expect-error -- Money<'EUR'> and Money<'USD'> do not mix
    expect(() => eur('1').plus(usd)).toThrow(CurrencyMismatchError);
    const dynamic: Money = usd;
    expect(() => dynamic.compareTo(money(1, 'EUR'))).toThrow(CurrencyMismatchError);
  });

  it('multiplies and divides exact-or-throw', () => {
    expect(eur('9.99').times(3).toString()).toBe('29.97 EUR');
    expect(eur('10').times('1.5').toString()).toBe('15.00 EUR');
    expect(() => eur('9.99').times('1.19')).toThrow(RoundingNecessaryError);
    expect(eur('9.99').times('1.19', 'halfEven').toString()).toBe('11.89 EUR');
    expect(eur('10').dividedBy(4).toString()).toBe('2.50 EUR');
    expect(eur('10').dividedBy(3, 'down').toString()).toBe('3.33 EUR');
    expect(eur('10').dividedBy(-4).toString()).toBe('-2.50 EUR');
    expect(() => eur('10').dividedBy(0)).toThrow(DivisionByZeroError);
    expect(eur('200').percentage(15).toString()).toBe('30.00 EUR');
    expect(eur('100').times(ratio(1, 3), 'halfEven').toString()).toBe('33.33 EUR');
  });

  it('reuses a prepared factor', () => {
    const vat = factor('0.19');
    expect(eur('100').times(vat).toString()).toBe('19.00 EUR');
    expect(eur('9.99').times(vat, 'halfUp').toString()).toBe('1.90 EUR');
  });

  it('rounds to a cash step once, without double rounding', () => {
    expect(money('1.025', 'CHF', { scale: 3 }).roundToStep('0.05', 'halfUp').toString()).toBe('1.050 CHF');
    expect(money('7.47', 'SEK').roundToStep(1, 'halfEven').toString()).toBe('7.00 SEK');
    expect(money('1.024', 'CHF', { scale: 3 }).toScale(2, 'halfUp').roundToStep('0.05', 'halfUp').toString()).toBe(
      '1.00 CHF',
    );
    expect(() => eur('1').roundToStep('0.001', 'halfUp')).toThrow(InvalidArgumentError);
    expect(() => eur('1.02').roundToStep('0.05')).toThrow(RoundingNecessaryError);
  });

  it('changes scale explicitly', () => {
    expect(money('1.2345', 'EUR', { scale: 4 }).toScale(2, 'halfEven').toString()).toBe('1.23 EUR');
    expect(() => money('1.2345', 'EUR', { scale: 4 }).toScale(2)).toThrow(RoundingNecessaryError);
    expect(eur('1.5').toScale(4).toString()).toBe('1.5000 EUR');
  });

  it('matches a pure bigint reference across the 2^53 boundary for every rounding mode', () => {
    const eurCurrency = Currency.of('EUR');
    const values = boundaryInts(1, 400);
    const factors = ['1.0825', '-0.5', '3', '0.333', '1e-1', '-7.25'];
    for (let i = 0; i < values.length; i++) {
      const a = values[i] ?? 0n;
      const b = values[(i * 7 + 3) % values.length] ?? 0n;
      const x = Money.fromMinor(a, eurCurrency);
      const y = Money.fromMinor(b, eurCurrency);
      expect(x.plus(y).units).toEqual(canonical(a + b));
      expect(x.minus(y).units).toEqual(canonical(a - b));
      expect(x.compareTo(y)).toBe(a < b ? -1 : a > b ? 1 : 0);
      for (const text of factors) {
        const d = decimal(text);
        const n = a * d.coefficient;
        const den = 10n ** BigInt(d.scale);
        for (const mode of ROUNDING_MODES) {
          let expected: bigint | undefined;
          try {
            expected = oracleDivide(n, den, mode);
          } catch {
            expected = undefined;
          }
          if (expected === undefined) expect(() => x.times(text, mode)).toThrow(RoundingNecessaryError);
          else expect(x.times(text, mode).units).toEqual(canonical(expected));
        }
      }
    }
  });

  it('keeps units in canonical form: a number exactly when it is a safe integer', () => {
    const eurCurrency = Currency.of('EUR');
    for (const value of boundaryInts(2, 300)) {
      const result = Money.fromMinor(value, eurCurrency).plus(Money.fromMinor(1n, eurCurrency));
      const exact = value + 1n;
      const safe = exact >= -SAFE && exact <= SAFE;
      expect(typeof result.units).toBe(safe ? 'number' : 'bigint');
      expect(Object.is(result.units, -0)).toBe(false);
    }
    expect(Object.is(money('-0', 'EUR').units, 0)).toBe(true);
    expect(Object.is(money(0, 'EUR').times(-3).units, 0)).toBe(true);
  });

  it('round-trips plus and minus', () => {
    const eurCurrency = Currency.of('EUR');
    const values = boundaryInts(3, 200);
    for (let i = 0; i + 1 < values.length; i += 2) {
      const a = Money.fromMinor(values[i] ?? 0n, eurCurrency);
      const b = Money.fromMinor(values[i + 1] ?? 0n, eurCurrency);
      expect(a.plus(b).minus(b).eq(a)).toBe(true);
    }
  });
});

function canonical(value: bigint): number | bigint {
  return value >= -SAFE && value <= SAFE ? Number(value) : value;
}

describe('allocation', () => {
  it('splits by ratios so the parts add back to the whole', () => {
    const parts = money(100, 'EUR').allocate([1, 1, 1]);
    expect(parts.map(String)).toEqual(['33.34 EUR', '33.33 EUR', '33.33 EUR']);
    expect(money('0.05', 'EUR').allocate([3, 7]).map(String)).toEqual(['0.02 EUR', '0.03 EUR']);
    expect(money(100, 'EUR').allocate(['0.5', '0.25', '0.25']).map(String)).toEqual([
      '50.00 EUR',
      '25.00 EUR',
      '25.00 EUR',
    ]);
  });

  it('follows the remainder policy and never pays a zero ratio', () => {
    const whole = money('0.02', 'EUR');
    expect(whole.allocate([1, 1, 1], { remainder: 'last' }).map(String)).toEqual(['0.00 EUR', '0.01 EUR', '0.01 EUR']);
    expect(whole.allocate([1, 1, 1], { remainder: 'first' }).map(String)).toEqual(['0.01 EUR', '0.01 EUR', '0.00 EUR']);
    expect(money('0.03', 'EUR').allocate([0, 1, 1]).map(String)).toEqual(['0.00 EUR', '0.02 EUR', '0.01 EUR']);
  });

  it('splits negative amounts symmetrically', () => {
    const positive = money(10, 'EUR')
      .split(3)
      .map(part => part.toString());
    const negative = money(-10, 'EUR')
      .split(3)
      .map(part => part.negated().toString());
    expect(negative).toEqual(positive);
  });

  it('conserves the total and stays within one unit of the exact share', () => {
    const next = rng(4);
    const eurCurrency = Currency.of('EUR');
    for (let round = 0; round < 300; round++) {
      const whole = Money.fromMinor(BigInt(Math.floor(next() * 2e9)) - 1_000_000_000n, eurCurrency);
      const ratios = Array.from({ length: 1 + Math.floor(next() * 6) }, () => Math.floor(next() * 50));
      if (!ratios.some(r => r > 0)) ratios[0] = 1;
      const parts = whole.allocate(ratios);
      expect(sum(parts).eq(whole)).toBe(true);
      const total = ratios.reduce((a, b) => a + b, 0);
      for (const [i, part] of parts.entries()) {
        const exact = (Number(whole.units) * (ratios[i] ?? 0)) / total;
        expect(Math.abs(Number(part.units) - exact)).toBeLessThan(1 + 1e-6);
        if (ratios[i] === 0) expect(part.isZero()).toBe(true);
      }
    }
  });

  it('splits big amounts on the bigint path', () => {
    const whole = Money.fromMinor(2n ** 80n + 1n, 'USD');
    const parts = whole.split(3);
    expect(sum(parts).eq(whole)).toBe(true);
  });

  it('rejects bad ratios', () => {
    const whole = money(1, 'EUR');
    expect(() => whole.allocate([])).toThrow(InvalidArgumentError);
    expect(() => whole.allocate([0, 0])).toThrow(InvalidArgumentError);
    expect(() => whole.allocate([1, -1])).toThrow(InvalidArgumentError);
    expect(() => whole.split(0)).toThrow(InvalidArgumentError);
    expect(() => whole.split(10_001)).toThrow(ResourceLimitError);
  });
});

describe('comparison and aggregates', () => {
  it('compares across scales', () => {
    expect(money('1.5', 'EUR').eq(money('1.5000', 'EUR', { scale: 4 }))).toBe(true);
    expect(money(1, 'EUR').lt(money(2, 'EUR'))).toBe(true);
    expect([money(3, 'EUR'), money(1, 'EUR'), money(2, 'EUR')].toSorted(Money.compare).map(String)).toEqual([
      '1.00 EUR',
      '2.00 EUR',
      '3.00 EUR',
    ]);
    expect(money(-1, 'EUR').sign()).toBe(-1);
    expect(money(1, 'EUR').hasSameCurrency(money(1, 'USD'))).toBe(false);
  });

  it('sums, averages and picks extremes', () => {
    const prices: [Money<'EUR'>, Money<'EUR'>, Money<'EUR'>] = [
      money('1.10', 'EUR'),
      money('2.20', 'EUR'),
      money('3.31', 'EUR'),
    ];
    expect(sum(prices).toString()).toBe('6.61 EUR');
    expect(sum([], 'EUR').toString()).toBe('0.00 EUR');
    expect(() => sum([])).toThrow(InvalidArgumentError);
    expect(() => average(prices)).toThrow(RoundingNecessaryError);
    expect(average(prices, 'halfEven').toString()).toBe('2.20 EUR');
    expect(() => average([])).toThrow(EmptyDataError);
    expect(min(...prices).toString()).toBe('1.10 EUR');
    expect(max(...prices).toString()).toBe('3.31 EUR');
  });
});

describe('output and serialization', () => {
  it('writes fixed decimals and minor units', () => {
    expect(money('-0.5', 'EUR').toDecimalString()).toBe('-0.50');
    expect(money('0.05', 'EUR').toDecimalString()).toBe('0.05');
    expect(money(1999, 'JPY').toDecimalString()).toBe('1999');
    expect(money('19.99', 'EUR').toMinorUnits()).toBe(1999);
    expect(money('19.99', 'EUR').toMinorBigInt()).toBe(1999n);
    expect(() => money('0.001', 'EUR', { scale: 3 }).toMinorUnits()).toThrow(RoundingNecessaryError);
    expect(() => Money.fromMinor(2n ** 60n, 'EUR').toMinorNumber()).toThrow(NumericRangeError);
    expect(money('19.99', 'EUR').toNumber()).toBe(19.99);
  });

  it('round-trips through toString/parse and JSON, keeping the scale', () => {
    const unitPrice = money('0.1234', 'EUR', { scale: 4 });
    expect(Money.parse(unitPrice.toString()).eq(unitPrice)).toBe(true);
    expect(Money.parse(unitPrice.toString()).scale).toBe(4);
    expect(Money.parse('EUR 19.99').toString()).toBe('19.99 EUR');
    expect(JSON.stringify(money('19.99', 'EUR'))).toBe('{"amount":"19.99","currency":"EUR"}');
    expect(Money.fromJSON(JSON.parse('{"amount":"19.99","currency":"EUR"}')).toString()).toBe('19.99 EUR');
    const btc = Currency.custom({ code: 'BTC', scale: 8 });
    expect(Money.parse('0.5 BTC', [btc]).toString()).toBe('0.50000000 BTC');
    expect(() => Money.fromJSON({ amount: 19.99, currency: 'EUR' })).toThrow(InvalidArgumentError);
    expect(() => Money.parse('19.99')).toThrow(NumberFormatError);
  });

  it('never turns into a float by accident', () => {
    const price = money('19.99', 'EUR');
    expect(() => +price).toThrow(TypeError);
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- the point of the test
    expect(`${price}`).toBe('19.99 EUR');
    expect(Object.prototype.toString.call(price)).toBe('[object Money]');
    expect(isMoney(price)).toBe(true);
    expect(isMoney({ units: 1 })).toBe(false);
  });

  it('bridges to @arki/math exact types', () => {
    expect(toDecimal(money('19.90', 'EUR')).toString()).toBe('19.90');
    expect(toRational(money('19.90', 'EUR')).toString()).toBe('199/10');
    const third = toRational(money(100, 'EUR')).times(ratio(1, 3));
    expect(money(third, 'EUR', { rounding: 'halfEven' }).toString()).toBe('33.33 EUR');
  });
});

describe('errors', () => {
  it('all belong to the MathError family', () => {
    const usd: Money = money(1, 'USD');
    for (const run of [() => money(1, 'ZZZ'), () => usd.plus(money(1, 'EUR'))]) {
      expect(run).toThrow(MathError);
    }
  });
});

describe('types', () => {
  it('infers the currency from a literal code', () => {
    expectTypeOf(money(1, 'EUR')).toEqualTypeOf<Money<'EUR'>>();
    expectTypeOf(money(1, Currency.custom({ code: 'BTC', scale: 8 }))).toEqualTypeOf<Money<'BTC'>>();
    expectTypeOf(sum([money(1, 'EUR')])).toEqualTypeOf<Money<'EUR'>>();
    const code = String('EUR');
    expectTypeOf(money(1, code)).toEqualTypeOf<Money>();
    expectTypeOf(Money.of(money(1, code), 'EUR')).toEqualTypeOf<Money<'EUR'>>();
    expectTypeOf<ReturnType<Money['valueOf']>>().toBeNever();
  });
});

describe('allocation matches largest remainder in bigint arithmetic', () => {
  type Policy = 'largest' | 'first' | 'last';

  /** Independent reference: every step in bigint, ties broken by position. */
  function reference(units: bigint, weights: readonly bigint[], policy: Policy): bigint[] {
    const negative = units < 0n;
    const magnitude = negative ? -units : units;
    const total = weights.reduce((a, b) => a + b, 0n);
    const shares = weights.map(weight => (magnitude * weight) / total);
    const rests = weights.map((weight, i) => magnitude * weight - (shares[i] ?? 0n) * total);
    let left = magnitude - shares.reduce((a, b) => a + b, 0n);
    const order = weights.flatMap((weight, i) => (weight === 0n ? [] : [i]));
    if (policy === 'largest') {
      order.sort((x, y) => {
        const a = rests[x] ?? 0n;
        const b = rests[y] ?? 0n;
        return a === b ? x - y : a < b ? 1 : -1;
      });
    } else if (policy === 'last') {
      order.reverse();
    }
    for (const index of order) {
      if (left === 0n) break;
      shares[index] = (shares[index] ?? 0n) + 1n;
      left -= 1n;
    }
    return shares.map(share => (negative ? -share : share));
  }

  it('on number, bigint and decimal-string ratios, small and huge amounts, every policy', () => {
    const next = rng(9);
    const eur = Currency.of('EUR');
    const policies: readonly Policy[] = ['largest', 'first', 'last'];
    for (let round = 0; round < 1500; round++) {
      const huge = next() < 0.2;
      const magnitude = huge ? 2n ** 70n + BigInt(Math.floor(next() * 1e9)) : BigInt(Math.floor(next() * 1e7));
      const units = next() < 0.3 ? -magnitude : magnitude;
      const count = 1 + Math.floor(next() * 6);
      const coefficients = Array.from({ length: count }, () => BigInt(Math.floor(next() * (next() < 0.5 ? 4 : 1000))));
      const fractions = Array.from({ length: count }, () => (next() < 0.3 ? Math.floor(next() * 3) : 0));
      if (!coefficients.some(c => c > 0n)) coefficients[0] = 1n;
      const ratios = coefficients.map((c, i) => {
        const fraction = fractions[i] ?? 0;
        if (fraction > 0) return (Number(c) / 10 ** fraction).toFixed(fraction);
        const kind = next();
        return kind < 0.6 ? Number(c) : kind < 0.8 ? c : String(c);
      });
      const common = Math.max(...fractions);
      const weights = coefficients.map((c, i) => c * 10n ** BigInt(common - (fractions[i] ?? 0)));
      const whole = Money.fromMinor(units, eur);
      for (const policy of policies) {
        const parts = whole.allocate(ratios, { remainder: policy }).map(part => BigInt(part.units));
        expect(parts, `${units} ${JSON.stringify(ratios.map(String))} ${policy}`).toEqual(
          reference(units, weights, policy),
        );
      }
    }
  });

  it('treats -0 as a zero ratio', () => {
    expect(money('0.03', 'EUR').allocate([-0, 1, 1]).map(String)).toEqual(['0.00 EUR', '0.02 EUR', '0.01 EUR']);
  });
});
