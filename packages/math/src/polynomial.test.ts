import { describe, expect, it } from 'vitest';

import type { Complex } from './complex.js';
import { complex } from './complex.js';
import { InvalidArgumentError, NumericRangeError } from './errors.js';
import {
  addPolynomials,
  cubicRoots,
  evaluatePolynomial,
  multiplyPolynomials,
  polynomialDerivative,
  polynomialRoots,
  quadraticRoots,
} from './polynomial.js';

const relativeError = (actual: number, expected: number): number =>
  Math.abs(actual - expected) / Math.max(Math.abs(expected), Number.MIN_VALUE);

const closeTo = (actual: Complex, expected: Complex, tolerance: number): void => {
  expect(actual.approxEqual(expected, tolerance), `${actual.toString()} ≉ ${expected.toString()}`).toBe(true);
};

/** Coefficients (highest first) of ∏ (x - root). */
function fromRoots(roots: readonly number[]): number[] {
  let product = [1];
  for (const root of roots) product = multiplyPolynomials(product, [1, -root]);
  return product;
}

describe('evaluate, derivative, add, multiply', () => {
  it('reads coefficients highest degree first, like the written polynomial', () => {
    // x³ - 6x² + 11x - 6 at x = 4 is 64 - 96 + 44 - 6 = 6.
    expect(evaluatePolynomial([1, -6, 11, -6], 4)).toBe(6);
    expect(evaluatePolynomial([0, 0, 2, 1], 3)).toBe(7);
  });

  it('evaluates at complex points', () => {
    expect(evaluatePolynomial([1, 0, 1], complex(0, 1)).isZero()).toBe(true);
    expect(evaluatePolynomial([1, -2, 5], complex(1, 2)).isZero()).toBe(true);
  });

  it('rejects inputs that would otherwise spread NaN', () => {
    expect(() => evaluatePolynomial([], 1)).toThrow(InvalidArgumentError);
    expect(() => evaluatePolynomial([1, Number.NaN], 1)).toThrow(InvalidArgumentError);
    expect(() => evaluatePolynomial([1, 0], Number.POSITIVE_INFINITY)).toThrow(InvalidArgumentError);
    expect(() => evaluatePolynomial([1, 0, 0], 1e200)).toThrow(NumericRangeError);
  });

  it('differentiates term by term', () => {
    expect(polynomialDerivative([1, -6, 11, -6])).toEqual([3, -12, 11]);
    expect(polynomialDerivative([0, 4, 7])).toEqual([4]);
    expect(polynomialDerivative([7])).toEqual([0]);
  });

  it('adds with constant terms aligned and trims cancelled leading terms', () => {
    expect(addPolynomials([1, 2, 3], [1, 1])).toEqual([1, 3, 4]);
    expect(addPolynomials([1, 2], [-1, 0])).toEqual([2]);
    expect(addPolynomials([1, 2], [-1, -2])).toEqual([0]);
  });

  it('multiplies by convolution', () => {
    expect(multiplyPolynomials([1, -1], [1, 1])).toEqual([1, 0, -1]);
    expect(fromRoots([1, 2, 3])).toEqual([1, -6, 11, -6]);
    expect(multiplyPolynomials([1, 2, 3], [0])).toEqual([0]);
  });

  it('never returns -0 or modifies its input', () => {
    const input = [0, 1, -0, 5];
    expect(polynomialDerivative(input)).toEqual([2, 0]);
    expect(Object.is(polynomialDerivative(input)[1], 0)).toBe(true);
    expect(Object.is(evaluatePolynomial([1, 0], -0), 0)).toBe(true);
    expect(input).toEqual([0, 1, -0, 5]);
  });
});

