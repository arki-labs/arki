import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Complex } from '@arki/math/complex';
import { complex } from '@arki/math/complex';
import { DivisionByZeroError, InvalidArgumentError, NumericRangeError } from '@arki/math/errors';

import { compile, compileEquation, evaluate } from './complex.js';
import { compile as compileDecimal } from './decimal.js';
import { ParseError } from './errors.js';
import { compile as compileFloat, evaluate as evaluateFloat } from './float.js';
import { defineLanguage, scientific } from './language.js';
import { parse, parseEquation } from './parser.js';
import { compile as compileRational } from './rational.js';

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

const parts = (z: Complex): [number, number] => [z.re, z.im];
const close = (z: Complex, re: number, im: number): void => {
  expect(z.re).toBeCloseTo(re, 14);
  expect(z.im).toBeCloseTo(im, 14);
};

describe('RFC §8: the complex row', () => {
  it('+ - * / are float arithmetic on both parts', () => {
    expect(parts(evaluate('(1 + 2i) + (3 - 4i)'))).toEqual([4, -2]);
    expect(parts(evaluate('(1 + 2i) * (3 - 4i)'))).toEqual([11, 2]);
    expect(parts(evaluate('(11 + 2i) / (3 - 4i)'))).toEqual([1, 2]);
    // Float, not exact: 0.1 + 0.2 is the double sum, as in the float domain.
    expect(evaluate('0.1 + 0.2').re).toBe(0.1 + 0.2);
  });

  it('/0 throws DivisionByZeroError, the same class as float, also when the divisor is complex zero', () => {
    expect(() => evaluate('1/0')).toThrow(DivisionByZeroError);
    expect(() => evaluate('(1 + i)/(i - i)')).toThrow(DivisionByZeroError);
    expect(() => evaluate('0^(-1)')).toThrow(DivisionByZeroError);
  });

  it('pi, e and i are constants', () => {
    expect(parts(evaluate('pi'))).toEqual([Math.PI, 0]);
    expect(parts(evaluate('e'))).toEqual([Math.E, 0]);
    expect(parts(evaluate('i'))).toEqual([0, 1]);
    expect(parts(evaluate('i^2'))).toEqual([-1, 0]);
    expect(parts(evaluate('3 + 4i'))).toEqual([3, 4]);
  });

  it('sqrt, exp, ln and pow come from @arki/math/complex', () => {
    close(evaluate('e^(i pi)'), -1, 0);
    close(evaluate('exp(i pi / 2)'), 0, 1);
    close(evaluate('(1 + i)^(1/2)'), evaluate('sqrt(1 + i)').re, evaluate('sqrt(1 + i)').im);
    expect(evaluate('abs(3 + 4i)').toString()).toBe('5');
  });

  it('never claims exactness: Complex is float64 (§8 exactness rules)', () => {
    expect(compile(parse('1 + 1')).detailed().exact).toBe(false);
    expect(compile(parse('x'), { variables: ['x'] }).detailed({ x: 2 }).exact).toBe(false);
  });
});

describe('principal branches', () => {
  // Why: a calculator in complex mode shows these values; another branch would be a different answer.
  it('sqrt(-4) = 2i, exactly', () => {
    expect(parts(evaluate('sqrt(-4)'))).toEqual([0, 2]);
  });

  it('ln(-1) = iπ (not -iπ: the argument is in (-π, π])', () => {
    expect(parts(evaluate('ln(-1)'))).toEqual([0, Math.PI]);
  });

  it('i^i = e^(-π/2), a real number', () => {
    const value = evaluate('i^i');
    expect(value.im).toBe(0);
    expect(value.re).toBeCloseTo(Math.exp(-Math.PI / 2), 15);
  });

  it('on a cut, the counter-clockwise side: asin(2) = π/2 - 1.317i, acosh(-2) = 1.317 + πi', () => {
    close(evaluate('asin(2)'), Math.PI / 2, -Math.acosh(2));
    close(evaluate('acosh(-2)'), Math.acosh(2), Math.PI);
    close(evaluate('(-8)^(1/3)'), 1, Math.sqrt(3));
  });
});

