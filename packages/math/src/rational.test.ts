import { describe, expect, it } from 'vitest';

import { decimal } from './decimal.js';
import {
  DivisionByZeroError,
  InvalidArgumentError,
  NumberFormatError,
  ResourceLimitError,
  RoundingNecessaryError,
} from './errors.js';
import { isRational, ratio } from './rational.js';

// Node's `util.inspect` and Deno's console both look this symbol up on the object.
function inspectWith(value: object, hook: symbol): unknown {
  return Reflect.apply(Reflect.get(value, hook) as () => string, value, []);
}

describe('ratio() construction', () => {
  it('builds equal values from different spellings', () => {
    const third = ratio(1, 3);
    expect(ratio('1/3').eq(third)).toBe(true);
    expect(ratio('0.(3)').eq(third)).toBe(true);
    expect(ratio('1 / 3').eq(third)).toBe(true);
    expect(ratio(2n, 6n).eq(third)).toBe(true);
    expect(ratio('0.(3)').toString()).toBe('1/3');
  });
  it('parses repeating decimals', () => {
    expect(ratio('0.1(6)').toString()).toBe('1/6');
    expect(ratio('1.2(34)').toString()).toBe('611/495');
    expect(ratio('-0.(3)').toString()).toBe('-1/3');
    expect(ratio('.(3)').toString()).toBe('1/3');
  });
  it('accepts numbers and decimals', () => {
    expect(ratio(0.75).toString()).toBe('3/4');
    expect(ratio(decimal('0.5')).toString()).toBe('1/2');
    expect(ratio('0.125').toString()).toBe('1/8');
    expect(ratio(5n).toString()).toBe('5');
  });
  it('normalizes', () => {
    expect(ratio(6, 4).toString()).toBe('3/2');
    expect(ratio(3, -6).toString()).toBe('-1/2');
    expect(ratio(-3, -6).toString()).toBe('1/2');
    expect(ratio(0, 5).toString()).toBe('0');
    expect(ratio(0, -5).denominator).toBe(1n);
  });
  it('rejects zero denominators and bad input', () => {
    expect(() => ratio(1, 0)).toThrow(DivisionByZeroError);
    expect(() => ratio('1/0')).toThrow(DivisionByZeroError);
    expect(() => ratio('abc')).toThrow(NumberFormatError);
    expect(() => ratio(1.5, 2)).toThrow();
  });
  it('is not frozen and is recognized', () => {
    // Results are deliberately not frozen. `Object.freeze` on every result made an
    // inlined `times` loop 5–7× slower (Bun 25.9 → 3.7 ns, Node 40.7 → 7.3 ns,
    // measured 2026-10-14), and no peer (decimal.js, big.js, bignumber.js,
    // fraction.js, complex.js) freezes. The guarantee is that no method modifies its
    // operands; the shared constants that arithmetic returns are frozen instead.
    expect(Object.isFrozen(ratio(1, 2))).toBe(false);
    expect(Object.isFrozen(ratio(1, 2).times(3))).toBe(false);
    expect(isRational(ratio(1, 2))).toBe(true);
    expect(isRational(decimal(1))).toBe(false);
  });
});

describe('arithmetic', () => {
  it('adds, subtracts, multiplies, divides', () => {
    expect(ratio(1, 3).plus(ratio(1, 6)).toString()).toBe('1/2');
    expect(ratio(1, 3).minus(ratio(1, 3)).toString()).toBe('0');
    expect(ratio(2, 3).times(ratio(3, 4)).toString()).toBe('1/2');
    expect(ratio(1, 2).dividedBy(ratio(1, 4)).toString()).toBe('2');
    expect(ratio(1, 3).plus('0.5').toString()).toBe('5/6');
    expect(ratio(1, 3).times(3).toString()).toBe('1');
  });
  it('division by zero', () => {
    expect(() => ratio(1, 2).dividedBy(0)).toThrow(DivisionByZeroError);
  });
  it('pow / inverse / abs / negated', () => {
    expect(ratio(2, 3).pow(2).toString()).toBe('4/9');
    expect(ratio(2, 3).pow(-2).toString()).toBe('9/4');
    expect(ratio(2, 3).pow(0).toString()).toBe('1');
    expect(ratio(-2, 3).pow(3).toString()).toBe('-8/27');
    expect(() => ratio(0).pow(-1)).toThrow(DivisionByZeroError);
    expect(() => ratio(2, 3).pow(0.5)).toThrow(InvalidArgumentError);
    expect(ratio(2, 3).inverse().toString()).toBe('3/2');
    expect(ratio(-2, 3).inverse().toString()).toBe('-3/2');
    expect(() => ratio(0).inverse()).toThrow(DivisionByZeroError);
    expect(ratio(-1, 2).abs().toString()).toBe('1/2');
    expect(ratio(1, 2).negated().toString()).toBe('-1/2');
  });
  it('toDecimal keeps the 10 000-digit cap of every Decimal', () => {
    const big = ratio('9'.repeat(9999));
    expect(big.toDecimal({ scale: 1 }).scale).toBe(1);
    expect(() => big.toDecimal({ scale: 2 })).toThrow(ResourceLimitError);
  });
  it('pow refuses only a numerator or denominator past the 10 000-digit cap', () => {
    // The estimate used to add both parts' digit counts and multiply by the exponent, so
    // (2/3)^14000 (4215 and 6680 digits) and even 1^20000 were refused.
    expect(
      ratio(2, 3)
        .pow(14_000)
        .eq(ratio(2n ** 14_000n, 3n ** 14_000n)),
    ).toBe(true);
    expect(ratio(1).pow(20_000).toString()).toBe('1');
    expect(ratio(-1).pow(Number.MAX_SAFE_INTEGER).toString()).toBe('-1');
    expect(ratio(0).pow(Number.MAX_SAFE_INTEGER).toString()).toBe('0');
    // At the cap and one past it, for each part: 2^33219 has 10 000 digits, 2^33220 has 10 001.
    expect(
      ratio(1, 2)
        .pow(33_219)
        .eq(ratio(1n, 2n ** 33_219n)),
    ).toBe(true);
    expect(() => ratio(1, 2).pow(33_220)).toThrow(ResourceLimitError);
    expect(() => ratio(2).pow(33_220)).toThrow(ResourceLimitError);
    expect(() => ratio(1, 2).pow(-33_220)).toThrow(ResourceLimitError);
  });
});