describe('quadraticRoots', () => {
  it('keeps the small root of x² - 1e8·x + 1 at full precision (cancellation case)', () => {
    const result = quadraticRoots(1, -1e8, 1);
    expect(result.kind).toBe('real');
    if (result.kind !== 'real') return;
    // The exact roots are 1e8 - 1e-8 and 1e-8 + 1e-24, so both round to these floats.
    expect(relativeError(result.roots[0], 1e-8)).toBeLessThan(Number.EPSILON);
    expect(relativeError(result.roots[1], 1e8)).toBeLessThan(Number.EPSILON);
    // The schoolbook formula loses most of the small root, which is why q is used.
    const naive = (1e8 - Math.sqrt(1e16 - 4)) / 2;
    expect(relativeError(naive, 1e-8)).toBeGreaterThan(0.2);
  });

  it("keeps near-double roots apart (Kahan's example)", () => {
    // b² and 4ac agree in their first 15 digits; a float discriminant rounds to 0.
    const result = quadraticRoots(94_906_265.625, -189_812_534, 94_906_268.375);
    expect(result.kind).toBe('real');
    if (result.kind !== 'real') return;
    expect(result.roots[0]).toBe(1);
    expect(relativeError(result.roots[1], 1.000_000_028_975_958)).toBeLessThan(1e-15);
  });

  it('returns a conjugate pair, tagged, when the discriminant is negative', () => {
    const result = quadraticRoots(1, 2, 5);
    expect(result.kind).toBe('complex');
    if (result.kind !== 'complex') return;
    expect(result.roots[0].eq(complex(-1, 2))).toBe(true);
    expect(result.roots[1].eq(complex(-1, -2))).toBe(true);
  });

  it('handles double roots, zero roots and huge coefficients', () => {
    expect(quadraticRoots(1, -2, 1)).toEqual({ kind: 'real', roots: [1, 1] });
    expect(quadraticRoots(2, -6, 0)).toEqual({ kind: 'real', roots: [0, 3] });
    expect(quadraticRoots(1, 0, 0)).toEqual({ kind: 'real', roots: [0, 0] });
    // b² = 9e600 would overflow without the power-of-two rescaling.
    expect(quadraticRoots(1e300, -3e300, 2e300)).toEqual({ kind: 'real', roots: [1, 2] });
  });

  it('refuses a = 0 instead of silently solving a linear equation', () => {
    expect(() => quadraticRoots(0, 1, 1)).toThrow(InvalidArgumentError);
  });
});

describe('cubicRoots', () => {
  it('solves the three-real-roots case x³ - 6x² + 11x - 6 exactly', () => {
    expect(cubicRoots(1, -6, 11, -6)).toEqual({ kind: 'real', roots: [1, 2, 3] });
    expect(cubicRoots(2, -3, -11, 6)).toEqual({ kind: 'real', roots: [-2, 0.5, 3] });
  });

  it('recognises double and triple roots instead of inventing tiny imaginary parts', () => {
    // (x-1)²(x-2): the shifted-cubic discriminant is ±1e-17 noise; the original one is exactly 0.
    expect(cubicRoots(1, -4, 5, -2)).toEqual({ kind: 'real', roots: [1, 1, 2] });
    expect(cubicRoots(1, -6, 12, -8)).toEqual({ kind: 'real', roots: [2, 2, 2] });
  });

  it('returns one real root and a conjugate pair', () => {
    const result = cubicRoots(1, 0, 0, -1);
    expect(result.kind).toBe('mixed');
    if (result.kind !== 'mixed') return;
    expect(result.real).toBe(1);
    closeTo(result.complex[0], complex(-0.5, Math.sqrt(3) / 2), 1e-15);
    closeTo(result.complex[1], complex(-0.5, -Math.sqrt(3) / 2), 1e-15);
    expect(cubicRoots(1, 0, 1, 0)).toEqual({ kind: 'mixed', real: 0, complex: [complex(0, 1), complex(0, -1)] });
  });

  it('matches roots built into random cubics', () => {
    let state = 42;
    const next = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 2 ** 32 - 0.5;
    };
    for (let trial = 0; trial < 200; trial++) {
      const roots = [next() * 20, next() * 20, next() * 20].toSorted((x, y) => x - y);
      const [a, b, c, d] = fromRoots(roots) as [number, number, number, number];
      const result = cubicRoots(a, b, c, d);
      expect(result.kind).toBe('real');
      if (result.kind !== 'real') continue;
      for (const [k, root] of result.roots.entries()) expect(Math.abs(root - roots[k]!)).toBeLessThan(1e-9);

      const re = next() * 10;
      const im = Math.abs(next() * 10) + 0.1;
      const real = next() * 10;
      const mixed = multiplyPolynomials([1, -real], [1, -2 * re, re * re + im * im]);
      const pair = cubicRoots(mixed[0]!, mixed[1]!, mixed[2]!, mixed[3]!);
      expect(pair.kind).toBe('mixed');
      if (pair.kind !== 'mixed') continue;
      expect(Math.abs(pair.real - real)).toBeLessThan(1e-12);
      closeTo(pair.complex[0], complex(re, im), 1e-12);
    }
  });

  it('refuses a = 0', () => {
    expect(() => cubicRoots(0, 1, 2, 3)).toThrow(InvalidArgumentError);
  });
});

