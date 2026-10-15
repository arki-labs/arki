import { describe, expect, it } from 'vitest';

import { ConvergenceError, InvalidArgumentError, NumericRangeError } from './errors.js';
import { bisect, findRoot, findRoots, newton, RootConvergenceError } from './roots.js';

/** Wallis's cubic x³ − 2x − 5 (1685), the classic root-finding test; its real root to 20 digits. */
const wallis = (x: number): number => x ** 3 - 2 * x - 5;
const WALLIS_ROOT = 2.094_551_481_542_326_5;

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('findRoot (Brent)', () => {
  it("solves Wallis's cubic, and errorEstimate bounds the actual error", () => {
    const result = findRoot(wallis, [2, 3]);
    expect(Math.abs(result.root - WALLIS_ROOT)).toBeLessThanOrEqual(result.errorEstimate);
    expect(result.errorEstimate).toBeLessThanOrEqual(2e-12 + 8 * Number.EPSILON * WALLIS_ROOT);
  });

  it('reaches full float64 precision with absoluteTolerance 0', () => {
    const { root } = findRoot(wallis, [2, 3], { absoluteTolerance: 0 });
    expect(Math.abs(root - WALLIS_ROOT)).toBeLessThanOrEqual(2 * Number.EPSILON * WALLIS_ROOT);
  });

  it('beats bisection by interpolating (that is the point of Brent over bisect)', () => {
    const brent = findRoot(wallis, [2, 3]);
    const halving = bisect(wallis, [2, 3]);
    expect(brent.iterations).toBeLessThanOrEqual(10);
    expect(halving.iterations).toBeGreaterThanOrEqual(38);
  });

  it('degrades to about bisection speed on a jump, but still terminates inside the bracket', () => {
    // Interpolation is useless on a step function; Brent's bisection fallback keeps the guarantee.
    const step = (x: number): number => (x < 1 / 3 ? -1 : 1);
    const result = findRoot(step, [0, 1]);
    expect(Math.abs(result.root - 1 / 3)).toBeLessThanOrEqual(result.errorEstimate);
    expect(result.iterations).toBeLessThanOrEqual(2 * 40);
  });

  it('finds the root of tan(x) − x between the poles at π and 3π/2', () => {
    const result = findRoot(x => Math.tan(x) - x, [4, 4.6]);
    expect(Math.abs(result.root - 4.493_409_457_909_064)).toBeLessThanOrEqual(result.errorEstimate);
  });

  it('converges to a pole when the sign change is a pole: the documented reason to check |f(root)|', () => {
    const { root } = findRoot(Math.tan, [1, 2]);
    expect(root).toBeCloseTo(Math.PI / 2, 10);
    expect(Math.abs(Math.tan(root))).toBeGreaterThan(1e9);
  });

  it('returns an exact zero with errorEstimate 0 and never -0', () => {
    const result = findRoot(x => x, [-1, 1]);
    expect(Object.is(result.root, 0)).toBe(true);
    expect(result.errorEstimate).toBe(0);
    expect(findRoot(x => x - 2, [2, 3]).root).toBe(2);
  });

  it('refuses a double root: (x − 1)² touches zero without a sign change', () => {
    const square = (x: number): number => (x - 1) * (x - 1);
    expect(() => findRoot(square, [0, 2])).toThrow(InvalidArgumentError);
    expect(() => bisect(square, [0, 2])).toThrow(/even multiplicity/);
  });

  it('throws RootConvergenceError with the current bracket when maxIterations runs out', () => {
    const error = caught(() => findRoot(wallis, [2, 3], { maxIterations: 2 }));
    expect(error).toBeInstanceOf(RootConvergenceError);
    expect(error).toBeInstanceOf(ConvergenceError);
    const { best } = error as RootConvergenceError;
    expect(Math.abs(best.root - WALLIS_ROOT)).toBeLessThanOrEqual(best.errorEstimate);
  });

  it('turns NaN or ±Infinity from f into NumericRangeError instead of a NaN root', () => {
    expect(() => findRoot(Math.log, [0, 2])).toThrow(NumericRangeError);
    expect(() => findRoot(x => Math.sqrt(x) - 1, [-1, 4])).toThrow(/f\(-1\) is NaN/);
  });

  it('validates the bracket and options', () => {
    expect(() => findRoot(wallis, [3, 2])).toThrow(InvalidArgumentError);
    expect(() => findRoot(wallis, [2, 2])).toThrow(InvalidArgumentError);
    expect(() => findRoot(wallis, [Number.NaN, 3])).toThrow(InvalidArgumentError);
    expect(() => findRoot(wallis, [-Infinity, 3])).toThrow(InvalidArgumentError);
    expect(() => findRoot(wallis, [2, 3], { absoluteTolerance: -1 })).toThrow(InvalidArgumentError);
    expect(() => findRoot(wallis, [2, 3], { maxIterations: 0.5 })).toThrow(InvalidArgumentError);
  });
});