describe('comparison', () => {
  it('compares', () => {
    expect(ratio(1, 3).compareTo(ratio(1, 2))).toBe(-1);
    expect(ratio(1, 2).compareTo('0.5')).toBe(0);
    expect(ratio(2, 3).compareTo(ratio(1, 2))).toBe(1);
    expect(ratio(1, 3).lt(ratio(1, 2))).toBe(true);
    expect(ratio(1, 2).lte(ratio(1, 2))).toBe(true);
    expect(ratio(1, 2).gt(ratio(1, 3))).toBe(true);
    expect(ratio(1, 2).gte(ratio(1, 2))).toBe(true);
    expect(ratio(-1, 2).lt(ratio(-1, 3))).toBe(true);
  });
  it('predicates', () => {
    expect(ratio(0).isZero()).toBe(true);
    expect(ratio(1, 2).isPositive()).toBe(true);
    expect(ratio(-1, 2).isNegative()).toBe(true);
    expect(ratio(4, 2).isInteger()).toBe(true);
    expect(ratio(1, 2).isInteger()).toBe(false);
    expect(ratio(-1, 2).sign()).toBe(-1);
    expect(ratio(0).sign()).toBe(0);
    expect(ratio(1, 2).sign()).toBe(1);
  });
});

describe('conversion', () => {
  it('toDecimal', () => {
    expect(ratio(3, 8).toDecimal().toString()).toBe('0.375');
    expect(ratio(-3, 8).toDecimal().toString()).toBe('-0.375');
    expect(ratio(6, 2).toDecimal().toString()).toBe('3');
    expect(() => ratio(1, 3).toDecimal()).toThrow(RoundingNecessaryError);
    expect(ratio(1, 3).toDecimal({ scale: 2, rounding: 'halfUp' }).toString()).toBe('0.33');
    expect(ratio(2, 3).toDecimal({ scale: 2, rounding: 'halfUp' }).toString()).toBe('0.67');
    expect(() => ratio(1, 3).toDecimal({ scale: 2 })).toThrow(RoundingNecessaryError);
  });
  it('toMixed', () => {
    const pos = ratio(7, 2).toMixed();
    expect(pos.whole).toBe(3n);
    expect(pos.fraction.toString()).toBe('1/2');
    const neg = ratio(-7, 2).toMixed();
    expect(neg.whole).toBe(-3n);
    expect(neg.fraction.toString()).toBe('-1/2');
    const int = ratio(4).toMixed();
    expect(int.whole).toBe(4n);
    expect(int.fraction.isZero()).toBe(true);
  });
  it('toNumber', () => {
    expect(ratio(1, 3).toNumber()).toBeCloseTo(0.333_333_333_333_333_3, 15);
    expect(ratio(1, 3).toNumber()).toBe(1 / 3);
    expect(ratio(1n, 10n ** 50n).toNumber()).toBe(1e-50);
    expect(ratio(-7, 2).toNumber()).toBe(-3.5);
  });
  it('toBigInt', () => {
    expect(ratio(4, 2).toBigInt()).toBe(2n);
    expect(ratio(-6, 3).toBigInt()).toBe(-2n);
    expect(() => ratio(1, 2).toBigInt()).toThrow(RoundingNecessaryError);
  });
  it('serializes', () => {
    expect(ratio(1, 3).toJSON()).toBe('1/3');
    expect(JSON.stringify({ a: ratio(1, 3) })).toBe('{"a":"1/3"}');
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- toPrimitive('string') is the point
    expect(`${ratio(-7, 2)}`).toBe('-7/2');
    expect(Object.prototype.toString.call(ratio(1, 2))).toBe('[object Rational]');
  });
  it('refuses coercion', () => {
    // @ts-expect-error a Rational is not a number
    expect(() => ratio(1, 2) + 1).toThrow(TypeError); // eslint-disable-line @typescript-eslint/restrict-plus-operands
    expect(() => +ratio(1, 2)).toThrow(TypeError);
    // @ts-expect-error a Rational is not comparable with <
    expect(() => ratio(1, 2) < 1).toThrow(TypeError);
  });
});

