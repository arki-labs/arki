/**
 * `derivative` and `derivation` properties (RFC §13), with fast-check.
 *
 * 1. On random smooth functions, the derivative agrees with
 *    `@arki/math/differentiate` (Ridders' extrapolation) at random points,
 *    within the oracle's own error estimate.
 * 2. Polynomial inputs: the coefficients of the derivative are exactly k·cₖ.
 * 3. Order n is order 1 applied n times to the normalized result, as values
 *    (the printed factoring of a denominator depends on what the input divided by).
 * 4. `derivation(e).result` equals `derivative(e).result`. Every derivative
 *    step is right on its own: its `after` agrees with the numeric derivative
 *    of its `before`. Each order's simplification ends at that order's
 *    result, and every template key is in `TEMPLATE_KEYS`.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Expr } from '@arki/expr';
import { parse } from '@arki/expr';
import { compile } from '@arki/expr/float';
import { isFailure, orThrow } from '@arki/failure';
import { derivative as numericDerivative } from '@arki/math/differentiate';

import type { DerivationStep } from './derivation.js';
import { CasLimitError } from './core.js';
import { TEMPLATE_KEYS } from './derivation.js';
import { derivation, derivative, polynomialIn } from './test-support.js';

/** Functions of x that are smooth on all of ℝ, so every sample point is in the domain. */
const smooth = fc.letrec<{ node: string }>(tie => ({
  node: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.constantFrom('x', 'x', '2', '-3', 'pi'),
    tie('node').map(u => `sin(${u})`),
    tie('node').map(u => `cos(${u})`),
    tie('node').map(u => `atan(${u})`),
    tie('node').map(u => `exp(sin(${u}))`),
    tie('node').map(u => `ln((${u})^2 + 1)`),
    tie('node').map(u => `sqrt((${u})^2 + 1)`),
    fc.tuple(tie('node'), fc.integer({ min: 2, max: 3 })).map(([u, k]) => `(${u})^${k}`),
    fc.tuple(tie('node'), fc.constantFrom('+', '-', '*'), tie('node')).map(([a, op, b]) => `(${a}) ${op} (${b})`),
    fc.tuple(tie('node'), tie('node')).map(([a, b]) => `(${a}) / ((${b})^2 + 1)`),
  ),
})).node;

const point = fc.double({ min: -2, max: 2, noNaN: true });

function valueOf(expr: Expr | string, x: number): number {
  const f = compile(typeof expr === 'string' ? orThrow(parse(expr)) : expr, { variables: ['x'] });
  return f({ x });
}

/** The numeric derivative, or `undefined` where Ridders cannot reach its tolerance. */
function oracle(expr: Expr | string, x: number): { value: number; error: number } | undefined {
  const f = compile(typeof expr === 'string' ? orThrow(parse(expr)) : expr, { variables: ['x'] });
  const estimate = numericDerivative(t => f({ x: t }), x);
  if (isFailure(estimate)) return undefined;
  return { value: estimate.value, error: estimate.errorEstimate };
}

/** `c₀ + c₁·x + …` as text, written term by term. */
function polynomialText(cs: readonly number[]): string {
  return cs.map((c, k) => `(${c})*x^${k}`).join(' + ');
}

function close(actual: number, expected: { value: number; error: number }): boolean {
  return Math.abs(actual - expected.value) <= 1e-6 * Math.max(1, Math.abs(expected.value)) + 100 * expected.error;
}

/** Budget errors are allowed (the fuel and terms budgets bound swell); nothing else may escape. */
function attempt<T>(run: () => T): T | undefined {
  try {
    return run();
  } catch (error) {
    if (error instanceof CasLimitError) return undefined;
    throw error;
  }
}

describe('derivative properties', () => {
  it('agrees with the numeric derivative at random points', () => {
    fc.assert(
      fc.property(smooth, point, (input, x) => {
        const result = attempt(() => derivative(input, 'x').result);
        const expected = oracle(input, x);
        if (result === undefined || expected === undefined) return;
        expect([input, x, valueOf(result, x)]).toSatisfy(() => close(valueOf(result, x), expected));
      }),
      { numRuns: 300 },
    );
  });

  it('polynomials: the coefficients of the derivative are exactly k·cₖ', () => {
    const coefficients = fc.array(fc.integer({ min: -9, max: 9 }), { minLength: 1, maxLength: 7 });
    fc.assert(
      fc.property(coefficients, coefficients, (a, b) => {
        // A product of two polynomials, so the input is not already in coefficient form.
        const input = `(${polynomialText(a)}) * (${polynomialText(b)})`;
        const form = polynomialIn(input, 'x');
        const result = polynomialIn(derivative(input, 'x').result, 'x');
        if (form.kind !== 'polynomial' || result.kind !== 'polynomial') throw new Error('not a polynomial');
        const expected = form.coefficients.slice(1).map((c, k) => c.rational?.times(k + 1).toString());
        while (expected.at(-1) === '0') expected.pop();
        expect(result.coefficients.map(c => c.rational?.toString())).toEqual(expected);
      }),
      { numRuns: 150 },
    );
  });

  it('order 2 equals order 1 applied to the normalized first derivative (as values: the printed factoring may differ)', () => {
    fc.assert(
      fc.property(smooth, point, (input, x) => {
        const second = attempt(() => derivative(input, 'x', { order: 2 }).result);
        const first = attempt(() => derivative(input, 'x').result);
        const again = first === undefined ? undefined : attempt(() => derivative(first, 'x').result);
        if (second === undefined || again === undefined) return;
        const [a, b] = [valueOf(second, x), valueOf(again, x)];
        expect([input, x, a, b]).toSatisfy(() => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)));
      }),
      { numRuns: 100 },
    );
  });
});

describe('derivation properties', () => {
  it('same result as derivative; each derivative step is right on its own; simplification ends at the result', () => {
    fc.assert(
      fc.property(smooth, point, (input, x) => {
        const steps = attempt(() => derivation(input, 'x'));
        const plain = attempt(() => derivative(input, 'x'));
        if (steps === undefined || plain === undefined) return;
        expect(steps.result.source).toBe(plain.result.source);
        const stack: [DerivationStep, DerivationStep | undefined][] = [[steps.steps, undefined]];
        for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
          const [step, parent] = item;
          expect(TEMPLATE_KEYS).toContain(step.template.key);
          for (const child of step.children) stack.push([child, step]);
          if (step.rule.kind === 'order') {
            // Without a simplification step the raw derivative is already the normal form.
            const last = step.children.at(-1);
            const end = last?.rule.kind === 'simplification' ? last.children.at(-1) : last;
            expect(end?.after.source).toBe(step.after.source);
          }
          // The first child of a chain step is the outer rule: f'(u), not a derivative with respect to x.
          const outer = parent?.rule.kind === 'derivative' && parent.rule.id === 'chain' && parent.children[0] === step;
          if (step.rule.kind !== 'derivative' || outer) continue;
          const expected = oracle(step.before, x);
          if (expected === undefined) continue;
          expect([input, step.template.key, step.before.source, step.after.source]).toSatisfy(() =>
            close(valueOf(step.after, x), expected),
          );
        }
      }),
      { numRuns: 200 },
    );
  });
});
