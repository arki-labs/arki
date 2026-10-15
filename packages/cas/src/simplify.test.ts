/**
 * `simplify` (RFC §7) and its conditions (RFC §6), rule by rule.
 *
 * Each row of the rule table gets a test that shows what the rule does and
 * which condition it must return. The conditions matter because a caller
 * (an equation solver, a derivative calculator) shows them to the
 * user: a result that silently drops `x ≠ 0` would claim `x/x = 1` at 0.
 */
import { describe, expect, it } from 'vitest';

import { parse } from '@arki/expr';
import { InvalidArgumentError } from '@arki/math/errors';

import type { Assumptions } from './index.js';
import { Context } from './context.js';
import { CasError, conditionToLatex } from './index.js';
import { expand } from './polynomial.js';
import { inputExpr, read } from './read.js';
import { holds, SignOracle } from './sign.js';
import { simplify } from './simplify.js';

function run(text: string, assume?: Assumptions): { result: string; conditions: string[]; applied: readonly string[] } {
  const r = simplify(text, assume === undefined ? {} : { assume });
  return {
    result: r.result.source,
    conditions: r.conditions.map(c => `${conditionToLatex(c)}${c.reason === 'assumed' ? ' (assumed)' : ''}`),
    applied: r.applied,
  };
}

describe('RFC §6: the required examples', () => {
  it.each([
    // A lost restriction comes back: the input is undefined there, the result is not.
    ['x/x', '1', ['x \\neq 0']],
    ['(x^2 - 1)/(x - 1)', 'x + 1', ['x - 1 \\neq 0']],
    // Over ℝ, sqrt(x^2) is |x| for every x: nothing is lost, nothing is assumed.
    ['sqrt(x^2)', 'abs(x)', []],
    ['sqrt(x)^2', 'x', ['x \\geq 0']],
    ['exp(ln(x))', 'x', ['x > 0']],
    // Over ℝ this holds for every x; over ℂ it would not, which is why v1 is real-only.
    ['ln(exp(x))', 'x', []],
    ['0*ln(x)', '0', ['x > 0']],
  ])('%s → %s with %j', (input, result, conditions) => {
    const r = run(input);
    expect(r.result).toBe(result);
    expect(r.conditions).toEqual(conditions);
  });

  it('a rewrite that narrows the domain runs only under an assumption, which it returns', () => {
    expect(run('sqrt(x^2)', { x: 'nonnegative' })).toMatchObject({ result: 'x', conditions: ['x \\geq 0 (assumed)'] });
    // The assumption comes back as the caller wrote it: x < 0, not -x > 0.
    expect(run('sqrt(x^2)', { x: 'negative' })).toMatchObject({ result: '-x', conditions: ['x < 0 (assumed)'] });
    expect(run('(x^2)^(1/3)', { x: 'positive' })).toMatchObject({
      result: 'x^(2 / 3)',
      conditions: ['x > 0 (assumed)'],
    });
    // Without the assumption, x^(2/3) would be wrong for x < 0, where the input is defined.
    expect(run('(x^2)^(1/3)').result).toBe('(x^2)^(1 / 3)');
  });

  it('an assumption the rewrite did not need is not listed', () => {
    expect(run('sqrt(x^2) + y', { y: 'positive' }).conditions).toEqual([]);
    // x^2 + 1 > 0 is proven from the expression: it is a fact, not a condition.
    expect(run('abs(x^2 + 1)', { x: 'positive' })).toMatchObject({ result: 'x^2 + 1', conditions: [] });
  });

  it('a restriction the result still shows is not repeated (pruning)', () => {
    // ln(x) still needs x > 0, which implies the lost x ≠ 0.
    expect(run('ln(x) + x/x').conditions).toEqual([]);
    expect(run('1/(x - 1) + (x - 1)/(x - 1)').conditions).toEqual([]);
    expect(run('sqrt(x) * sqrt(x)^2').result).toBe('x * sqrt(x)');
    expect(run('sqrt(x) * sqrt(x)^2').conditions).toEqual([]);
  });

  it('a restriction proven from the expression is not a condition', () => {
    expect(run('(x^2 + 1)/(x^2 + 1)').conditions).toEqual([]);
    expect(run('sqrt(x^2 + 1)^2').conditions).toEqual([]);
    expect(run('sqrt(x^2 - 2*x + 1)')).toMatchObject({ result: 'abs(x - 1)', conditions: [] });
  });

  it('dropped kernels keep their restrictions, in every verb', () => {
    expect(run('tan(x) - tan(x)').conditions).toEqual(['\\cos\\left(x\\right) \\neq 0']);
    expect(run('0*sqrt(x - 1)').conditions).toEqual(['x - 1 \\geq 0']);
    expect(run('0*asin(x)').conditions).toEqual(['-x^{2} + 1 \\geq 0']);
    // expand drops the term too, so it returns the restriction as well (a step-1 gap, now closed).
    expect(expand('0*ln(x) + 1').conditions.map(c => conditionToLatex(c))).toEqual(['x > 0']);
  });
});

