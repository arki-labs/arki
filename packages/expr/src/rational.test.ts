import { describe, expect, it } from 'vitest';

import type { Rational } from '@arki/math/rational';
import { isFailure } from '@arki/failure';
import { decimal } from '@arki/math/decimal';
import { DivisionByZeroError, InvalidArgumentError, RoundingNecessaryError } from '@arki/math/errors';
import { ratio } from '@arki/math/rational';

import type { Scientific } from './exact.js';
import type { Language } from './language.js';
import type { EvaluateOptions } from './rational.js';
import { ExprLimitError, ParseError } from './errors.js';
import { defineLanguage, scientific } from './language.js';
import { parseEquationText, parseText } from './parser.js';
import { compile, compileEquation, evaluate as evaluateText } from './rational.js';

/** Unwraps a returned failure to the error that caused it, so rule tests below assert the exact `@arki/math` error. */
const evaluate = <L extends Language = Scientific>(text: string, options?: EvaluateOptions<L>) => {
  const result = evaluateText(text, options);
  if (isFailure(result)) throw result.cause;
  return result;
};

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

function parseError(run: () => unknown): ParseError {
  const error = thrown(run);
  if (error instanceof ParseError) return error;
  throw error;
}

const value = (text: string): string => evaluate(text).toString();
const half = (x: Rational): Rational => x.dividedBy(2);

describe('RFC §8: the rational row', () => {
  it('+ - * / are exact: no step ever rounds', () => {
    expect(['0.1 + 0.2', '1/3 + 1/6', '(1/3) * 3', '2/3 - 1', '1/7 / (2/7)'].map(text => value(text))).toEqual([
      '3/10',
      '1/2',
      '1',
      '-1/3',
      '1/2',
    ]);
    expect(evaluateText('1/(1/3 - 2/6)')).toMatchObject({
      code: 'expr.no_value',
      cause: expect.any(DivisionByZeroError),
    });
  });

  it('integer exponents are exact; a rational exponent only when the root is exact (8^(2/3) = 4)', () => {
    expect(
      ['(2/3)^3', '2^-3', '0^0', '8^(2/3)', '(9/4)^(1/2)', '(8/27)^(-2/3)', '0^(1/2)'].map(text => value(text)),
    ).toEqual(['8/27', '1/8', '1', '4', '3/2', '9/4', '0']);
    // The exact answer exists but a Rational cannot hold it.
    expect(evaluateText('2^(1/2)')).toMatchObject({ code: 'expr.no_value', cause: expect.any(RoundingNecessaryError) });
    expect(evaluateText('9^(1/1000)')).toMatchObject({
      code: 'expr.no_value',
      cause: expect.any(RoundingNecessaryError),
    });
    // Same classes as the float domain: not real, and division by zero.
    expect(evaluateText('(-8)^(1/3)')).toMatchObject({
      code: 'expr.no_value',
      cause: expect.any(InvalidArgumentError),
    });
    expect(evaluateText('0^(-1/2)')).toMatchObject({ code: 'expr.no_value', cause: expect.any(DivisionByZeroError) });
    expect(evaluateText('0^-1')).toMatchObject({ code: 'expr.no_value', cause: expect.any(DivisionByZeroError) });
  });

  it('sqrt cbrt nthRoot only when the root is exact', () => {
    expect(['sqrt(9/4)', 'cbrt(-27/8)', 'nthRoot(1024, 10)', 'nthRoot(16)'].map(text => value(text))).toEqual([
      '3/2',
      '-3/2',
      '2',
      '4',
    ]);
    expect(evaluateText('sqrt(2)')).toMatchObject({ code: 'expr.no_value', cause: expect.any(RoundingNecessaryError) });
    expect(evaluateText('sqrt(-4)')).toMatchObject({ code: 'expr.no_value', cause: expect.any(InvalidArgumentError) });
    expect(evaluateText('nthRoot(8, 1/2)')).toMatchObject({
      code: 'expr.no_value',
      cause: expect.any(InvalidArgumentError),
    });
  });

  it('exp, logarithms and trigonometry are compile-time not-in-domain errors, with no special cases', () => {
    // ln(1) = 0 is true, but a domain that answered it would still fail ln(2): no special cases (RFC §8).
    for (const fn of ['exp', 'ln', 'log', 'log10', 'log2', 'sin', 'atan']) {
      const error = parseError(() => compile(parseText(`2 * ${fn}(1)`)));
      expect(error.code).toBe('not-in-domain');
      expect(error.span).toEqual({ start: 4, end: 4 + fn.length });
    }
  });

  it('pi, e and i are not-in-domain, and so free to be declared as variables', () => {
    for (const name of ['pi', 'e', 'i']) {
      expect(parseError(() => compile(parseText(`2${name}`))).code).toBe('not-in-domain');
    }
    expect(compile(parseText('2e'), { variables: ['e'] })({ e: '1/3' }).toString()).toBe('2/3');
  });
});

