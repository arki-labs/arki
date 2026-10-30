import { describe, expect, it } from 'vitest';

import { parse, print } from '@arki/expr';
import { orThrow } from '@arki/failure';
import { MathError, ResourceLimitError } from '@arki/math/errors';

import { CasError, CasLimitError, conditionToLatex } from './index.js';
import { collect, expand, gcd, polynomialIn, rationalize } from './test-support.js';

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Coefficients as canonical text, so a test reads like the math. */
function coefficientsOf(text: string, variable = 'x'): string[] {
  const form = polynomialIn(text, variable);
  if (form.kind !== 'polynomial') throw new Error(`expected a polynomial, got ${form.kind}`);
  return form.coefficients.map(c => c.value.source);
}

describe('polynomialIn: the equation solver corpus (RFC S-10, S-11)', () => {
  // EQ routes on the coefficient list: its length is the degree + 1, so a wrong
  // coefficient sends an equation to the wrong solver.
  it.each([
    ['(3x + 9) - (0)', ['9', '3']],
    ['(2x + 3) - (x - 4)', ['7', '1']],
    ['(x^2 - 5x + 6) - (0)', ['6', '-5', '1']],
    ['(2x^2 - 7x + 3) - (0)', ['3', '-7', '2']],
    ['(1000000*x^2 + 1) - (0)', ['1', '0', '1000000']],
    ['(x^3 - 6x^2 + 11x - 6) - (0)', ['-6', '11', '-6', '1']],
    ['(x^5 - x - 1) - (0)', ['-1', '-1', '0', '0', '0', '1']],
    ['(x^4 - 5x^2 + 4) - (0)', ['4', '0', '-5', '0', '1']],
  ])('%s → ascending coefficients %j', (text, expected) => {
    expect(coefficientsOf(text)).toEqual(expected);
  });

  it('keeps fractions exact: (x+1)/2 = (x-1)/3 has coefficients 5/6 and 1/6, not floats', () => {
    const form = polynomialIn('((x+1)/2) - ((x-1)/3)', 'x');
    expect(form.kind).toBe('polynomial');
    if (form.kind !== 'polynomial') return;
    expect(form.coefficients.map(c => c.rational?.toString())).toEqual(['5/6', '1/6']);
  });

  it('detects identities and contradictions after expansion (S-11)', () => {
    expect(coefficientsOf('(2*(x+1)) - (2*x + 2)')).toEqual([]);
    expect(coefficientsOf('(0) - (5)')).toEqual(['-5']);
  });

  it('answers "not a polynomial" with a reason and the first offending span, never a throw', () => {
    expect(polynomialIn('sin(x) - 0.5', 'x')).toEqual({
      kind: 'other',
      reason: 'transcendental',
      span: { start: 0, end: 6 },
    });
    expect(polynomialIn('exp(x) - 5', 'x')).toMatchObject({ kind: 'other', reason: 'transcendental' });
    expect(polynomialIn('sqrt(x) - 3', 'x')).toMatchObject({ kind: 'other', reason: 'transcendental' });
    expect(polynomialIn('e^x - 1', 'x')).toMatchObject({ kind: 'other', reason: 'transcendental' });
    expect(polynomialIn('x + y', 'x')).toEqual({ kind: 'other', reason: 'other-variable', span: { start: 4, end: 5 } });
    expect(polynomialIn('sqrt(2)*x - 1', 'x')).toMatchObject({ kind: 'other', reason: 'unsupported-constant' });
  });

  it('lets a kernel or name that cancels out disappear: sin(x) - sin(x) + x is a polynomial', () => {
    expect(coefficientsOf('sin(x) - sin(x) + x')).toEqual(['0', '1']);
    expect(coefficientsOf('x + y - y')).toEqual(['0', '1']);
  });
});