describe('the rule table (RFC §7)', () => {
  it.each([
    ['fold', '2 + 3 + x*1 + 0', 'x + 5'],
    ['expand', '(x + 1)^2', 'x^2 + 2 * x + 1'],
    ['collect', 'x*x + x + x', 'x^2 + 2 * x'],
    ['cancel', '(x^2 - 1)/(x + 1)', 'x - 1'],
    ['integer-powers', '(x^(1/3))^3', 'x'],
    ['square-of-sqrt', '(x^(1/2))^2', 'x'],
    ['square-of-sqrt', 'x/sqrt(x)', 'sqrt(x)'],
    ['square-of-sqrt', 'x^(5/2)', 'x^2 * sqrt(x)'],
    ['sqrt-of-square', '(x^2)^(1/2)', 'abs(x)'],
    ['square-of-sqrt', 'sqrt(x + 1)^3', 'sqrt(x + 1) * (x + 1)'],
    ['square-of-sqrt', 'cbrt(x)^3', 'x'],
    ['square-of-sqrt', 'nthRoot(x, 4)^4', 'x'],
    ['sqrt-of-square', 'sqrt(4*x^2)', '2 * abs(x)'],
    ['sqrt-of-square', 'sqrt(x^2/(y^2 + 2*y + 1))', 'abs(x / (y + 1))'],
    ['exp-ln', 'exp(ln(x + 1))', 'x + 1'],
    ['exp-ln', 'e^ln(x)', 'x'],
    ['ln-exp', 'ln(exp(x^2))', 'x^2'],
    ['ln-exp', 'ln(e^3)', '3'],
    ['exp-product', 'exp(x)*exp(y)', 'exp(x + y)'],
    ['exp-product', 'exp(x)^3', 'exp(3 * x)'],
    ['exp-product', 'exp(2*x)/exp(x)', 'exp(x)'],
    ['exp-product', '(e^x)^(1/2)', 'exp(x / 2)'],
    ['exp-product', 'exp(x + 1)*exp(-x)', 'e'],
    ['abs-sign', 'abs(x)/x', 'sign(x)'],
    ['abs-sign', 'x/abs(x)', 'sign(x)'],
    ['abs-sign', 'abs(exp(x))', 'exp(x)'],
    ['abs-sign', 'abs(pi - 4)', '-pi + 4'],
    ['parity', 'sin(-x)', '-sin(x)'],
    ['parity', 'cos(1 - x)', 'cos(x - 1)'],
    ['parity', 'abs(-x)', 'abs(x)'],
    // expr defines acot, acsc, acsch and acoth through 1/u, so they are odd.
    ['parity', 'acot(-x)', '-acot(x)'],
    ['parity', 'acoth(-x)', '-acoth(x)'],
    ['special-values', 'sin(0) + cos(0) + tan(0) + exp(0) + ln(1) + ln(e)', '3'],
    ['special-values', 'sqrt(4/9) + abs(-1/2)', '7 / 6'],
    ['factor-out', 'exp(x)*cos(x) - exp(x)*sin(x)', 'exp(x) * (cos(x) - sin(x))'],
  ])('%s: %s → %s', (rule, input, result) => {
    const r = simplify(input);
    expect(r.result.source).toBe(result);
    expect(r.applied).toContain(rule);
  });

  it('abs(u)/u → sign(u) returns u ≠ 0: sign(0) is 0, where the input is undefined', () => {
    expect(run('abs(x)/x').conditions).toEqual(['x \\neq 0']);
    expect(run('x/abs(x)').conditions).toEqual(['x \\neq 0']);
  });

  it('fractional powers combine only for a base proven or assumed positive', () => {
    expect(run('x^(1/2)*x^(1/3)').result).toBe('x^(1 / 3) * sqrt(x)');
    expect(run('x^(1/2)*x^(1/3)', { x: 'positive' })).toMatchObject({
      result: 'x^(5 / 6)',
      conditions: ['x > 0 (assumed)'],
    });
    expect(run('exp(x)^(1/2)*exp(x)^(1/2)').result).toBe('exp(x)');
  });

  it('anything outside the table is left alone', () => {
    for (const text of [
      'sin(x)^2 + cos(x)^2',
      'ln(x*y)',
      'sqrt(8)',
      'sqrt(2*x^2)',
      'abs(x)^2',
      'tan(x)*cos(x)',
      'exp(x + ln(y))',
    ]) {
      expect(simplify(text).result.source).toBe(expand(text).result.source);
    }
  });

  it('applied lists only what changed something, in table order', () => {
    expect(simplify('x').applied).toEqual([]);
    expect(simplify('sin(x)').applied).toEqual([]);
    expect(simplify('exp(ln(x)) + x/x').applied).toEqual(['cancel', 'exp-ln']);
  });
});

