import fc from 'fast-check';
import Fraction from 'fraction.js';
import { describe, expect, it } from 'vitest';

import type { Rational } from './rational.js';
import { ratio } from './rational.js';

// Seeded, so every run checks the same cases and a failure prints a replayable seed and path.
// For a deep run raise the case count: MATH_PROPERTY_RUNS=20000 bun run test.
// The package compiles without Node types (it runs on every runtime); the test runner is Node.
declare const process: { readonly env: Readonly<Record<string, string | undefined>> };
const RUNS = Math.max(300, Number(process.env.MATH_PROPERTY_RUNS) || 0);
const config = { seed: 20_261_014, numRuns: RUNS };

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/** The invariant every Rational keeps: lowest terms, positive denominator, zero as 0/1. */
function expectReduced(value: Rational): void {
  expect(value.denominator > 0n).toBe(true);
  expect(gcd(value.numerator, value.denominator)).toBe(1n);
  if (value.numerator === 0n) expect(value.denominator).toBe(1n);
}

const big = 10n ** 30n;
const integerArb = fc.oneof(fc.bigInt({ min: -50n, max: 50n }), fc.bigInt({ min: -big, max: big }));
const anyRational = fc
  .tuple(
    integerArb,
    integerArb.filter(d => d !== 0n),
  )
  .map(([numerator, denominator]) => ratio(numerator, denominator));
const nonZeroRational = anyRational.filter(r => !r.isZero());

describe('Rational properties: reduced form', () => {
  it('construction and every operation return lowest terms with a positive denominator', () => {
    fc.assert(
      fc.property(anyRational, nonZeroRational, fc.integer({ min: -4, max: 4 }), (a, b, exponent) => {
        for (const value of [
          a,
          b,
          a.plus(b),
          a.minus(b),
          a.times(b),
          a.dividedBy(b),
          b.inverse(),
          a.negated(),
          a.abs(),
          b.pow(exponent),
        ]) {
          expectReduced(value);
        }
      }),
      config,
    );
  });

  it('ratio(n, d) equals n/d reduced by the gcd', () => {
    fc.assert(
      fc.property(
        integerArb,
        integerArb.filter(d => d !== 0n),
        (numerator, denominator) => {
          const value = ratio(numerator, denominator);
          const divisor = gcd(numerator, denominator);
          const sign = denominator < 0n ? -1n : 1n;
          expect(value.numerator).toBe((sign * numerator) / divisor);
          expect(value.denominator).toBe((sign * denominator) / divisor);
        },
      ),
      config,
    );
  });

  it('toString parses back to the same value', () => {
    fc.assert(
      fc.property(anyRational, value => {
        expect(ratio(value.toString()).eq(value)).toBe(true);
      }),
      config,
    );
  });
});

describe('Rational properties: field laws (exact)', () => {
  it('plus and times are commutative and associative', () => {
    fc.assert(
      fc.property(anyRational, anyRational, anyRational, (a, b, c) => {
        expect(a.plus(b).eq(b.plus(a))).toBe(true);
        expect(a.times(b).eq(b.times(a))).toBe(true);
        expect(
          a
            .plus(b)
            .plus(c)
            .eq(a.plus(b.plus(c))),
        ).toBe(true);
        expect(
          a
            .times(b)
            .times(c)
            .eq(a.times(b.times(c))),
        ).toBe(true);
      }),
      config,
    );
  });

  it('times distributes over plus', () => {
    fc.assert(
      fc.property(anyRational, anyRational, anyRational, (a, b, c) => {
        expect(a.times(b.plus(c)).eq(a.times(b).plus(a.times(c)))).toBe(true);
      }),
      config,
    );
  });

  it('identities and inverses: a + 0 = a, a · 1 = a, a + (−a) = 0, a · a⁻¹ = 1, (a / b) · b = a', () => {
    fc.assert(
      fc.property(anyRational, nonZeroRational, (a, b) => {
        expect(a.plus(0).eq(a)).toBe(true);
        expect(a.times(1).eq(a)).toBe(true);
        expect(a.plus(a.negated()).isZero()).toBe(true);
        expect(b.times(b.inverse()).eq(1)).toBe(true);
        expect(a.dividedBy(b).times(b).eq(a)).toBe(true);
        expect(a.minus(b).plus(b).eq(a)).toBe(true);
      }),
      config,
    );
  });

  it('compareTo agrees with the sign of the difference', () => {
    fc.assert(
      fc.property(anyRational, anyRational, (a, b) => {
        const order = a.compareTo(b);
        expect(order).toBe(a.minus(b).sign());
        expect(b.compareTo(a) === -order).toBe(true);
        expect(a.eq(b)).toBe(order === 0);
        expect(a.lt(b)).toBe(order < 0);
      }),
      config,
    );
  });
});

describe('Rational properties: differential against fraction.js', () => {
  /** fraction.js 5 keeps sign `s` and magnitudes `n`, `d` as bigints, in lowest terms. */
  function sameAs(ours: Rational, theirs: Fraction): void {
    expect(ours.numerator).toBe(theirs.s * theirs.n);
    expect(ours.denominator).toBe(theirs.d);
  }

  it('plus, minus, times, dividedBy and compare', () => {
    fc.assert(
      fc.property(anyRational, nonZeroRational, (a, b) => {
        const fa = new Fraction(a.numerator, a.denominator);
        const fb = new Fraction(b.numerator, b.denominator);
        sameAs(a, fa);
        sameAs(a.plus(b), fa.add(fb));
        sameAs(a.minus(b), fa.sub(fb));
        sameAs(a.times(b), fa.mul(fb));
        sameAs(a.dividedBy(b), fa.div(fb));
        expect(a.compareTo(b)).toBe(Math.sign(fa.compare(fb)));
      }),
      config,
    );
  });
});