describe('integer-only operations are exact', () => {
  it('floor ceil round fix sign abs mod match the float definitions on exact values', () => {
    expect(
      ['floor(-7/2)', 'ceil(-7/2)', 'round(-5/2)', 'round(5/2)', 'round(7/3)', 'fix(-7/2)'].map(text => value(text)),
    ).toEqual(['-4', '-3', '-3', '3', '2', '-3']);
    expect(['sign(-1/3)', 'abs(-1/3)', 'mod(-7, 3)', 'mod(7, -3)', 'mod(1/2, 1/3)'].map(text => value(text))).toEqual([
      '-1',
      '1/3',
      '2',
      '-2',
      '1/6',
    ]);
    expect(evaluateText('mod(1, 0)')).toMatchObject({ code: 'expr.no_value', cause: expect.any(DivisionByZeroError) });
  });

  it('factorial is exact on integers and undefined elsewhere (no gamma here)', () => {
    expect(value('20!')).toBe('2432902008176640000');
    expect(evaluateText('(1/2)!')).toMatchObject({ code: 'expr.no_value', cause: expect.any(InvalidArgumentError) });
    expect(evaluateText('(-1)!')).toMatchObject({ code: 'expr.no_value', cause: expect.any(InvalidArgumentError) });
  });
});

/** Throws `ExprLimitError` on the digits budget, before any bigint work: well under 50 ms. */
function refusesFast(text: string): ExprLimitError {
  const started = Date.now();
  const error = thrown(() => evaluate(text));
  expect(Date.now() - started).toBeLessThan(50);
  if (error instanceof ExprLimitError) return error;
  throw error;
}

describe('the digits budget (RFC §11, §19 security tests)', () => {
  it('9^9^9 is refused from the estimate exponent × digits(base), not by computing it', () => {
    const error = refusesFast('9^9^9');
    expect(error.budget).toBe('digits');
    expect(error.limit).toBe(1000);
    expect(error.actual).toBeGreaterThan(300_000_000);
  });

  it('10000! is refused from a log-gamma estimate (35 660 digits)', () => {
    expect(refusesFast('10000!').actual).toBe(35_660);
    expect(refusesFast('factorial(10^9)').budget).toBe('digits');
  });

  it('bounds non-integer powers and literals too, and a raised budget lets the work through', () => {
    expect(refusesFast('(10/3)^(4000/3)').budget).toBe('digits');
    expect(thrown(() => compile(parseText('1e2000')))).toMatchObject({ budget: 'digits', actual: 2001 });
    expect(evaluate('2^4000', { limits: { digits: 2000 } }).toString()).toHaveLength(1205);
    // Bases 0, 1 and -1 never grow, whatever the exponent.
    expect(value('(-1)^(10^30)')).toBe('1');
  });
});

describe('cancellation', () => {
  it('checks the signal before an operation on a value above 100 digits', () => {
    const reason = new Error('stop');
    // The AbortSignal shape the call reads; an aborted AbortController's signal behaves the same.
    const signal = { aborted: true, reason };
    const f = compile(parseText('x^20 / 7'), { variables: ['x'] });
    expect(thrown(() => f({ x: '123456789' }, { signal: signal }))).toBe(reason);
    expect(f({ x: '2' }, { signal: signal }).toString()).toBe('1048576/7');
    // An unaborted signal changes nothing.
    expect(f({ x: '2' }, { signal: { aborted: false } }).toString()).toBe('1048576/7');
  });
});

describe('scope, host functions and equations', () => {
  it('scope values accept what ratio() accepts', () => {
    const f = compile(parseText('x / 3'), { variables: ['x'] });
    expect([ratio(1, 2), decimal('0.5'), '0.5', '1/2', 0.5, 2n].map(x => f({ x }).toString())).toEqual([
      '1/6',
      '1/6',
      '1/6',
      '1/6',
      '1/6',
      '2/3',
    ]);
    expect(() => f()).toThrow(InvalidArgumentError);
  });

  it('host functions receive Rationals; detailed() is always exact', () => {
    const lang = defineLanguage({ extends: scientific, functions: { half: { arity: 1 } } });
    const f = compile(parseText('half(x) + 1', { language: lang }), {
      language: lang,
      variables: ['x'],
      functions: { half },
    });
    expect(f.detailed({ x: '1/3' })).toEqual({ value: ratio(7, 6), exact: true });
  });

  it('compileEquation shares slots between the sides and their difference', () => {
    const { difference } = compileEquation(parseEquationText('x/2 = x/3'), { variables: ['x'] });
    expect(difference({ x: '6' }).toString()).toBe('1');
  });
});
