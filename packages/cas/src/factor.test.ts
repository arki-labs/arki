/**
 * `factor` (RFC §8.2): the content and factor conventions, the incomplete
 * case for coefficients in other names, errors, and each factoring budget.
 * Exact agreement with SymPy is in `factor.reference.test.ts`; random
 * products in `factor.property.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { parse } from '@arki/expr';

import fixture from '../test/reference/fixtures/factor.json' with { type: 'json' };
import { CasLimitError } from './core.js';
import { exactRoots, factor, polynomialIn } from './polynomial.js';
import { fastest } from './test-support.js';

function shown(input: string, options = {}): string {
  const f = factor(input, 'x', options);
  const factors = f.factors.map(
    ({ factor: p, multiplicity }) => `(${p.source})${multiplicity > 1 ? `^${multiplicity}` : ''}`,
  );
  return `${f.content.source} * ${factors.join(' ')}${f.complete ? '' : ' [incomplete]'}`;
}

const S4 =
  fixture.cases
    .find(c => c.name === 'Swinnerton-Dyer S_4')
    ?.input.map((c, k) => `(${c})*x^${k}`)
    .join(' + ') ?? '';

describe('factor', () => {
  it.each([
    ['x^4 - 5x^2 + 4', '1 * (x + 1) (x + 2) (x - 1) (x - 2)'],
    // The content takes the sign and the denominators; each factor has a positive leading coefficient.
    ['2x^3 - 2x', '2 * (x) (x + 1) (x - 1)'],
    ['1 - x^2', '-1 * (x + 1) (x - 1)'],
    ['x^2/2 - 1/8', '1 / 8 * (2 * x + 1) (2 * x - 1)'],
    ['(x - 1)^3 * (x^2 + x + 1)^2', '1 * (x - 1)^3 (x^2 + x + 1)^2'],
    // Irreducible over ℚ although it splits mod every prime.
    ['x^4 + 1', '1 * (x^4 + 1)'],
    ['x^8 + 98x^4 + 1', '1 * (x^4 + 4 * x^3 + 8 * x^2 - 4 * x + 1) (x^4 - 4 * x^3 + 8 * x^2 + 4 * x + 1)'],
    ['7', '7 * '],
    ['y^2 + 1', 'y^2 + 1 * '],
  ])('%s = %s', (input, expected) => {
    expect(shown(input)).toBe(expected);
  });

  it('other names, π and e: the content holds them; a part with rational coefficients still factors completely', () => {
    expect(shown('y*x^2 - y')).toBe('y * (x + 1) (x - 1)');
    expect(shown('pi*x^2 - pi')).toBe('pi * (x + 1) (x - 1)');
    // x^2 - y has no multivariate factoring in v1: it stays whole and the result says so.
    expect(shown('x^2 - y')).toBe('1 * (x^2 - y) [incomplete]');
  });

  it('a part of degree 1 in the variable is irreducible, whatever its coefficients: the result is complete', () => {
    // The parts come from the primitive part, so a linear one has no factor in y left to split off.
    expect(shown('x^2 + 2*x*y + y^2')).toBe('1 * (x + y)^2');
    expect(shown('y*x + y^2')).toBe('y * (x + y)');
  });

  it('returns the restrictions the factored form no longer shows', () => {
    const f = factor('x/x * (x^2 - 1)', 'x');
    expect(f.conditions.map(c => `${c.subject.source} ${c.relation}`)).toEqual(['x nonzero']);
  });

  it('refuses what is not a polynomial in the variable', () => {
    // A CasError with the span of the offending part, as every verb reports what it cannot take.
    expect(() => factor('sin(x) + 1', 'x')).toThrow(
      expect.objectContaining({ code: 'not-polynomial', span: { start: 0, end: 6 } }),
    );
    expect(() => factor('1/x + 1', 'x')).toThrow(
      expect.objectContaining({ code: 'not-polynomial', span: { start: 2, end: 3 } }),
    );
    expect(() => factor('x^2 + x^-2', 'x')).toThrow(
      expect.objectContaining({ code: 'not-polynomial', span: { start: 6, end: 10 } }),
    );
    expect(() => factor('x^2', 'pi')).toThrow(expect.objectContaining({ code: 'bad-variable' }));
  });

  it('refuses a constant it cannot zero-test, with its span: sqrt(2)^2 - 2 is 0, but not as a free symbol', () => {
    // Treated as a symbol, sqrt(2) would make 0 look like the degree-1 product (sqrt(2)^2 - 2) * x.
    expect(() => factor('sqrt(2)^2*x - 2*x', 'x')).toThrow(
      expect.objectContaining({ code: 'unsupported-constant', span: { start: 0, end: 7 } }),
    );
    expect(() => factor('ln(2)*x^2 - 1', 'x')).toThrow(expect.objectContaining({ code: 'unsupported-constant' }));
    // Names, π, e and functions of other names have no hidden relations: they stay in the content.
    expect(shown('sin(y)*x^2 - sin(y)')).toBe('sin(y) * (x + 1) (x - 1)');
  });

  it('is reproducible: the random splitting uses a fixed seed', () => {
    expect(shown('x^60 - 1')).toBe(shown('x^60 - 1'));
  });
});

describe('factor budgets: each throws CasLimitError, never a partial answer labelled complete', () => {
  it.each([
    ['factorDegree', 'x^129 + x + 1', { factorDegree: 128 }],
    ['factorDigits', `x^2 + ${'9'.repeat(301)}`, {}],
    ['liftDigits', 'x^4 + 1', { liftDigits: 1 }],
    ['recombination', S4, { recombination: 10 }],
  ])('%s', (budget, input, limits) => {
    expect(() => factor(input, 'x', { limits })).toThrow(CasLimitError);
    expect(() => factor(input, 'x', { limits })).toThrow(expect.objectContaining({ budget }));
  });

  it('a degree-128 polynomial with 300-digit coefficients ends within 1 s, with a result or a CasLimitError', () => {
    let seed = 7;
    const digit = (): number => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) % 10;
    const coefficient = (): string => `${1 + (digit() % 9)}${Array.from({ length: 299 }, digit).join('')}`;
    const input = parse(
      Array.from({ length: 129 }, (_, k) => `(${k % 3 === 0 ? '-' : ''}${coefficient()})*x^${k}`).join(' + '),
      { limits: { length: 100_000, tokens: 100_000, nodes: 10_000 } },
    );
    const timed = fastest(() => factor(input, 'x', { limits: { nodes: 10_000 } }), 1000);
    expect(timed.ms).toBeLessThan(1000);
    if (!timed.ok) expect(timed.error).toBeInstanceOf(CasLimitError);
  });

  it('exactRoots falls back to the square-free part when factoring runs out of budget', () => {
    const form = polynomialIn(S4, 'x', { limits: { recombination: 10 } });
    if (form.kind !== 'polynomial') throw new Error('S_4 is a polynomial');
    const result = exactRoots(form, { limits: { recombination: 10 } });
    expect(result.exact).toBe(false);
    expect(result.numeric.map(n => n.coefficients.length - 1)).toEqual([16]);
  });
});