describe('the real axis is the float domain', () => {
  // Why: switching a calculator from float to complex must not change one real answer;
  // complex only adds answers where float has none.
  const FUNCTIONS = [
    'sin',
    'cos',
    'tan',
    'sec',
    'csc',
    'cot',
    'asin',
    'acos',
    'atan',
    'asec',
    'acsc',
    'acot',
    'sinh',
    'cosh',
    'tanh',
    'sech',
    'csch',
    'coth',
    'asinh',
    'acosh',
    'atanh',
    'asech',
    'acsch',
    'acoth',
    'exp',
    'ln',
    'log',
    'log10',
    'log2',
    'sqrt',
    'abs',
  ];

  it.each(['rad', 'deg'] as const)('every function returns float’s value wherever float has one (%s)', angle => {
    const xs = fc.oneof(
      // No -0: a Complex never carries one (by design in @arki/math), so -0 reads as 0.
      fc.double({ min: -1e3, max: 1e3, noNaN: true }).filter(x => !Object.is(x, -0)),
      fc.constantFrom(-2, -1, -0.5, 0, 0.5, 1, 2, 30, 45, 90, 180, 1000, 1e-7),
    );
    for (const name of FUNCTIONS) {
      const float = compileFloat(parse(`${name}(x)`), { variables: ['x'], angle });
      const f = compile(parse(`${name}(x)`), { variables: ['x'], angle });
      fc.assert(
        fc.property(xs, x => {
          let expected: number;
          try {
            expected = float.at(x);
          } catch {
            return;
          }
          const value = f({ x });
          expect([name, x, value.re, value.im]).toEqual([name, x, expected + 0, 0]);
        }),
        { numRuns: 200 },
      );
    }
  });

  it('log(x, 10) and log(x, 2) are log10 and log2, as in float', () => {
    expect(parts(evaluate('log(1000, 10)'))).toEqual([3, 0]);
    expect(parts(evaluate('log(8, 2)'))).toEqual([3, 0]);
  });

  it('leaves the axis only where float has no real answer', () => {
    expect(() => evaluateFloat('sqrt(-2)')).toThrow(InvalidArgumentError);
    expect(evaluate('sqrt(-2)').toString()).toBe('1.4142135623730951i');
    expect(() => evaluateFloat('ln(-2)')).toThrow(InvalidArgumentError);
    close(evaluate('ln(-2)'), Math.LN2, Math.PI);
  });
});

describe('errors', () => {
  it('overflow is NumericRangeError, never an infinite part', () => {
    expect(() => evaluate('10^400')).toThrow(NumericRangeError);
    expect(() => evaluate('exp(1000)')).toThrow(NumericRangeError);
    expect(() => evaluate('1e300 * 1e300 i')).toThrow(NumericRangeError);
    expect(() => evaluate('1e400')).toThrow(NumericRangeError);
  });

  it('poles are InvalidArgumentError, as in float', () => {
    for (const text of ['ln(0)', 'cot(0)', 'csc(0)', 'atanh(1)', 'acoth(1)', 'asec(0)', 'log(5, 1)']) {
      expect([text, thrown(() => evaluateFloat(text))]).toEqual([text, expect.any(InvalidArgumentError)]);
      expect([text, thrown(() => evaluate(text))]).toEqual([text, expect.any(InvalidArgumentError)]);
    }
  });
});

