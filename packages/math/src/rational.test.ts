import { describe, expect, it } from 'vitest';

import { decimal } from './decimal.js';
import { DivisionByZeroError, InvalidArgumentError, NumberFormatError, RoundingNecessaryError } from './errors.js';
import { isRational, ratio } from './rational.js';

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
  it('is frozen and recognized', () => {
    expect(Object.isFrozen(ratio(1, 2))).toBe(true);
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
