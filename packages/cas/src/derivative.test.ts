/**
 * `derivative` and `derivation` (RFC §9): exact results for the Ekuation
 * corpus (S-01 to S-06), conditions, errors and budgets. Numeric agreement on
 * random inputs is in `derivative.property.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '@arki/math/errors';

import type { DerivationStep } from './derivation.js';
import { CasLimitError } from './core.js';
import { derivation, ruleFormula, TEMPLATE_KEYS } from './derivation.js';
import { derivative } from './derivative.js';

const d = (input: string, variable = 'x', options = {}): string => derivative(input, variable, options).result.source;

function conditionsOf(input: string, variable = 'x'): string[] {
  return derivative(input, variable).conditions.map(c => `${c.subject.source} ${c.relation} (${c.reason})`);
}

function walk(step: DerivationStep, visit: (step: DerivationStep, parent: DerivationStep | undefined) => void): void {
  const stack: [DerivationStep, DerivationStep | undefined][] = [[step, undefined]];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    visit(...item);
    for (const child of item[0].children.toReversed()) stack.push([child, item[0]]);
  }
}

describe('derivative: the Ekuation corpus', () => {
  it.each([
    ['x^3 - 2*x^2 + x', '3 * x^2 - 4 * x + 1'],
    ['x^4', '4 * x^3'],
    ['3*x^2', '6 * x'],
    ['x^2 + x', '2 * x + 1'],
    ['x * sin(x)', 'x * cos(x) + sin(x)'],
    ['(x + 1) / x', '-1 / x^2'],
    ['sin(x^2)', '2 * x * cos(x^2)'],
    ['exp(2*x)', '2 * exp(2 * x)'],
    ['exp(x)', 'exp(x)'],
    ['log(x)', '1 / x'],
    // S-06: exactly `cos(x)`, not `cos(x) * 1`.
    ['sin(x)', 'cos(x)'],
    ['cos(x)', '-sin(x)'],
    ['tan(x)', 'sec(x)^2'],
    ['2^x', '2^x * ln(2)'],
    ['x^x', 'x^x * (ln(x) + 1)'],
    ['5', '0'],
  ])('d/dx %s = %s', (input, expected) => {
    expect(d(input)).toBe(expected);
  });

  it('higher orders fold constants to 6, 0 and 120 (S-06), normalizing between orders', () => {
    expect(d('x^3', 'x', { order: 3 })).toBe('6');
    expect(d('x^3', 'x', { order: 4 })).toBe('0');
    expect(d('x^5', 'x', { order: 5 })).toBe('120');
    expect(d('sin(x)', 'x', { order: 2 })).toBe('-sin(x)');
    expect(d('exp(x)*cos(x)', 'x', { order: 5 })).toBe('exp(x) * (-4 * cos(x) + 4 * sin(x))');
    expect(d('(x^2 + 1)/(x - 1)', 'x', { order: 3 })).toBe('-12 / (x - 1)^4');
  });

  it('S-01: other names are constants (a partial derivative)', () => {
    expect(d('x^2 + y^2', 'y')).toBe('2 * y');
    expect(d('x^2 * y', 'y')).toBe('x^2');
    expect(d('x^2 * y + y^3 * sin(x)', 'x')).toBe('2 * x * y + y^3 * cos(x)');
  });

  it("S-06: decimal input keeps decimals with numbers: 'decimal', fractions by default", () => {
    expect(d('0.01*x^2 + 5*x + 100', 'x', { numbers: 'decimal' })).toBe('0.02 * x + 5');
    expect(d('0.01*x^2 + 5*x + 100')).toBe('x / 50 + 5');
  });

  it('simplify: false returns the raw derivative, fold applied only', () => {
    expect(d('sin(x^2)', 'x', { simplify: false })).toBe('cos(x^2) * (2 * x)');
    expect(d('x*1 + 0', 'x', { simplify: false })).toBe('1');
  });
});

describe('derivative: conditions', () => {
  it('returns the input restrictions the derivative no longer shows: d/dx ln(x) = 1/x only for x > 0', () => {
    expect(conditionsOf('ln(x)')).toEqual(['x positive (domain)']);
    expect(conditionsOf('acosh(x)')).toEqual(['x - 1 nonnegative (domain)']);
  });

  it('a restriction the result still shows is not repeated', () => {
    expect(conditionsOf('sqrt(x)')).toEqual([]);
    expect(conditionsOf('1/x')).toEqual([]);
  });

  it('abs(u) has no derivative where u = 0: reason differentiable, unless the oracle proves u ≠ 0', () => {
    expect(conditionsOf('abs(x)')).toEqual(['x nonzero (differentiable)']);
    expect(conditionsOf('abs(2*x - 2)')).toEqual(['x - 1 nonzero (differentiable)']);
    expect(conditionsOf('abs(x^2 + 1)')).toEqual([]);
  });
});

describe('derivative: errors and budgets', () => {
  it('S-03: jump functions throw not-differentiable with the span of the call', () => {
    for (const fn of ['floor', 'ceil', 'round', 'fix', 'sign']) {
      expect(() => derivative(`1 + ${fn}(x)`, 'x')).toThrow(
        expect.objectContaining({ code: 'not-differentiable', span: { start: 4, end: 7 + fn.length } }),
      );
    }
  });

  it('S-03: gamma, factorial and host functions of the variable are unsupported; of a constant they are 0', () => {
    for (const input of ['gamma(x)', 'factorial(x)', 'x!']) {
      expect(() => derivative(input, 'x')).toThrow(expect.objectContaining({ code: 'unsupported-function' }));
    }
    expect(d('gamma(y) + x')).toBe('1');
  });

  it('an error found in a later order has no span: it points into cas output, not the input', () => {
    // d/dx abs(x) = sign(x), and sign has no derivative at 0.
    expect(() => derivative('abs(x)', 'x', { order: 2 })).toThrow(
      expect.objectContaining({ code: 'not-differentiable', span: undefined }),
    );
  });

  it('rejects a constant or function as the variable, and a bad order', () => {
    expect(() => derivative('x', 'pi')).toThrow(expect.objectContaining({ code: 'bad-variable' }));
    expect(() => derivative('x', 'sin')).toThrow(expect.objectContaining({ code: 'bad-variable' }));
    expect(() => derivative('x', 'x', { order: 0 })).toThrow(InvalidArgumentError);
    expect(() => derivative('x', 'x', { order: 1.5 })).toThrow(InvalidArgumentError);
    expect(() => derivative('x', 'x', { order: 11 })).toThrow(CasLimitError);
  });

  it('derives a shared subterm once: 64 copies of sin(x) unfolded, a few dozen steps', () => {
    let product = 'sin(x)';
    for (let i = 0; i < 6; i++) product = `(${product}) * (${product})`;
    const { steps, result } = derivation(product, 'x');
    let count = 0;
    walk(steps, () => count++);
    // Unfolded, the product rule alone would give over 120 steps.
    expect(count).toBeLessThan(40);
    expect(result.source).toBe(derivative('sin(x)^64', 'x').result.source);
  });

  it('expression swell becomes a CasLimitError, never a hang', () => {
    expect(() => derivative('(x + 1)^10000', 'x')).toThrow(CasLimitError);
  });
});

describe('derivation: the tree', () => {
  it('sin(x^2): the chain rule is its own step, over the function and power rules', () => {
    const { steps } = derivation('sin(x^2)', 'x');
    const [order] = steps.children;
    const [tree, simplification] = order?.children ?? [];
    expect(tree?.rule).toEqual({ kind: 'derivative', id: 'chain' });
    expect(tree?.children.map(c => [c.rule, c.before.source, c.after.source])).toEqual([
      [{ kind: 'derivative', id: 'function', fn: 'sin' }, 'sin(x^2)', 'cos(x^2)'],
      [{ kind: 'derivative', id: 'power' }, 'x^2', '2 * x'],
    ]);
    expect(tree?.after.source).toBe('cos(x^2) * (2 * x)');
    expect(simplification?.after.source).toBe('2 * x * cos(x^2)');
  });

  it('2^x is the exponential rule at the top, not the chain rule', () => {
    const tree = derivation('2^x', 'x').steps.children[0]?.children[0];
    expect(tree?.rule).toEqual({ kind: 'derivative', id: 'exponential' });
  });

  it('a repeated subterm is a repeat step pointing at the step that derived it', () => {
    const { steps } = derivation('sin(x)*cos(x) + sin(x)^2*cos(x)', 'x');
    const byIndex = new Map<number, DerivationStep>();
    const repeats: DerivationStep[] = [];
    walk(steps, step => {
      byIndex.set(step.index, step);
      if (step.rule.kind === 'repeat') repeats.push(step);
    });
    expect(repeats.length).toBe(2);
    for (const step of repeats) {
      const of = step.rule.kind === 'repeat' ? byIndex.get(step.rule.of) : undefined;
      expect([of?.before.source, of?.after.source]).toEqual([step.before.source, step.after.source]);
      expect(of !== undefined && of.index < step.index).toBe(true);
    }
  });

  it('simplification shows each rule that changed the text, in table order, ending at the result', () => {
    const { steps, result } = derivation('exp(x)*cos(x)', 'x');
    const simplification = steps.children[0]?.children[1];
    expect(simplification?.children.map(c => c.rule)).toEqual([
      { kind: 'normal-form', phases: [] },
      { kind: 'simplify', id: 'factor-out' },
    ]);
    expect(simplification?.children.at(-1)?.after.source).toBe(result.source);
  });

  it('indices are the pre-order positions; every key is in TEMPLATE_KEYS; every derivative rule has a formula', () => {
    for (const [input, order] of [
      ['x^x + log(x, 2) / sqrt(x^2 + 1) - acot(cbrt(x))', 1],
      ['abs(x) * exp(-x) + 2^sin(x) - nthRoot(x, 3) * log10(x)', 1],
      ['x^x * sin(x) - acot(cbrt(x))', 2],
    ] as const) {
      const { steps } = derivation(input, 'x', { order });
      let next = 0;
      walk(steps, step => {
        expect(step.index).toBe(next++);
        expect(TEMPLATE_KEYS).toContain(step.template.key);
        if (step.rule.kind === 'derivative') expect(ruleFormula(step.rule)).not.toBe('');
      });
    }
  });

  it('the steps budget is checked before an order starts; stepNodes before the steps are printed', () => {
    expect(() => derivation('sin(x)*cos(x)*exp(x)', 'x', { limits: { steps: 10 } })).toThrow(
      expect.objectContaining({ budget: 'steps' }),
    );
    expect(() => derivation('sin(x)*cos(x)*exp(x)', 'x', { limits: { stepNodes: 20 } })).toThrow(
      expect.objectContaining({ budget: 'stepNodes' }),
    );
  });
});