describe('polynomialIn: rational functions and conditions (S-12)', () => {
  it('x/x - 1 is the zero polynomial with the lost restriction x ≠ 0', () => {
    const form = polynomialIn('x/x - 1', 'x');
    expect(form).toMatchObject({ kind: 'polynomial', coefficients: [] });
    if (form.kind === 'other') return;
    expect(form.conditions.map(c => [c.subject.source, c.relation, c.reason])).toEqual([['x', 'nonzero', 'domain']]);
    expect(form.conditions.map(c => conditionToLatex(c))).toEqual(['x \\neq 0']);
  });

  it('(x^2 - 1)/(x - 1) cancels to x + 1 and keeps x - 1 ≠ 0', () => {
    const form = polynomialIn('(x^2 - 1)/(x - 1)', 'x');
    expect(form.kind === 'polynomial' && form.coefficients.map(c => c.value.source)).toEqual(['1', '1']);
    expect(form.kind !== 'other' && form.conditions.map(c => c.subject.source)).toEqual(['x - 1']);
  });

  it('1/x - 2 is rational; the denominator still shows x ≠ 0, so no condition is listed', () => {
    const form = polynomialIn('1/x - 2', 'x');
    expect(form.kind).toBe('rational');
    if (form.kind !== 'rational') return;
    expect(form.numerator.map(c => c.value.source)).toEqual(['1', '-2']);
    expect(form.denominator.map(c => c.value.source)).toEqual(['0', '1']);
    expect(form.conditions).toEqual([]);
  });

  it('records a divisor that cancelled inside a double division: 1/(1/x) = x needs x ≠ 0', () => {
    const form = polynomialIn('1/(1/x)', 'x');
    expect(form.kind !== 'other' && form.conditions.map(c => c.subject.source)).toEqual(['x']);
  });

  it('reports the square-free factor: x^2/x^2 needs x ≠ 0, not x^2 ≠ 0', () => {
    const form = polynomialIn('x^2/x^2', 'x');
    expect(form.kind !== 'other' && form.conditions.map(c => c.subject.source)).toEqual(['x']);
  });
});

describe('polynomialIn: π and e as symbolic coefficients (S-13, decision 6)', () => {
  it('pi*x = 1 is linear with the coefficient pi, not a failed rationalization', () => {
    const form = polynomialIn('pi*x - 1', 'x');
    expect(
      form.kind === 'polynomial' && form.coefficients.map(c => [c.value.source, c.rational?.toString() ?? null]),
    ).toEqual([
      ['-1', '-1'],
      ['pi', null],
    ]);
  });

  it('e alone or to an integer power is the constant; e^u otherwise is exp(u)', () => {
    expect(coefficientsOf('e^2*x - 1')).toEqual(['-1', 'e^2']);
    expect(expand('e^(1/2) + e^0.5 + exp(1/2)').result.source).toBe('3 * exp(1 / 2)');
    expect(expand('exp(2) - e^2').result.source).toBe('0');
  });

  it('divides in ℚ(π, e): x/pi has the coefficient 1/pi', () => {
    expect(coefficientsOf('x/pi')).toEqual(['0', '1 / pi']);
  });
});

describe('the readable normal form (RFC §5.4)', () => {
  it('orders sums by descending degree in the main variable, constant last', () => {
    expect(expand('1 - 4x + 3x^2').result.source).toBe('3 * x^2 - 4 * x + 1');
    expect(expand('(x + 1)^3').result.source).toBe('x^3 + 3 * x^2 + 3 * x + 1');
  });

  it('puts the coefficient first, then π, e, then names: 2*pi*x', () => {
    expect(expand('x*pi*2').result.source).toBe('2 * pi * x');
    expect(expand('y*x*2').result.source).toBe('2 * y * x');
  });

  it('prints negative terms as subtraction, with the minus inside the first term', () => {
    expect(expand('-2x - x^2/4').result.source).toBe('-x^2 / 4 - 2 * x');
  });

  it('prints one fraction over a denominator with integer coefficients', () => {
    expect(expand('x/(2y)').result.source).toBe('x / (2 * y)');
    expect(rationalize('1/x + 1/(x+1)')).toMatchObject({
      numerator: { source: '2 * x + 1' },
      denominator: { source: 'x^2 + x' },
    });
  });

  it('prints exact fractions by default and terminating decimals on request (decision 3)', () => {
    expect(expand('0.02*x + 5').result.source).toBe('x / 50 + 5');
    expect(expand('0.02*x + 5', { numbers: 'decimal' }).result.source).toBe('0.02 * x + 5');
    expect(expand('x/3', { numbers: 'decimal' }).result.source).toBe('x / 3');
  });

  it('round-trips: the result is canonical text that parses to the same tree', () => {
    const { result } = expand('(x - 1)*(x + 2)/3');
    expect(print(orThrow(parse(result.source)))).toBe(result.source);
    expect(print(result)).toBe(result.source);
  });

  it('collect groups by powers of the variable', () => {
    expect(collect('2*pi*x + 3*x + y*x^2 - x^2', 'x').result.source).toBe('(y - 1) * x^2 + (2 * pi + 3) * x');
  });
});

