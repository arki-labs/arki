import { describe, expect, it } from 'vitest';

import { DivisionByZeroError, InvalidArgumentError, NumericRangeError } from './errors.js';
import { divmod, gcd, lcm } from './integer.js';

describe('gcd', () => {
  it('works on numbers', () => {
    expect(gcd(12, 18)).toBe(6);
    expect(gcd(0, 0)).toBe(0);
    expect(gcd(-4, 6)).toBe(2);
    expect(gcd(0, 5)).toBe(5);
    expect(gcd(7, 13)).toBe(1);
  });
  it('works on bigints', () => {
    expect(gcd(12n, 18n)).toBe(6n);
    expect(gcd(-4n, -6n)).toBe(2n);
    expect(gcd(0n, 0n)).toBe(0n);
  });
  it('rejects non-integers and unsafe integers', () => {
    expect(() => gcd(1.5, 3)).toThrow(InvalidArgumentError);
    expect(() => gcd(2 ** 53, 3)).toThrow(InvalidArgumentError);
    expect(() => gcd(Number.NaN, 3)).toThrow(InvalidArgumentError);
  });
  it('refuses to mix number and bigint', () => {
    // @ts-expect-error mixing kinds is a type error too
    expect(() => gcd(1, 2n)).toThrow(TypeError);
  });
});

describe('lcm', () => {
  it('works on numbers', () => {
    expect(lcm(4, 6)).toBe(12);
    expect(lcm(0, 5)).toBe(0);
    expect(lcm(-4, 6)).toBe(12);
    expect(Object.is(lcm(0, -5), 0)).toBe(true);
  });
  it('works on bigints', () => {
    expect(lcm(2n ** 40n, 3n)).toBe(3n * 2n ** 40n);
    expect(lcm(0n, 3n)).toBe(0n);
    expect(lcm(-4n, 6n)).toBe(12n);
  });
  it('throws when the number result is not a safe integer', () => {
    expect(() => lcm(2 ** 40, 2 ** 40 - 1)).toThrow(NumericRangeError);
  });
  it('validates inputs even when one is zero', () => {
    expect(() => lcm(0, 1.5)).toThrow(InvalidArgumentError);
  });
  it('refuses to mix kinds', () => {
    // @ts-expect-error mixing kinds is a type error too
    expect(() => lcm(1n, 2)).toThrow(TypeError);
  });
});

describe('divmod', () => {
  it('floors the quotient; remainder takes the divisor sign', () => {
    expect(divmod(-7, 2)).toEqual([-4, 1]);
    expect(divmod(7, -2)).toEqual([-4, -1]);
    expect(divmod(7, 2)).toEqual([3, 1]);
    expect(divmod(-7, -2)).toEqual([3, -1]);
    expect(divmod(-7n, 2n)).toEqual([-4n, 1n]);
    expect(divmod(7n, -2n)).toEqual([-4n, -1n]);
  });
  it('never returns -0', () => {
    const [q, r] = divmod(0, -5);
    expect(Object.is(q, 0)).toBe(true);
    expect(Object.is(r, 0)).toBe(true);
    const [q2, r2] = divmod(-6, 3);
    expect(Object.is(q2, -2)).toBe(true);
    expect(Object.is(r2, 0)).toBe(true);
  });
  it('throws on a zero divisor', () => {
    expect(() => divmod(1, 0)).toThrow(DivisionByZeroError);
    expect(() => divmod(1n, 0n)).toThrow(DivisionByZeroError);
  });
  it('rejects non-integers', () => {
    expect(() => divmod(1.5, 2)).toThrow(InvalidArgumentError);
  });
});

describe('divmod with huge safe integers', () => {
  const MAX = Number.MAX_SAFE_INTEGER;

  it('keeps the remainder exact when quotient * b would be unsafe', () => {
    expect(divmod(-MAX, 4_503_599_627_370_495)).toEqual([-3, 4_503_599_627_370_494]);
  });

  it('handles every sign combination at large magnitude', () => {
    expect(divmod(MAX, 4_503_599_627_370_495)).toEqual([2, 1]);
    expect(divmod(MAX, -4_503_599_627_370_495)).toEqual([-3, -4_503_599_627_370_494]);
    expect(divmod(-MAX, -4_503_599_627_370_495)).toEqual([2, -1]);
  });

  it('matches the bigint overload on 200 pseudo-random cases', () => {
    let seed = 12_345;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let i = 0; i < 200; i++) {
      const a = Math.trunc((next() * 2 - 1) * MAX);
      let b = Math.trunc((next() * 2 - 1) * (i % 2 === 0 ? MAX : 1e6));
      if (b === 0) b = 3;
      const [q, r] = divmod(a, b);
      const [bq, br] = divmod(BigInt(a), BigInt(b));
      expect([BigInt(q), BigInt(r)]).toEqual([bq, br]);
    }
  });
});