describe('polynomialRoots', () => {
  it('returns every root of x⁴ - 1 sorted, with real roots exactly real', () => {
    const roots = polynomialRoots([1, 0, 0, 0, -1]);
    expect(roots.map(z => z.toString())).toEqual(['-1', '-i', 'i', '1']);
    expect(roots[0]!.isReal()).toBe(true);
  });

  it('finds the fifth roots of unity', () => {
    const roots = polynomialRoots([1, 0, 0, 0, 0, -1]);
    const expected = complex(1)
      .nthRoots(5)
      .toSorted((x, y) => x.re - y.re || x.im - y.im);
    for (const [k, root] of roots.entries()) closeTo(root, expected[k]!, 1e-15);
  });

  it('separates the clustered roots of Wilkinson-style (x-1)…(x-10)', () => {
    const roots = polynomialRoots(fromRoots([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    for (const [k, root] of roots.entries()) closeTo(root, complex(k + 1), 1e-9);
  });

  it('factors out zero roots exactly and delegates low degrees to the closed forms', () => {
    expect(polynomialRoots([1, -2, 0, 0, 0]).map(z => z.toString())).toEqual(['0', '0', '0', '2']);
    expect(polynomialRoots([2, -1]).map(z => z.toString())).toEqual(['0.5']);
    expect(polynomialRoots([1, -6, 11, -6]).map(z => z.toString())).toEqual(['1', '2', '3']);
    expect(polynomialRoots([1, 2, 5]).map(z => z.toString())).toEqual(['-1 - 2i', '-1 + 2i']);
  });

  it('degrades a multiple root to about 16/m digits, as conditioning dictates', () => {
    // (x-1)⁴: a coefficient change of ε moves the roots by ε^(1/4) ≈ 1e-4.
    for (const root of polynomialRoots([1, -4, 6, -4, 1])) closeTo(root, complex(1), 1e-3);
  });

  it('agrees with Vieta on random high-degree polynomials', () => {
    let state = 7;
    const next = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 2 ** 32 - 0.5;
    };
    for (let trial = 0; trial < 50; trial++) {
      const degree = 4 + (trial % 9);
      const coefficients = Array.from({ length: degree + 1 }, () => next() * 10);
      const roots = polynomialRoots(coefficients);
      expect(roots).toHaveLength(degree);
      // Σ roots = -a1/a0 and ∏ roots = (-1)^n·an/a0.
      let sum = complex(0);
      let product = complex(1);
      for (const root of roots) {
        sum = sum.plus(root);
        product = product.times(root);
      }
      closeTo(sum, complex(-coefficients[1]! / coefficients[0]!), 1e-9);
      closeTo(product, complex((degree % 2 === 0 ? 1 : -1) * (coefficients.at(-1)! / coefficients[0]!)), 1e-9);
    }
  });

  it('has no roots for a constant and refuses the zero polynomial', () => {
    expect(polynomialRoots([0, 3])).toEqual([]);
    expect(() => polynomialRoots([0, 0])).toThrow(InvalidArgumentError);
  });
});