describe('approximate', () => {
  it('finds the best fraction under a denominator limit', () => {
    expect(ratio('3.14159265').approximate(1000).toString()).toBe('355/113');
    expect(ratio('3.14159265').approximate(10).toString()).toBe('22/7');
    expect(ratio('-3.14159265').approximate(1000).toString()).toBe('-355/113');
  });
  it('leaves small denominators unchanged', () => {
    const third = ratio(1, 3);
    expect(third.approximate(10)).toBe(third);
    expect(third.approximate(3)).toBe(third);
  });
  it('can collapse to an integer', () => {
    expect(ratio('0.6').approximate(1).toString()).toBe('1');
    expect(ratio('0.4').approximate(1).toString()).toBe('0');
  });
  it('rejects a limit below 1', () => {
    expect(() => ratio(1, 3).approximate(0)).toThrow(InvalidArgumentError);
  });
});

describe('immutability without freezing', () => {
  it('leaves the receiver and the operand unchanged after success and failure, frozen or not', () => {
    for (const freeze of [false, true]) {
      const a = ratio(-3, 4);
      const b = ratio(2, 3);
      if (freeze) {
        Object.freeze(a);
        Object.freeze(b);
      }
      expect(a.plus(b).toString()).toBe('-1/12');
      expect(a.minus(b).toString()).toBe('-17/12');
      expect(a.times(b).toString()).toBe('-1/2');
      expect(a.dividedBy(b).toString()).toBe('-9/8');
      expect(a.pow(-2).toString()).toBe('16/9');
      expect(() => a.dividedBy(0)).toThrow(DivisionByZeroError);
      expect(() => b.minus(b).inverse()).toThrow(DivisionByZeroError);
      expect([a.numerator, a.denominator, b.numerator, b.denominator]).toEqual([-3n, 4n, 2n, 3n]);
    }
  });

  it('freezes the shared zero that zero sums and products return', () => {
    // Every zero result is one module-wide 0/1. If a caller could write to it,
    // every later zero product and zero sum would come out wrong.
    const zero = ratio(1, 3).times(0);
    expect(Object.isFrozen(zero)).toBe(true);
    expect(() => Object.assign(zero, { numerator: 5n })).toThrow(TypeError);
    expect(ratio(2, 3).times(0).toString()).toBe('0');
    expect(ratio(1, 6).plus(ratio(-1, 6)).toString()).toBe('0');
    expect(ratio(0, 7).plus(ratio(1, 2)).toString()).toBe('1/2');
  });

  it('keeps its JSON text, console display and plain-data shape', () => {
    const r = ratio(-1, 3);
    expect(JSON.stringify({ r })).toBe('{"r":"-1/3"}');
    expect(ratio(r.toJSON()).eq(r)).toBe(true);
    expect(inspectWith(r, Symbol.for('nodejs.util.inspect.custom'))).toBe('Rational(-1/3)');
    expect(Object.keys(r)).toEqual(['numerator', 'denominator']);
    expect(Object.fromEntries(Object.entries(r))).toEqual({ numerator: -1n, denominator: 3n });
  });
});

describe('the 18 000-digit bigint ceiling (Hermes V1 rejects about 19 690 digits)', () => {
  // Odd parts two apart share no factor, so each ratio is already in lowest terms at 10 000 digits.
  const base = 10n ** 9999n;
  const a = ratio(base + 1n, base + 3n);
  const b = ratio(base + 7n, base + 9n);

  it('refuses products, sums and comparisons of two 10 000-digit parts before building them', () => {
    expect(() => a.times(b)).toThrow(ResourceLimitError);
    expect(() => a.plus(b)).toThrow(ResourceLimitError);
    expect(() => a.dividedBy(b)).toThrow(ResourceLimitError);
    expect(() => a.compareTo(b)).toThrow(ResourceLimitError);
  });

  it('refuses a repeating decimal whose parts would pass the ceiling', () => {
    expect(() => ratio(`0.(${'1'.repeat(18_000)})`)).toThrow(ResourceLimitError);
  });
});
