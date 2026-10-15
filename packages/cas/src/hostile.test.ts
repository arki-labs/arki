/**
 * Hostile inputs (RFC §12, §13): every budget breaks with a `CasLimitError`
 * before the expensive work, never a hang or a `RangeError`, and each case
 * finishes well inside 100 ms.
 */
import { describe, expect, it } from 'vitest';

import { parse } from '@arki/expr';
import { ParseError } from '@arki/expr';

import { CasLimitError } from './index.js';
import { expand, gcd, polynomialIn } from './polynomial.js';

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
