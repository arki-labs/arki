/**
 * Verbs that take a string read outside text, so they return failures; the same verbs given an `Expr` the caller
 * built keep throwing. A user must be able to type anything into a calculator without a verb throwing at them.
 */
import { describe, expect, it } from 'vitest';

import { parse } from '@arki/expr';
import { isFailure } from '@arki/failure';

import { CasError, CasLimitError } from './core.js';
import { derivation } from './derivation.js';
import { derivative } from './derivative.js';
import { collect, expand, factor, gcd, polynomialIn, rationalize } from './polynomial.js';
import { simplify } from './simplify.js';

function tree(text: string) {
  const parsed = parse(text);
  if (isFailure(parsed)) throw new Error(`test text does not parse: ${text}`);
  return parsed;
}

describe('a string that does not parse returns the failure parse returned', () => {
  const verbs = {
    derivative: (text: string) => derivative(text, 'x'),
    derivation: (text: string) => derivation(text, 'x'),
    simplify: (text: string) => simplify(text),
    expand: (text: string) => expand(text),
    collect: (text: string) => collect(text, 'x'),
    rationalize: (text: string) => rationalize(text),
    gcd: (text: string) => gcd(text, 'x'),
    polynomialIn: (text: string) => polynomialIn(text, 'x'),
    factor: (text: string) => factor(text, 'x'),
  };
  it.each(Object.entries(verbs))('%s: "x +" is expr.invalid_text with the ParseError as cause', (_name, run) => {
    const out = run('x +');
    expect(isFailure(out) && out.code).toBe('expr.invalid_text');
  });
  it.each(Object.entries(verbs))('%s: 20 000 characters is expr.over_budget', (_name, run) => {
    const out = run('x+'.repeat(10_000) + 'x');
    expect(isFailure(out) && out.code).toBe('expr.over_budget');
  });
});

describe('a string the verb cannot work with returns a cas failure with the thrown error as cause', () => {
  it('derivative of floor(x) is cas.unsupported_text with the CasError', () => {
    const out = derivative('floor(x)', 'x');
    expect(isFailure(out) && out.code).toBe('cas.unsupported_text');
    expect(isFailure(out) && out.cause).toBeInstanceOf(CasError);
  });
  it('factor of sin(x) is cas.unsupported_text', () => {
    const out = factor('sin(x)', 'x');
    expect(isFailure(out) && out.code).toBe('cas.unsupported_text');
  });
  it('expand of (x+1)^100000 is cas.over_budget with the CasLimitError', () => {
    const out = expand('(x+1)^100000');
    expect(isFailure(out) && out.code).toBe('cas.over_budget');
    expect(isFailure(out) && out.cause).toBeInstanceOf(CasLimitError);
  });
  it('x/0 is cas.no_value', () => {
    const out = simplify('x/0');
    expect(isFailure(out) && out.code).toBe('cas.no_value');
  });
});

describe('what stays a bug stays thrown, even for a string', () => {
  it('a constant as the variable throws CasError bad-variable', () => {
    expect(() => derivative('x', 'pi')).toThrow(expect.objectContaining({ code: 'bad-variable' }));
  });
  it('a bad option throws', () => {
    expect(() => expand('x', { limits: { nodes: 0 } })).toThrow(/positive integer/);
  });
  it('the reason of an aborted signal is thrown, not returned', () => {
    const reason = new Error('stop');
    expect(() => expand('x + 1', { signal: { aborted: true, reason } })).toThrow(reason);
  });
});

describe('an Expr the caller built keeps result-or-throw', () => {
  it('derivative of floor(x) throws the CasError', () => {
    expect(() => derivative(tree('floor(x)'), 'x')).toThrow(CasError);
  });
  it('a valid Expr returns the result, not a failure', () => {
    expect(derivative(tree('x^2'), 'x').result.source).toBe('2 * x');
  });
});