describe('the readable normal form (RFC §5.4)', () => {
  it('one fraction over a factored denominator, numerator expanded', () => {
    // The quotient-rule result for (x^2 + 1)/(x - 1): the shape the derivative calculator shows.
    expect(run('((2*x)*(x - 1) - (x^2 + 1))/(x - 1)^2').result).toBe('(x^2 - 2 * x - 1) / (x - 1)^2');
    expect(run('1/x + 1/(x + 1)').result).toBe('(2 * x + 1) / (x * (x + 1))');
    expect(run('1/(x^2*(x + 1)^3)').result).toBe('1 / (x^2 * (x + 1)^3)');
    expect(run('x/(2*pi*(x - 1))').result).toBe('x / (2 * pi * (x - 1))');
  });

  it('a denominator typed as one polynomial stays one polynomial', () => {
    expect(run('1/(x^2 - 1)').result).toBe('1 / (x^2 - 1)');
    // ...unless it has a repeated factor, which is shown as a power.
    expect(run('1/(x^2 - 2*x + 1)').result).toBe('1 / (x - 1)^2');
  });

  it('constant denominators are coefficients', () => {
    expect(run('(x + 1)/2').result).toBe('x / 2 + 1 / 2');
  });

  it('numbers: fraction by default, terminating decimals on request', () => {
    expect(run('0.02*x + 5').result).toBe('x / 50 + 5');
    expect(simplify('0.02*x + 5', { numbers: 'decimal' }).result.source).toBe('0.02 * x + 5');
    expect(simplify('x/3', { numbers: 'decimal' }).result.source).toBe('x / 3');
  });

  it('results are canonical expr ASTs that round-trip', () => {
    const { result } = simplify('exp(x)*cos(x) - exp(x)*sin(x) + 1/(x - 1)^2');
    expect(parse(result.source).source).toBe(result.source);
    expect(simplify(result).result.source).toBe(result.source);
  });
});

