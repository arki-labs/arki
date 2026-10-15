/**
 * Hostile inputs (RFC §12, §13): every budget breaks with a `CasLimitError`
 * before the expensive work, never a hang or a `RangeError`, and each case
 * finishes well inside 100 ms.
 */
import { describe, expect, it } from 'vitest';

import { parse, ParseError } from '@arki/expr';

import { CasLimitError } from './index.js';
import { expand, gcd, polynomialIn } from './polynomial.js';
import { simplify } from './simplify.js';

function budgetOf(run: () => unknown): string {
  const started = Date.now();
  try {
    run();
    return 'none';
  } catch (error) {
    if (Date.now() - started > 100) return 'too slow';
    if (error instanceof CasLimitError) return error.budget;
    if (error instanceof ParseError) return `parse:${error.code}`;
    throw error;
  }
}

describe('budgets break before the work', () => {
  it.each([
    ['(x+1)^10000', 'degree'],
    ['x^(10^9)', 'degree'],
    ['2^(10^9)', 'digits'],
    ['1e100000 * x', 'digits'],
    ['(x + y + pi + e + 1)^40', 'terms'],
  ])('%s → %s', (text, budget) => {
    expect(budgetOf(() => expand(text))).toBe(budget);
  });

  it('checks the depth of a hand-built AST without recursion', () => {
    const deep = parse(`${'('.repeat(400)}x${')'.repeat(400)}`, { limits: { depth: 1000 } });
    expect(budgetOf(() => polynomialIn(deep, 'x'))).toBe('depth');
  });

  it('checks the node count of the input and of the output before printing', () => {
    const wide = parse(Array.from({ length: 3000 }, (_, i) => `x^${i}`).join(' + '), {
      limits: { length: 100_000, tokens: 100_000, nodes: 100_000, depth: 5000 },
    });
    expect(budgetOf(() => expand(wide, { limits: { depth: 10_000 } }))).toBe('nodes');
    expect(budgetOf(() => expand('(x + y + 1)^30', { limits: { nodes: 2000 } }))).toBe('nodes');
  });

  it('counts arithmetic as fuel', () => {
    expect(budgetOf(() => expand('(x + y + 1)^12', { limits: { fuel: 1000 } }))).toBe('fuel');
  });

  it('bounds gcd by its own degree budget', () => {
    expect(budgetOf(() => gcd('x^100 - 1', 'x^50 - 1'))).toBe('gcdDegree');
  });

  it('stops when the signal is aborted, with the host reason', () => {
    const reason = new Error('stop');
    expect(() => expand('x + 1', { signal: { aborted: true, reason } })).toThrow(reason);
  });

  it('validates limits', () => {
    expect(() => expand('x', { limits: { nodes: 0 } })).toThrow(/positive integer/);
  });
});

/** `f` applied n times, innermost first: nest(s => `sin(${s})`, 2) is `sin(sin(x))`. */
function nest(f: (s: string) => string, n: number): string {
  let s = 'x';
  for (let i = 0; i < n; i++) s = f(s);
  return s;
}

describe('simplify under hostile input: rewriting has no static bound, so budgets and fuel stop it', () => {
  it.each([
    // Expression swell through the normal form: the same budgets as expand, before the work.
    ['(x+1)^10000', 'degree'],
    ['(x + y + pi + e + 1)^40', 'terms'],
    ['sqrt(x)^100000', 'degree'],
    ['abs(x)^500/x^500', 'gcdDegree'],
  ])('%s → %s', (text, budget) => {
    expect(budgetOf(() => simplify(text))).toBe(budget);
  });

  it('counts rewriting as fuel and checks the signal', () => {
    expect(
      budgetOf(() =>
        simplify(
          nest(s => `exp(ln(${s}))`, 40),
          { limits: { fuel: 200 } },
        ),
      ),
    ).toBe('fuel');
    const reason = new Error('stop');
    expect(() => simplify('sin(-x)', { signal: { aborted: true, reason } })).toThrow(reason);
  });

  it.each([
    ['exp(ln(…))', nest(s => `exp(ln(${s}))`, 60), 'x', ['x > 0']],
    ['ln(exp(…))', nest(s => `ln(exp(${s}))`, 60), 'x', []],
    ['sqrt((…)^2)', nest(s => `sqrt((${s})^2)`, 40), 'abs(x)', []],
    // An even number of odd functions: the minus signs cancel.
    ['sin(-…)', nest(s => `sin(-${s})`, 60), `${'sin('.repeat(60)}x${')'.repeat(60)}`, []],
  ])(
    'deep kernel nesting (%s) resolves inside the depth budget, without deep recursion',
    (_, text, result, conditions) => {
      const started = Date.now();
      const r = simplify(text);
      expect(Date.now() - started).toBeLessThan(500);
      expect(r.result.source).toBe(result);
      expect(r.conditions.map(c => `${c.subject.source} ${c.relation}`)).toEqual(
        conditions.map(c => c.replace(' > 0', ' positive')),
      );
    },
  );
});
