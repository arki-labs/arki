import { describe, expect, it } from 'vitest';

import { orThrow } from '@arki/failure';

import { derivative, ExtrapolationConvergenceError, limit } from './differentiate.js';
import { ConvergenceError, InvalidArgumentError, NotConverged, NumericRangeError } from './errors.js';

/** The `ConvergenceError` inside a `NotConverged` result; fails the test when the call returned anything else. */
function nonConvergence(result: unknown): unknown {
  if (!NotConverged.is(result)) throw new Error('expected NotConverged');
  return result.cause;
}

/** The result is within its own error estimate of the truth, and that estimate meets the default tolerance. */
function expectWithin(result: { value: number; errorEstimate: number }, exact: number): void {
  expect(Math.abs(result.value - exact)).toBeLessThanOrEqual(result.errorEstimate);
  expect(result.errorEstimate).toBeLessThanOrEqual(Math.max(1e-10, 1e-8 * Math.abs(exact)));
}

describe('derivative (Ridders)', () => {
  it('differentiates smooth functions to about 1e-12 with an honest estimate', () => {
    expectWithin(orThrow(derivative(Math.exp, 1)), Math.E);
    expectWithin(orThrow(derivative(Math.sin, 0)), 1);
    expectWithin(orThrow(derivative(x => x ** 3, 2)), 12);
    expectWithin(orThrow(derivative(Math.atan, 1)), 0.5);
    expect(Math.abs(orThrow(derivative(Math.exp, 1)).value - Math.E)).toBeLessThan(1e-11);
  });

  it('scales the default step with |x|, so large arguments still work', () => {
    expectWithin(orThrow(derivative(Math.log, 1e10)), 1e-10);
    expectWithin(orThrow(derivative(x => Math.sqrt(x), 1e6)), 0.5e-3);
  });

  it('cannot see a kink: central differences call |x| flat at 0 (an estimate, not a proof)', () => {
    expect(orThrow(derivative(Math.abs, 0)).value).toBe(0);
  });

  it('throws when f is undefined inside [x − step, x + step]', () => {
    expect(() => orThrow(derivative(Math.sqrt, 0))).toThrow(NumericRangeError);
    expectWithin(orThrow(derivative(Math.sqrt, 0.01, { step: 0.005 })), 5);
  });

  it('returns NotConverged, caused by an ExtrapolationConvergenceError, where f oscillates too fast for the step', () => {
    const error = nonConvergence(derivative(x => Math.sin(1 / x), 0.001));
    expect(error).toBeInstanceOf(ExtrapolationConvergenceError);
    expect(error).toBeInstanceOf(ConvergenceError);
    expect(Number.isFinite((error as ExtrapolationConvergenceError).best.value)).toBe(true);
  });

  it('validates x and step', () => {
    expect(() => orThrow(derivative(Math.sin, Number.NaN))).toThrow(InvalidArgumentError);
    expect(() => orThrow(derivative(Math.sin, 0, { step: 0 }))).toThrow(InvalidArgumentError);
    expect(() => orThrow(derivative(Math.sin, 1e300, { step: 1 }))).toThrow(/too small/);
  });
});

describe('limit (Richardson)', () => {
  it('finds removable singularities without evaluating f(x0)', () => {
    const atZero = (x: number): number => {
      if (x === 0) throw new Error('f(x0) must not be evaluated');
      return Math.sin(x) / x;
    };
    expectWithin(orThrow(limit(atZero, 0)), 1);
    expectWithin(orThrow(limit(x => (x * x - 1) / (x - 1), 1)), 2);
    expectWithin(orThrow(limit(x => (1 + x) ** (1 / x), 0)), Math.E);
  });

  it('extrapolates in 1/x at infinity', () => {
    expectWithin(orThrow(limit(x => (1 + 1 / x) ** x, Infinity)), Math.E);
    expectWithin(orThrow(limit(Math.atan, Infinity)), Math.PI / 2);
    expectWithin(orThrow(limit(Math.atan, -Infinity)), -Math.PI / 2);
  });

  it('refuses a two-sided limit at a jump, but gives each one-sided limit', () => {
    const sign = (x: number): number => (x > 0 ? 1 : -1);
    expect(nonConvergence(limit(sign, 0))).toBeInstanceOf(ExtrapolationConvergenceError);
    expect(orThrow(limit(sign, 0, { side: 'right' })).value).toBe(1);
    expect(orThrow(limit(sign, 0, { side: 'left' })).value).toBe(-1);
  });

  it('does not invent a value for a limit that diverges', () => {
    expect(nonConvergence(limit(x => 1 / x, 0, { side: 'right' }))).toBeInstanceOf(ExtrapolationConvergenceError);
  });

  it('validates side, especially at infinity', () => {
    expect(() => orThrow(limit(Math.atan, Infinity, { side: 'right' }))).toThrow(InvalidArgumentError);
    expect(() => orThrow(limit(Math.atan, Number.NaN))).toThrow(InvalidArgumentError);
  });
});