describe('gcd', () => {
  it('is monic for one variable', () => {
    expect(gcd('x^2 - 1', 'x^2 + 2x + 1').result.source).toBe('x + 1');
    expect(gcd('2x + 1', '4x + 2').result.source).toBe('x + 1 / 2');
  });

  it('works with π as a generator', () => {
    expect(gcd('x^2 - pi^2', 'x*pi + pi^2').result.source).toBe('x + pi');
  });

  it('with several generators: coprime integer coefficients, the term that prints first positive', () => {
    // The internal leading term depends on generator ids; the sign follows what the caller sees.
    expect(gcd('x^2 - pi^2', 'x - pi').result.source).toBe('x - pi');
    expect(gcd('2*x*y + 2*y^2', '4*x*y').result.source).toBe('y');
    expect(gcd('-x - 1', 'x^2 - 1').result.source).toBe('x + 1');
  });

  it('refuses a constant it cannot zero-test: as a free symbol, gcd(x - sqrt(2), x^2 - 2) would wrongly be 1', () => {
    expect(() => gcd('x - sqrt(2)', 'x^2 - 2')).toThrow(
      expect.objectContaining({
        code: 'unsupported-constant',
        span: { start: 4, end: 11 },
        message: expect.stringContaining('first'),
      }),
    );
  });

  it('refuses a quotient with a CasError that points at the divisor and names the input', () => {
    expect(() => gcd('1/x', 'x')).toThrow(
      expect.objectContaining({
        code: 'not-polynomial',
        span: { start: 2, end: 3 },
        message: expect.stringContaining('first'),
      }),
    );
    expect(() => gcd('x^2', 'x + 1/(x - 1)')).toThrow(
      expect.objectContaining({
        code: 'not-polynomial',
        span: { start: 6, end: 13 },
        message: expect.stringContaining('second'),
      }),
    );
  });
});

describe('errors', () => {
  it('rejects i: v1 is real-only (not-in-domain, with its span)', () => {
    const error = thrown(() => polynomialIn('x + i', 'x'));
    expect(error).toBeInstanceOf(CasError);
    expect(error).toBeInstanceOf(MathError);
    expect(error).toMatchObject({ code: 'not-in-domain', span: { start: 4, end: 5 } });
    expect((error as CasError).remediation.length).toBeGreaterThan(0);
  });

  it('rejects a constant or function as the variable (bad-variable)', () => {
    expect(() => polynomialIn('x', 'pi')).toThrow(expect.objectContaining({ code: 'bad-variable' }));
    expect(() => polynomialIn('x', 'sin')).toThrow(expect.objectContaining({ code: 'bad-variable' }));
    expect(() => polynomialIn('x', '2x')).toThrow(expect.objectContaining({ code: 'bad-variable' }));
  });

  it('rationalize refuses a transcendental input (not-rational)', () => {
    expect(() => rationalize('x + sin(x)')).toThrow(
      expect.objectContaining({ code: 'not-rational', span: { start: 4, end: 10 } }),
    );
  });

  it('budget errors are ResourceLimitErrors carrying budget, limit and actual', () => {
    const error = thrown(() => expand('(x + 1)^2000'));
    expect(error).toBeInstanceOf(CasLimitError);
    expect(error).toBeInstanceOf(ResourceLimitError);
    expect(error).toMatchObject({ budget: 'degree', limit: 1000, actual: 2000 });
  });

  it('treats constructor and __proto__ as ordinary variables', () => {
    expect(coefficientsOf('constructor*2 + 1', 'constructor')).toEqual(['1', '2']);
    expect(coefficientsOf('__proto__^2', '__proto__')).toEqual(['0', '0', '1']);
  });
});