describe('names and the function table', () => {
  it('declaring i is a name-conflict here only: float, decimal and rational leave i free', () => {
    expect(parseError(() => compile(parse('i + 1'), { variables: ['i'] })).code).toBe('name-conflict');
    expect(compileFloat(parse('i + 1'), { variables: ['i'] }).at(2)).toBe(3);
    expect(compileDecimal(parse('i + 1'), { variables: ['i'] })({ i: '2' }).toString()).toBe('3');
    expect(compileRational(parse('i + 1'), { variables: ['i'] })({ i: '2' }).toString()).toBe('3');
  });

  it('a declared letter next to i splits into a product with the constant', () => {
    expect(parts(compile(parse('2xi'), { variables: ['x'] })({ x: 3 }))).toEqual([0, 6]);
  });

  it('functions without a complex definition are not-in-domain at compile, pointing at the name', () => {
    for (const name of ['cbrt', 'sign', 'ceil', 'floor', 'round', 'fix', 'factorial', 'gamma']) {
      const error = parseError(() => compile(parse(`1 + ${name}(2)`)));
      expect([name, error.code, error.span]).toEqual([name, 'not-in-domain', { start: 4, end: 4 + name.length }]);
    }
    expect(parseError(() => compile(parse('nthRoot(8, 3)'))).code).toBe('not-in-domain');
    expect(parseError(() => compile(parse('mod(8, 3)'))).code).toBe('not-in-domain');
    expect(parseError(() => compile(parse('5!'))).code).toBe('not-in-domain');
  });

  it('a host may supply its own function under a scientific name the domain lacks', () => {
    const conjugate = defineLanguage({ extends: scientific, functions: { conj: { arity: 1 } } });
    const f = compile(parse('conj(z)', { language: conjugate }), {
      language: conjugate,
      variables: ['z'],
      functions: { conj: (z: Complex) => z.conjugate() },
    });
    expect(parts(f({ z: complex(1, 2) }))).toEqual([1, -2]);
  });
});

describe('degrees measure real angles', () => {
  const deg = { angle: 'deg' } as const;

  it('forward and inverse trigonometry on the real axis match float in degrees, exact at multiples of 90°', () => {
    expect(parts(evaluate('cos(90)', deg))).toEqual([0, 0]);
    expect(evaluate('sin(30)', deg).re).toBe(evaluateFloat('sin(30)', deg));
    expect(evaluate('asin(0.5)', deg).re).toBe(evaluateFloat('asin(0.5)', deg));
    expect(() => evaluate('tan(90)', deg)).toThrow(InvalidArgumentError);
  });

  it('a complex angle, or an inverse with no real angle, is InvalidArgumentError', () => {
    expect(() => evaluate('sin(i)', deg)).toThrow(InvalidArgumentError);
    expect(() => evaluate('asin(2)', deg)).toThrow(InvalidArgumentError);
  });

  it('everything else is unaffected: hyperbolics, roots and logarithms take no angle', () => {
    expect(parts(evaluate('sqrt(-4)', deg))).toEqual([0, 2]);
    expect(evaluate('sinh(i)', deg).toString()).toBe(evaluate('sinh(i)').toString());
  });

  it('an unknown unit is InvalidArgumentError', () => {
    // Reflect.apply: the types already refuse 'grad'; a JavaScript caller can still pass it.
    expect(() => {
      Reflect.apply(compile, undefined, [parse('1'), { angle: 'grad' }]);
    }).toThrow(InvalidArgumentError);
  });
});

describe('scope', () => {
  const f = compile(parse('z * w'), { variables: ['z', 'w'] });

  it('accepts a Complex, a number (a real) or { re, im } parts', () => {
    expect(parts(f({ z: complex(0, 1), w: 2 }))).toEqual([0, 2]);
    expect(parts(f({ z: { re: 1, im: 1 }, w: { re: 1, im: -1 } }))).toEqual([2, 0]);
  });

  it('rejects text (parse it instead), non-finite parts and missing values', () => {
    // Reflect.apply: the types already refuse text; a JavaScript caller can still pass it.
    expect(() => {
      Reflect.apply(f, undefined, [{ z: '1 + i', w: 1 }]);
    }).toThrow(InvalidArgumentError);
    expect(() => f({ z: Number.NaN, w: 1 })).toThrow(InvalidArgumentError);
    expect(() => f({ z: { re: 1, im: Infinity }, w: 1 })).toThrow(InvalidArgumentError);
    expect(() => compile(parse('z'), { variables: ['z'] })()).toThrow(InvalidArgumentError);
  });

  it('host constants take the same inputs', () => {
    const omega = defineLanguage({ extends: scientific, constants: { w: {} } });
    const value = compile(parse('w^2', { language: omega }), { language: omega, constants: { w: { re: 0, im: 2 } } })();
    expect(parts(value)).toEqual([-4, 0]);
  });

  it('compileEquation shares slots across both sides and their difference', () => {
    const eq = compileEquation(parseEquation('z^2 = -1'), { variables: ['z'] });
    expect(parts(eq.difference({ z: complex(0, 1) }))).toEqual([0, 0]);
    expect(eq.left.variables).toEqual(['z']);
  });
});