describe('bisect', () => {
  it('halves the bracket each step, so the error bound is exact', () => {
    const result = bisect(wallis, [2, 3]);
    expect(Math.abs(result.root - WALLIS_ROOT)).toBeLessThanOrEqual(result.errorEstimate);
    // ceil(log2(1 / 2e-12)) = 39 halvings, give or take the relative part.
    expect(result.iterations).toBeGreaterThanOrEqual(38);
    expect(result.iterations).toBeLessThanOrEqual(40);
  });

  it('stops at adjacent floats when asked for zero tolerance', () => {
    const result = bisect(x => x * x - 2, [1, 2], { absoluteTolerance: 0, relativeTolerance: 0 });
    expect(Math.abs(result.root - Math.SQRT2)).toBeLessThanOrEqual(result.errorEstimate);
    expect(result.errorEstimate).toBeLessThanOrEqual(2 * Number.EPSILON);
  });
});

describe('newton', () => {
  it('converges quadratically near a simple root', () => {
    const result = newton(
      x => x * x - 2,
      x => 2 * x,
      1,
    );
    expect(result.root).toBe(Math.SQRT2);
    expect(result.iterations).toBeLessThanOrEqual(6);
  });

  it("solves Wallis's cubic from Newton's own starting point", () => {
    const result = newton(wallis, x => 3 * x * x - 2, 2);
    expect(Math.abs(result.root - WALLIS_ROOT)).toBeLessThanOrEqual(4 * Number.EPSILON);
  });

  it('reaches a double root that no bracketed method can, with an honest error estimate', () => {
    const result = newton(
      x => (x - 1) * (x - 1),
      x => 2 * (x - 1),
      2,
    );
    // Linear convergence at a double root: the last step still over-estimates the remaining error.
    expect(Math.abs(result.root - 1)).toBeLessThanOrEqual(result.errorEstimate);
    expect(Math.abs(result.root - 1)).toBeLessThan(1e-11);
  });

  it('damps the overshoot that makes plain Newton diverge on atan from 1.5', () => {
    // Plain Newton: x ← x − atan(x)(1 + x²) runs away from 1.5 (1.5 → −1.69 → 2.32 → …).
    let plain = 1.5;
    for (let i = 0; i < 3; i++) plain -= Math.atan(plain) * (1 + plain * plain);
    expect(Math.abs(plain)).toBeGreaterThan(5);
    const result = newton(Math.atan, x => 1 / (1 + x * x), 1.5);
    expect(Math.abs(result.root)).toBeLessThan(1e-12);
  });

  it('catches divergence to an asymptote instead of returning a fake root', () => {
    // x·e^(−x) → 0 as x → ∞ with no root there; Newton from 2 marches off toward infinity.
    const error = caught(() =>
      newton(
        x => x * Math.exp(-x),
        x => (1 - x) * Math.exp(-x),
        2,
      ),
    );
    expect(error).toBeInstanceOf(RootConvergenceError);
    expect((error as RootConvergenceError).best.root).toBeGreaterThan(100);
  });

  it('reports a local minimum of |f| that is not a root', () => {
    expect(() =>
      newton(
        x => x * x + 1,
        x => 2 * x,
        0.5,
      ),
    ).toThrow(RootConvergenceError);
  });

  it('throws on a zero derivative unless a bracket allows bisection', () => {
    const f = (x: number): number => x * x - 1;
    const df = (x: number): number => 2 * x;
    expect(() => newton(f, df, 0)).toThrow(/f'\(x\) = 0/);
    const result = newton(f, df, 0, { bracket: [-0.5, 2] });
    expect(Math.abs(result.root - 1)).toBeLessThanOrEqual(result.errorEstimate);
  });

  it('keeps a bracketed Newton inside the bracket where plain Newton would leave it', () => {
    // From x0 = 0.9 the tangent of x³ − 2x − 5 points far outside [0, 3]; rtsafe bisects instead.
    const result = newton(wallis, x => 3 * x * x - 2, 0.9, { bracket: [0, 3] });
    expect(Math.abs(result.root - WALLIS_ROOT)).toBeLessThanOrEqual(result.errorEstimate);
    expect(() => newton(wallis, x => 3 * x * x - 2, 4, { bracket: [0, 3] })).toThrow(InvalidArgumentError);
  });

  it('rejects a non-finite start and a non-finite derivative', () => {
    expect(() => newton(wallis, () => 1, Number.NaN)).toThrow(InvalidArgumentError);
    expect(() => newton(wallis, () => Number.NaN, 2)).toThrow(/df\(2\) is NaN/);
  });
});

describe('findRoots', () => {
  it('finds every sign change of sin on [−1, 10]', () => {
    const roots = findRoots(Math.sin, [-1, 10]).map(r => r.root);
    expect(roots).toHaveLength(4);
    for (const [k, root] of roots.entries()) expect(Math.abs(root - k * Math.PI)).toBeLessThan(1e-11);
  });

  it('reports poles as roots too, so the caller filters by |f(root)|', () => {
    const f = (x: number): number => Math.tan(x) - x;
    const all = findRoots(f, [4, 11]);
    const roots = all.filter(r => Math.abs(f(r.root)) < 1e-6).map(r => r.root);
    expect(all.length).toBeGreaterThan(roots.length);
    expect(roots).toHaveLength(3);
    expect(roots[0]).toBeCloseTo(4.493_409_457_909_064, 11);
    expect(roots[1]).toBeCloseTo(7.725_251_836_937_707, 11);
    expect(roots[2]).toBeCloseTo(10.904_121_659_428_899, 11);
  });

  it('misses a double root, as documented', () => {
    const roots = findRoots(x => (x - 1) * (x - 1) * (x - 3), [0, 4.1]).map(r => r.root);
    expect(roots).toHaveLength(1);
    expect(roots[0]).toBeCloseTo(3, 11);
  });

  it('misses two roots inside one grid cell unless samples is raised', () => {
    const f = (x: number): number => (x - 0.52) * (x - 0.521);
    expect(findRoots(f, [0, 1], { samples: 10 })).toHaveLength(0);
    expect(findRoots(f, [0, 1], { samples: 10_000 })).toHaveLength(2);
  });

  // An equation solver scans a wide interval before it knows the function's domain.
  // One point with no value (sqrt of a negative, log of 0, a pole) must not lose
  // the roots elsewhere; it is a gap, never a sign change.
  it('skips grid points where f has no finite value and keeps scanning', () => {
    const sqrtMinus3 = (x: number): number => {
      if (x < 0) throw new InvalidArgumentError('sqrt of a negative number');
      return Math.sqrt(x) - 3;
    };
    expect(findRoots(sqrtMinus3, [-10, 10]).map(r => r.root)).toEqual([9]);
    const roots = findRoots(x => Math.log(x) - 1, [-1, 5]).map(r => r.root);
    expect(roots).toHaveLength(1);
    expect(roots[0]).toBeCloseTo(Math.E, 12);
  });

  it('never brackets across a gap, so a NaN neighbour is not a sign change', () => {
    expect(findRoots(x => (x < 0.5 ? Number.NaN : 1), [0, 1], { samples: 10 })).toHaveLength(0);
  });
});
