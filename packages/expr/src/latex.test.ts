import { describe, expect, it } from 'vitest';

import type { Node } from './ast.js';
import { ExprLimitError } from './errors.js';
import { defineLanguage, scientific } from './language.js';
import { toLatex } from './latex.js';
import { parse, parseEquation } from './parser.js';

const latex = (text: string): string => toLatex(parse(text));

describe('toLatex (RFC §12, C-26)', () => {
  it.each([
    ['sqrt(x)/2', String.raw`\frac{\sqrt{x}}{2}`],
    ['(a + b)/(c - d)', String.raw`\frac{a + b}{c - d}`],
    ['x^(1/n)', String.raw`x^{\frac{1}{n}}`],
    ['x^y^z', String.raw`x^{y^{z}}`],
    ['(x + 1)^2', String.raw`\left(x + 1\right)^{2}`],
    ['-x^2', String.raw`-x^{2}`],
    ['√x + nthRoot(x)', String.raw`\sqrt{x} + \sqrt{x}`],
    ['nthRoot(x, 3) + cbrt(y)', String.raw`\sqrt[3]{x} + \sqrt[3]{y}`],
    ['|x - |y||', String.raw`\left|x - \left|y\right|\right|`],
    ['abs(x)', String.raw`\left|x\right|`],
    ['floor(x) + ceil(y)', String.raw`\left\lfloor x\right\rfloor + \left\lceil y\right\rceil`],
    ['sin(x)^2 + cos(x)', String.raw`\sin\left(x\right)^{2} + \cos\left(x\right)`],
    ['asin(x) + sech(x)', String.raw`\arcsin\left(x\right) + \operatorname{sech}\left(x\right)`],
    ['ln(x) + log(x) + log(x, 2)', String.raw`\ln\left(x\right) + \ln\left(x\right) + \log_{2}\left(x\right)`],
    ['n! + (n + 1)! + factorial(k)', String.raw`n! + \left(n + 1\right)! + k!`],
    ['2pi r', String.raw`2\pi r`],
    ['2(x + 1)x', String.raw`2\left(x + 1\right)x`],
    ['2 * pi * r', String.raw`2 \cdot \pi \cdot r`],
    ['e^(-x^2)', String.raw`e^{-x^{2}}`],
    ['1.5e-7 * x', String.raw`1.5 \times 10^{-7} \cdot x`],
    ['theta + θ + rate', String.raw`\theta + \theta + \mathit{rate}`],
  ])('%s → %s', (text, expected) => {
    expect(latex(text)).toBe(expected);
  });

  it('prints equations', () => {
    expect(toLatex(parseEquation('x^2 = 2x'))).toBe('x^{2} = 2x');
  });

  it('uses a host function’s command, otherwise \\operatorname', () => {
    const physics = defineLanguage({
      extends: scientific,
      functions: { hypot: { arity: 2 }, erf: { arity: 1, latex: String.raw`\mathrm{erf}` } },
      constants: { g: { latex: 'g' }, c0: {} },
    });
    const expr = parse('hypot(x, g) + erf(c0)', { language: physics });
    expect(toLatex(expr, { language: physics })).toBe(
      String.raw`\operatorname{hypot}\left(x, g\right) + \mathrm{erf}\left(\mathit{c0}\right)`,
    );
  });

  it('adds parentheses only where a hand-built tree needs them', () => {
    const x: Node = { kind: 'name', name: 'x', span: { start: 0, end: 1 } };
    const sum: Node = { kind: 'binary', op: '+', left: x, right: x, implicit: false, span: { start: 0, end: 1 } };
    const product: Node = { kind: 'binary', op: '*', left: sum, right: x, implicit: false, span: { start: 0, end: 1 } };
    expect(toLatex(product)).toBe(String.raw`\left(x + x\right) \cdot x`);
  });

  it('bounds the recursion on hand-built trees', () => {
    let node: Node = { kind: 'name', name: 'x', span: { start: 0, end: 1 } };
    for (let index = 0; index < 300; index++) node = { kind: 'group', inner: node, span: { start: 0, end: 1 } };
    expect(() => toLatex(node)).toThrow(ExprLimitError);
  });
});
