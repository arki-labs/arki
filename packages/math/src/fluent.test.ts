import { describe, expect, it } from 'vitest';

import { DivisionByZeroError, InvalidArgumentError, NumericRangeError } from './errors.js';
import { num } from './fluent.js';

describe('num() chaining', () => {
  it('clamps then rounds to a step', () => {
    expect(num(127.3).clamp(0, 100).roundTo(5).value()).toBe(100);
  });

  it('chains arithmetic and shaping', () => {
    expect(num(2).plus(3).times(4).minus(1).dividedBy(19).value()).toBe(1);
    expect(num(-3.141_59).abs().round(2).value()).toBe(3.14);
    expect(num(5).negated().value()).toBe(-5);
    expect(num(0).lerp(10, 0.25).value()).toBe(2.5);
    expect(num(5).remap(0, 10, 0, 100).value()).toBe(50);
  });

  it('never exposes -0', () => {
    expect(Object.is(num(-0).value(), 0)).toBe(true);
    expect(Object.is(num(0).negated().value(), 0)).toBe(true);
  });
});

describe('operand validation', () => {
  it('rejects non-finite operands with InvalidArgumentError naming "other"', () => {
    for (const bad of [Infinity, -Infinity, Number.NaN]) {
      expect(() => num(1).plus(bad)).toThrow(InvalidArgumentError);
      expect(() => num(1).minus(bad)).toThrow(/other/);
      expect(() => num(1).times(bad)).toThrow(/other/);
      expect(() => num(2).dividedBy(bad)).toThrow(/other/);
    }
  });

  it('throws DivisionByZeroError for dividedBy(0)', () => {
    expect(() => num(1).dividedBy(0)).toThrow(DivisionByZeroError);
    expect(() => num(1).dividedBy(-0)).toThrow(DivisionByZeroError);
  });

  it('throws NumericRangeError when a result overflows', () => {
    expect(() => num(1e308).plus(1e308)).toThrow(NumericRangeError);
    expect(() => num(1e308).times(10)).toThrow(NumericRangeError);
  });

  it('rejects a non-finite wrapped value', () => {
    expect(() => num(Infinity)).toThrow(InvalidArgumentError);
    expect(() => num(Number.NaN)).toThrow(InvalidArgumentError);
  });
});

describe('queries', () => {
  it('answers range, equality and sign questions', () => {
    expect(num(5).inRange(0, 5)).toBe(false);
    expect(num(5).inRange(0, 5, '[]')).toBe(true);
    expect(num(5).inRange(0, 5, '()')).toBe(false);
    expect(num(0.1 + 0.2).approxEqual(0.3)).toBe(true);
    expect(num(1).approxEqual(2)).toBe(false);
    expect(num(0).isZero()).toBe(true);
    expect(num(1).isZero()).toBe(false);
    expect(num(1).isPositive()).toBe(true);
    expect(num(-1).isNegative()).toBe(true);
    expect(num(2).isInteger()).toBe(true);
    expect(num(2.5).isInteger()).toBe(false);
  });
});

describe('presentation', () => {
  it('formats numbers, currency, percent and compact', () => {
    expect(num(1234.5).formatNumber()).toBe('1,234.5');
    expect(num(1234.5).formatCurrency('USD')).toBe('$1,234.50');
    expect(num(0.125).formatPercent()).toBe('12.5%');
    expect(num(1500).formatCompact()).toBe('1.5K');
  });
});

describe('extraction', () => {
  it('hops to exact types', () => {
    expect(num(0.1).toDecimal().toString()).toBe('0.1');
    expect(num(0.5).toRatio().toString()).toBe('1/2');
  });

  it('serialises as the plain number', () => {
    expect(JSON.stringify({ n: num(3.5) })).toBe('{"n":3.5}');
    expect(num(3.5).toJSON()).toBe(3.5);
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- the template-literal path is what is under test
    expect(`${num(7)}`).toBe('7');
    expect(String(num(7))).toBe('7');
  });

  it('refuses implicit numeric coercion', () => {
    expect(() => +num(1)).toThrow(TypeError);
    // @ts-expect-error TypeScript rejects arithmetic on an object
    // eslint-disable-next-line @typescript-eslint/restrict-plus-operands -- implicit coercion is what is under test
    expect(() => num(1) + 1).toThrow(TypeError);
  });
});

describe('immutability', () => {
  it('leaves the original wrapper unchanged after every method', () => {
    const a = num(10);
    a.plus(1);
    a.minus(1);
    a.times(2);
    a.dividedBy(2);
    a.abs();
    a.negated();
    a.clamp(0, 5);
    a.round();
    a.roundTo(3);
    expect(a.value()).toBe(10);
  });
});