describe('assumptions', () => {
  it('rejects an unknown relation and a non-variable name', () => {
    expect(() => simplify('x', { assume: JSON.parse('{"x":"even"}') as Assumptions })).toThrow(InvalidArgumentError);
    expect(() => simplify('x', { assume: { pi: 'positive' } })).toThrow(CasError);
    expect(() => simplify('x', { assume: { sin: 'positive' } })).toThrow(CasError);
  });

  it('treats __proto__ and constructor as ordinary variables', () => {
    const assume = JSON.parse('{"__proto__":"positive","constructor":"negative"}') as Assumptions;
    expect(simplify('abs(__proto__) + abs(constructor)', { assume }).result.source).toBe('__proto__ - constructor');
  });

  it('nonzero alone proves nothing about abs, but makes x^2 positive', () => {
    expect(run('abs(x)', { x: 'nonzero' }).result).toBe('abs(x)');
    expect(run('(x^2)^(1/3)', { x: 'nonzero' }).result).toBe('(x^2)^(1 / 3)');
  });

  it('x^(k/2) and sqrt(x)^k are one value: they cancel, combine and simplify together', () => {
    expect(run('x^(1/2) - sqrt(x)').result).toBe('0');
    expect(run('sqrt(x)*x^(1/2)').result).toBe('x');
    expect(run('x^(3/2)/x', { x: 'positive' }).result).toBe('sqrt(x)');
    expect(run('x^(1/3)*x^(1/6)', { x: 'positive' }).result).toBe('sqrt(x)');
    expect(run('sqrt(exp(x))').result).toBe('exp(x / 2)');
    // x^(-1/2) * x^(1/2) needs x > 0: one condition, not x ≥ 0 and sqrt(x) ≠ 0.
    expect(run('x^(-1/2) * x^(1/2)').conditions).toEqual(['x > 0']);
  });

  it('applied lists fold when literal arithmetic changed the text, and nothing when it did not', () => {
    for (const text of ['3*x*2', 'x^2^3', '1/x^-1', '6/4', '6*x/2']) expect(run(text).applied).toContain('fold');
    for (const text of ['x/2', '2*x', '3/2', 'x/(2*y)']) expect(run(text).applied).toEqual([]);
  });

  it('log10 and log2 have the sign of their argument minus 1, as ln does', () => {
    expect(run('abs(log2(x^2 + 2))').result).toBe('log2(x^2 + 2)');
    expect(run('abs(log10(x^2 + 10))').result).toBe('log10(x^2 + 10)');
  });
});

describe('the sign oracle (RFC §6 table)', () => {
  function signsOf(text: string, assume: Assumptions = {}): string {
    const ctx = new Context({ assume });
    const value = read(inputExpr(text, ctx).root, ctx);
    const { signs } = new SignOracle(ctx, ctx.assumptions).value(value);
    return (
      (['positive', 'negative', 'nonnegative', 'nonpositive', 'nonzero'] as const).find(c => holds(signs, c)) ??
      'unknown'
    );
  }

  it.each([
    ['x', {}, 'unknown'],
    ['x', { x: 'positive' }, 'positive'],
    ['-x', { x: 'positive' }, 'negative'],
    ['x*y', { x: 'negative', y: 'negative' }, 'positive'],
    ['x/y', { x: 'positive', y: 'negative' }, 'negative'],
    ['x + y', { x: 'nonnegative', y: 'positive' }, 'positive'],
    ['x + y', { x: 'positive', y: 'negative' }, 'unknown'],
    ['pi - 3', {}, 'positive'],
    ['e - pi', {}, 'negative'],
    ['pi^2 - 9.8696', {}, 'positive'],
    ['exp(x)', {}, 'positive'],
    ['x^2', {}, 'nonnegative'],
    ['x^2', { x: 'nonzero' }, 'positive'],
    ['x^2 + 1', {}, 'positive'],
    ['x^2 - 2*x + 1', {}, 'nonnegative'],
    ['abs(x)', {}, 'nonnegative'],
    ['sqrt(x) + 1', {}, 'positive'],
    ['ln(x^2 + 2)', {}, 'positive'],
    ['sin(x)', {}, 'unknown'],
    ['-exp(x)*(y^2 + 1)', {}, 'negative'],
  ] as const)('%s with %j is %s', (text, assume, expected) => {
    expect(signsOf(text, assume)).toBe(expected);
  });

  it('decides constant signs rigorously, and says unknown past the digits budget', () => {
    // 355/113 agrees with π to 6 digits: the oracle needs more than float precision, and gets it.
    expect(signsOf('pi - 355/113')).toBe('negative');
    const ctx = new Context({ limits: { digits: 8 } });
    const value = read(inputExpr('pi - 355/113', ctx).root, ctx);
    expect(holds(new SignOracle(ctx, new Map()).value(value).signs, 'negative')).toBe(false);
  });
});
