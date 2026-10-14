import { describe, expect, it } from 'vitest';

import type { IntegrationMethod } from './integrate.js';
import { ConvergenceError, InvalidArgumentError, NumericRangeError } from './errors.js';
import { integrate, IntegrationConvergenceError } from './integrate.js';

type Case = {
  readonly name: string;
  readonly f: (x: number) => number;
  readonly bounds: readonly [number, number];
  readonly exact: number;
  readonly methods: readonly IntegrationMethod[];
};

const both: readonly IntegrationMethod[] = ['gaussKronrod', 'tanhSinh'];

/**
 * Closed forms, and hard cases from the QUADPACK book (Piessens et al. 1983, ch. 4)
 * and Boost's quadrature tests. Each names why it is hard.
 */
const cases: readonly Case[] = [
  { name: '∫₀^π sin = 2 (smooth)', f: Math.sin, bounds: [0, Math.PI], exact: 2, methods: both },
  { name: '∫₀¹ eˣ = e − 1', f: Math.exp, bounds: [0, 1], exact: Math.E - 1, methods: both },
  {
    name: '∫₀¹ x^(−½) = 2 (integrable endpoint singularity)',
    f: x => 1 / Math.sqrt(x),
    bounds: [0, 1],
    exact: 2,
    methods: both,
  },
  { name: '∫₀¹ log x = −1 (log singularity)', f: Math.log, bounds: [0, 1], exact: -1, methods: both },
  {
    name: '∫₀¹ x^(−½) log(1/x) = 4 (QUADPACK test 1, α = −½: two singular factors)',
    f: x => -Math.log(x) / Math.sqrt(x),
    bounds: [0, 1],
    exact: 4,
    methods: ['tanhSinh'],
  },
  {
    name: '∫₀¹ √x log x = −4/9 (Boost)',
    f: x => Math.sqrt(x) * Math.log(x),
    bounds: [0, 1],
    exact: -4 / 9,
    methods: both,
  },
  {
    name: '∫₀¹ 4⁻⁴ / ((x − π/4)² + 16⁻⁴) (QUADPACK test 3: peak of width 0.004)',
    f: x => 4 ** -4 / ((x - Math.PI / 4) ** 2 + 16 ** -4),
    bounds: [0, 1],
    exact: Math.atan((4 - Math.PI) * 4 ** 3) + Math.atan(Math.PI * 4 ** 3),
    methods: ['gaussKronrod'],
  },
  {
    name: '∫₀¹⁰ cos(50x) = sin(500)/50 (80 oscillations)',
    f: x => Math.cos(50 * x),
    bounds: [0, 10],
    exact: Math.sin(500) / 50,
    methods: ['gaussKronrod'],
  },
  {
    name: '∫₀¹ step at 1/3 = 2/3 (a jump the bisection must localize)',
    f: x => (x < 1 / 3 ? 0 : 1),
    bounds: [0, 1],
    exact: 2 / 3,
    methods: ['gaussKronrod'],
  },
  {
    name: '∫₀^∞ e^(−x²) = √π/2 (half line)',
    f: x => Math.exp(-x * x),
    bounds: [0, Infinity],
    exact: Math.sqrt(Math.PI) / 2,
    methods: both,
  },
  { name: '∫_−∞^0 eˣ = 1 (lower half line)', f: Math.exp, bounds: [-Infinity, 0], exact: 1, methods: both },
  {
    name: '∫_−∞^∞ 1/(1 + x²) = π (whole line, algebraic decay)',
    f: x => 1 / (1 + x * x),
    bounds: [-Infinity, Infinity],
    exact: Math.PI,
    methods: both,
  },
  {
    name: '∫₂^∞ 1/x² = ½ (half line not starting at 0)',
    f: x => 1 / (x * x),
    bounds: [2, Infinity],
    exact: 0.5,
    methods: both,
  },
];

describe('integrate: closed forms and hard cases', () => {
  for (const testCase of cases) {
    for (const method of testCase.methods) {
      it(`${testCase.name} — ${method}`, () => {
        const result = integrate(testCase.f, testCase.bounds, { method });
        const actualError = Math.abs(result.value - testCase.exact);
        // The contract: within tolerance, and the reported estimate is never smaller than the real error.
        expect(actualError).toBeLessThanOrEqual(result.errorEstimate);
        expect(result.errorEstimate).toBeLessThanOrEqual(Math.max(1e-12, 1e-10 * Math.abs(result.value)));
        expect(result.evaluations).toBeGreaterThan(0);
      });
    }
  }

  it('tanh-sinh needs far fewer evaluations than subdivision for an endpoint singularity', () => {
    const f = (x: number): number => 1 / Math.sqrt(x);
    const kronrod = integrate(f, [0, 1]);
    const tanhSinh = integrate(f, [0, 1], { method: 'tanhSinh' });
    expect(tanhSinh.evaluations * 3).toBeLessThan(kronrod.evaluations);
  });

  it('stops after one 15-point rule when both rules are exact (degree ≤ 13)', () => {
    // The estimate compares K15 with the embedded G7, so it only vanishes when G7 is exact too.
    const result = integrate(x => x ** 13 - 3 * x ** 7, [0, 1]);
    expect(result.evaluations).toBe(15);
    expect(result.value).toBeCloseTo(1 / 14 - 3 / 8, 15);
  });
});

describe('integrate: orientation and bounds', () => {
  it('negates the integral for reversed bounds, finite or infinite', () => {
    expect(integrate(Math.sin, [Math.PI, 0]).value).toBeCloseTo(-2, 13);
    expect(integrate(x => Math.exp(-x), [Infinity, 0], { method: 'tanhSinh' }).value).toBeCloseTo(-1, 12);
  });

  it('gives exactly 0 for equal finite bounds without calling f', () => {
    const result = integrate(() => {
      throw new Error('not called');
    }, [1, 1]);
    expect(result).toEqual({ value: 0, errorEstimate: 0, evaluations: 0 });
  });

  it('rejects NaN bounds, equal infinite bounds and bad options', () => {
    expect(() => integrate(Math.sin, [Number.NaN, 1])).toThrow(InvalidArgumentError);
    expect(() => integrate(Math.sin, [Infinity, Infinity])).toThrow(InvalidArgumentError);
    expect(() => integrate(Math.sin, [0, 1], { absoluteTolerance: 0, relativeTolerance: 0 })).toThrow(
      InvalidArgumentError,
    );
    expect(() => integrate(Math.sin, [0, 1], { maxEvaluations: 0 })).toThrow(InvalidArgumentError);
  });
});

describe('integrate: failures are typed, never NaN', () => {
  it('reports a pole inside the interval as NumericRangeError naming the point', () => {
    // The first Gauss–Kronrod node is the midpoint, 0.5, where 1/(x − 0.5) is infinite.
    expect(() => integrate(x => 1 / (x - 0.5), [0, 1])).toThrow(/f\(0\.5\) is Infinity/);
    expect(() => integrate(() => Number.NaN, [0, 1])).toThrow(NumericRangeError);
  });

  it('never returns a number for the divergent ∫₀¹ 1/x', () => {
    const f = (x: number): number => 1 / x;
    expect(() => integrate(f, [0, 1])).toThrow(ConvergenceError);
    expect(() => integrate(f, [0, 1], { method: 'tanhSinh' })).toThrow(ConvergenceError);
  });

  it('carries the best estimate when the budget runs out', () => {
    let error: unknown;
    try {
      integrate(x => Math.cos(50 * x), [0, 10], { maxEvaluations: 100 });
    } catch (error_) {
      error = error_;
    }
    expect(error).toBeInstanceOf(IntegrationConvergenceError);
    expect(error).toBeInstanceOf(ConvergenceError);
    const { best } = error as IntegrationConvergenceError;
    expect(best.evaluations).toBeLessThanOrEqual(100);
    expect(Number.isFinite(best.value)).toBe(true);
    expect(best.errorEstimate).toBeGreaterThan(Math.max(1e-12, 1e-10 * Math.abs(best.value)));
  });

  it('flags a singularity at a non-zero endpoint through the error estimate, and the substitution fixes it', () => {
    // Nodes can only get within one ulp of 1, so the tail below 1 + 2e-16 is invisible;
    // the estimate admits it instead of claiming 1e-10.
    let error: unknown;
    try {
      integrate(x => 1 / Math.sqrt(x - 1), [1, 2], { method: 'tanhSinh' });
    } catch (error_) {
      error = error_;
    }
    expect(error).toBeInstanceOf(IntegrationConvergenceError);
    const { best } = error as IntegrationConvergenceError;
    expect(Math.abs(best.value - 2)).toBeLessThanOrEqual(best.errorEstimate);
    // u = x − 1 moves the singularity to 0, where the nodes reach 1e-308.
    expect(integrate(u => 1 / Math.sqrt(u), [0, 1], { method: 'tanhSinh' }).value).toBeCloseTo(2, 12);
  });
});
