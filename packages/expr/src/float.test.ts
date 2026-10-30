import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';
import { DivisionByZeroError, InvalidArgumentError, MathError, NumericRangeError } from '@arki/math/errors';

import type { Node } from './ast.js';
import type { Scientific } from './exact.js';
import type { EvaluateOptions } from './float.js';
import type { Language } from './language.js';
import { ExprLimitError, ParseError } from './errors.js';
import { compile, compileEquation, evaluate as evaluateText } from './float.js';
import { defineLanguage, scientific } from './language.js';
import { parseEquationText, parseText } from './parser.js';
import { decimalComma } from './syntax.js';

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

const at = (text: string, x: number, angle: 'rad' | 'deg' = 'rad'): number =>
  compile(parseText(text), { variables: ['x'], angle }).at(x);

describe('acceptance (RFC §3)', () => {
  it('C-12: degree mode converts forward-trig arguments and inverse-trig results at any depth', () => {
    expect(evaluate('sin(90)', { angle: 'deg' })).toBe(1);
    expect(evaluate('cos(180)', { angle: 'deg' })).toBe(-1);
    // Multiples of 90° are exact, so a calculator shows 0, not 1.2e-16.
    expect(evaluate('sin(180)', { angle: 'deg' })).toBe(0);
    expect(evaluate('asin(1)', { angle: 'deg' })).toBe(90);
    expect(evaluate('atan(1)', { angle: 'deg' })).toBeCloseTo(45, 12);
    // Nested: the inner result is in degrees and the outer argument is read as degrees.
    expect(at('sin(asin(x))', 0.5, 'deg')).toBeCloseTo(0.5, 14);
    expect(at('2 + cos(acos(x) * 2)', 0.5, 'deg')).toBeCloseTo(2 + Math.cos((2 * Math.PI) / 3), 14);
    // Hyperbolic functions take no angle.
    expect(evaluate('sinh(1)', { angle: 'deg' })).toBe(Math.sinh(1));
    // Radians stay the default.
    expect(evaluate('sin(90)')).toBe(Math.sin(90));
  });

  it('C-15: one-shot evaluation of keypad input', () => {
    expect(evaluate('2^10 - 1')).toBe(1023);
    expect(evaluate('3 × 4 − 10 ÷ 4')).toBe(9.5);
    expect(evaluate('2pi')).toBe(2 * Math.PI);
    expect(evaluate('log(0,5; 2)', { syntax: decimalComma })).toBe(-1);
  });

  it('C-16: compile once, evaluate many with a scope', () => {
    const f = compile(parseText('2x^2 + sin(x)'), { variables: ['x'] });
    const r = compile(parseText('cos(3theta)'), { variables: ['theta'] });
    for (let index = 0; index < 300; index++) {
      const x = -5 + index / 30;
      expect(f({ x })).toBe(2 * x ** 2 + Math.sin(x));
      expect(f.at(x)).toBe(f({ x }));
      expect(r({ theta: x })).toBe(Math.cos(3 * x));
    }
  });

  it('C-17: several compiled functions on one scope, for back-substituting roots', () => {
    const { left, right, difference } = compileEquation(parseEquationText('x^2 + 2 = 3x'), { variables: ['x'] });
    for (const root of [1, 2]) {
      const scope = { x: root };
      expect(left(scope)).toBe(right(scope));
      expect(difference(scope)).toBe(0);
    }
    expect(difference({ x: 0 })).toBe(2);
    expect(left.variables).toEqual(['x']);
  });

  it('C-18: pi and e resolve without the scope, so passing them is harmless and declaring them is a conflict', () => {
    const f = compile(parseText('theta * pi + e'), { variables: ['theta'] });
    const scope = { theta: 2, pi: 3, e: 2 };
    expect(f(scope)).toBe(2 * Math.PI + Math.E);
    expect(parseError(() => compile(parseText('2pi'), { variables: ['pi'] })).code).toBe('name-conflict');
  });

  it('i may be declared as a variable: the float domain has no imaginary unit, so the name is free', () => {
    // Real formulas use i as an index or a current (sum of a_i, V = iR). Rejecting it
    // as a name-conflict would block them for a constant this domain cannot evaluate.
    expect(compile(parseText('2i + 1'), { variables: ['i'] }).at(3)).toBe(7);
    expect(compile(parseText('xi'), { variables: ['x', 'i'] })({ x: 2, i: 5 })).toBe(10);
    // Undeclared, i is still the complex constant, reported as outside this domain.
    expect(parseError(() => compile(parseText('2i'), { variables: ['x'] })).code).toBe('not-in-domain');
    // pi and e have values here, so declaring them stays a conflict.
    expect(parseError(() => compile(parseText('e'), { variables: ['e'] })).code).toBe('name-conflict');
  });

  it('C-21: one result type: always a number, and sqrt(-1) is an error, not a Complex', () => {
    expect(typeof evaluate('sqrt(4)')).toBe('number');
    expect(thrown(() => evaluate('sqrt(-1)'))).toBeInstanceOf(InvalidArgumentError);
    expect(parseError(() => evaluate('2i')).code).toBe('not-in-domain');
  });

  it('C-22: points with no value become NaN gaps in sample, never exceptions', () => {
    const xs = new Float64Array([-1, 0, 1, 4, Number.NaN]);
    const out = new Float64Array(xs.length);
    compile(parseText('1/x + sqrt(x)'), { variables: ['x'] }).sample(xs, out);
    expect([...out]).toEqual([Number.NaN, Number.NaN, 2, 2.25, Number.NaN]);
    const tan = compile(parseText('tan(x)'), { variables: ['x'], angle: 'deg' });
    expect([...tan.sample(new Float64Array([45, 90, 135]), new Float64Array(3))].map(y => Math.round(y))).toEqual([
      1,
      Number.NaN,
      -1,
    ]);
  });

  it('C-27: a parsed tree evaluates directly', () => {
    expect(compile(parseText('2 + 3 * 4'))()).toBe(14);
  });
});

describe('typed errors instead of NaN or Infinity', () => {
  it.each([
    ['sqrt(-1)', InvalidArgumentError],
    ['ln(0)', InvalidArgumentError],
    ['log(-2)', InvalidArgumentError],
    ['log(8, 1)', InvalidArgumentError],
    ['asin(2)', InvalidArgumentError],
    ['acosh(0.5)', InvalidArgumentError],
    ['atanh(1)', InvalidArgumentError],
    ['cot(0)', InvalidArgumentError],
    ['(-8)^(1/3)', InvalidArgumentError],
    ['nthRoot(-4, 2)', InvalidArgumentError],
    ['(-1)!', InvalidArgumentError],
    ['1/0', DivisionByZeroError],
    ['0^-1', DivisionByZeroError],
    ['mod(5, 0)', DivisionByZeroError],
    ['exp(1000)', NumericRangeError],
    ['cosh(1000)', NumericRangeError],
    ['10^400', NumericRangeError],
    ['1e308 * 10', NumericRangeError],
    ['1e308 + 1e308', NumericRangeError],
    ['171!', NumericRangeError],
  ])('%s throws %o', (text, type) => {
    expect(thrown(() => evaluate(text))).toBeInstanceOf(type);
  });

  it('keeps valid edge values: cube roots of negatives, 0^0, factorials, floored mod, rounding half away from zero', () => {
    expect(evaluate('nthRoot(-8, 3)')).toBe(-2);
    expect(evaluate('cbrt(-27)')).toBe(-3);
    expect(evaluate('0^0')).toBe(1);
    expect(evaluate('5!')).toBe(120);
    expect(evaluate('20!')).toBe(2_432_902_008_176_640_000);
    expect(evaluate('0.5!')).toBeCloseTo(Math.sqrt(Math.PI) / 2, 14);
    expect(evaluate('mod(-7, 3)')).toBe(2);
    expect(evaluate('round(-2.5)')).toBe(-3);
    expect(evaluate('log(1000, 10)')).toBe(3);
    expect(evaluate('log(8, 2)')).toBe(3);
  });

  it('an error inside a constant subtree is raised at the call, not at compile', () => {
    const f = compile(parseText('x + 1/0'), { variables: ['x'] });
    expect(thrown(() => f.at(1))).toBeInstanceOf(DivisionByZeroError);
  });

  it('every scientific function is implemented, and f() never yields NaN or Infinity for any finite input', () => {
    const binary = new Set(['pow', 'mod']);
    const optional = new Set(['log', 'nthRoot']);
    const formulas = scientific.functionNames().flatMap(fn => {
      if (binary.has(fn)) return [`${fn}(x, y)`];
      return optional.has(fn) ? [`${fn}(x)`, `${fn}(x, y)`] : [`${fn}(x)`];
    });
    formulas.push('x^y', 'x/y', 'x!', 'x*y*1e300');
    const compiled = ['rad', 'deg'].flatMap(angle =>
      formulas.map(text => compile(parseText(text), { variables: ['x', 'y'], angle: angle === 'deg' ? 'deg' : 'rad' })),
    );
    const value = fc.oneof(
      fc.double({ noNaN: true, noDefaultInfinity: true }),
      fc.integer({ min: -200, max: 200 }),
      fc.constantFrom(0, -0, 1, -1, 0.5, 90, 180, 1e308, -1e308, 5e-324),
    );
    fc.assert(
      fc.property(value, value, (x, y) => {
        for (const f of compiled) {
          try {
            expect(Number.isFinite(f({ x, y }))).toBe(true);
          } catch (error) {
            expect(error).toBeInstanceOf(MathError);
            expect(error).not.toBeInstanceOf(TypeError);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('variables and the scope', () => {
  it('rejects a missing or non-finite value instead of computing with undefined', () => {
    // Declared as string[], as an app would, so the scope type is a plain record.
    const variables: string[] = ['x', 'y'];
    const f = compile(parseText('x + y'), { variables });
    expect(thrown(() => f({ x: 1 }))).toBeInstanceOf(InvalidArgumentError);
    expect(thrown(() => f({ x: 1, y: Number.NaN }))).toBeInstanceOf(InvalidArgumentError);
    expect(thrown(() => f())).toBeInstanceOf(InvalidArgumentError);
    expect(thrown(() => f.at(1))).toBeInstanceOf(InvalidArgumentError);
  });

  it('rejects invalid and duplicate variable names', () => {
    expect(thrown(() => compile(parseText('x'), { variables: ['x', 'x'] }))).toBeInstanceOf(InvalidArgumentError);
    expect(thrown(() => compile(parseText('x'), { variables: ['x', '1a'] }))).toBeInstanceOf(InvalidArgumentError);
    expect(parseError(() => compile(parseText('x'), { variables: ['x', 'sin'] })).code).toBe('name-conflict');
  });

  it('an undeclared name fails at compile with its span, before any point is evaluated', () => {
    const error = parseError(() => compile(parseText('2 * q + x'), { variables: ['x'] }));
    expect(error.code).toBe('unknown-name');
    expect(error.span).toEqual({ start: 4, end: 5 });
  });
});

describe('multi-letter names (RFC §4.3)', () => {
  it('splits a name into declared letters and reports the reading', () => {
    const f = compile(parseText('2xy + 1'), { variables: ['x', 'y'] });
    expect(f({ x: 3, y: 5 })).toBe(31);
    expect(f.readings).toEqual([{ span: { start: 1, end: 3 }, name: 'xy', letters: ['x', 'y'] }]);
  });

  it('an exact declared name wins over a split', () => {
    const f = compile(parseText('xy'), { variables: ['xy', 'x', 'y'] });
    expect(f({ xy: 7, x: 2, y: 3 })).toBe(7);
    expect(f.readings).toEqual([]);
  });

  it('splits into constants too, but not into multi-letter constants', () => {
    expect(compile(parseText('xe'), { variables: ['x'] }).at(2)).toBe(2 * Math.E);
    const error = parseError(() => compile(parseText('xpi'), { variables: ['x'] }));
    expect(error.code).toBe('unknown-name');
    // i is a constant of scientific (complex), so only p is missing; pi itself is never a letter.
    expect(error.message).toContain('missing: p)');
    expect(parseError(() => compile(parseText('xi'), { variables: ['x'] })).code).toBe('not-in-domain');
  });

  it('lists the letters that are not declared', () => {
    expect(parseError(() => compile(parseText('xyz'), { variables: ['x'] })).message).toContain('missing: y, z');
  });

  it('warns that a/bc reads as a/(b·c) when bc is split, unlike a/b c', () => {
    const f = compile(parseText('a/bc'), { variables: ['a', 'b', 'c'] });
    expect(f({ a: 12, b: 2, c: 3 })).toBe(2);
    expect(f.warnings.map(warning => warning.code)).toEqual(['split-after-division']);
    expect(f.warnings[0]?.hint).toBe('write a/(b*c) or (a/b)*c');
    expect(compile(parseText('a/bc'), { variables: ['a', 'bc'] }).warnings).toEqual([]);
  });

  it('keeps the parse warnings', () => {
    expect(compile(parseText('1/2x'), { variables: ['x'] }).warnings.map(warning => warning.code)).toEqual([
      'implicit-after-division',
    ]);
  });
});

describe('sample', () => {
  it('matches the checked tree wherever the checked tree has a value', () => {
    const f = compile(parseText('sin(x)*x^2 + 3x - 1'), { variables: ['x'] });
    const xs = Float64Array.from({ length: 2048 }, (_, index) => index / 100 - 10);
    const out = f.sample(xs, new Float64Array(xs.length));
    for (const [index, x] of xs.entries()) expect(out[index]).toBe(f.at(x));
  });

  it('checks the signal every 1 024 points', () => {
    const f = compile(parseText('x'), { variables: ['x'] });
    const reason = new Error('stop');
    const xs = new Float64Array(4096);
    expect(thrown(() => f.sample(xs, new Float64Array(4096), { signal: { aborted: true, reason } }))).toBe(reason);
    let reads = 0;
    const signal = {
      get aborted(): boolean {
        reads++;
        return false;
      },
    };
    f.sample(xs, new Float64Array(4096), { signal });
    expect(reads).toBe(4);
  });

  it('checks the steps budget before the first point: nodes × points', () => {
    const f = compile(parseText('x + 1'), { variables: ['x'], limits: { steps: 100 } });
    const error = thrown(() => f.sample(new Float64Array(50), new Float64Array(50)));
    expect(error).toBeInstanceOf(ExprLimitError);
    expect(error instanceof ExprLimitError && error.actual).toBe(150);
    expect(f.sample(new Float64Array(33), new Float64Array(33))).toHaveLength(33);
  });

  it('needs one variable and matching lengths', () => {
    const two = compile(parseText('x + y'), { variables: ['x', 'y'] });
    expect(thrown(() => two.sample(new Float64Array(2), new Float64Array(2)))).toBeInstanceOf(InvalidArgumentError);
    const one = compile(parseText('x'), { variables: ['x'] });
    expect(thrown(() => one.sample(new Float64Array(2), new Float64Array(3)))).toBeInstanceOf(InvalidArgumentError);
  });
});

describe('budgets', () => {
  it('a 256-deep expression compiles and evaluates; a deeper hand-built tree is rejected by compile', () => {
    const deep = `${'('.repeat(255)}x${')'.repeat(255)}`;
    expect(compile(parseText(deep), { variables: ['x'] }).at(3)).toBe(3);
    let node: Node = { kind: 'name', name: 'x', span: { start: 0, end: 1 } };
    for (let index = 0; index < 300; index++) node = { kind: 'group', inner: node, span: { start: 0, end: 1 } };
    const expr = { version: 1, source: 'x', root: node, warnings: [] } as const;
    const error = thrown(() => compile(expr, { variables: ['x'] }));
    expect(error instanceof ExprLimitError && error.budget).toBe('depth');
  });

  it('checks steps statically, counting a host function at its declared cost', () => {
    const heavy = defineLanguage({ extends: scientific, functions: { slow: { arity: 1, cost: 50 } } });
    const options = { language: heavy, variables: ['x'], functions: { slow: (a: number) => a } } as const;
    expect(compile(parseText('slow(x) + 1', { language: heavy }), options).at(1)).toBe(2);
    const error = thrown(() =>
      compile(parseText('slow(x) + 1', { language: heavy }), { ...options, limits: { steps: 50 } }),
    );
    expect(error instanceof ExprLimitError && error.budget).toBe('steps');
  });
});

describe('host functions and constants (RFC §9)', () => {
  const physics = defineLanguage({
    extends: scientific,
    functions: { hypot: { arity: [2, 16] } },
    constants: { g: {} },
  });

  it('are required by the types and supplied at compile', () => {
    const f = compile(parseText('hypot(x, 4) + g', { language: physics }), {
      language: physics,
      variables: ['x'],
      functions: { hypot: Math.hypot },
      constants: { g: 9.806_65 },
    });
    expect(f.at(3)).toBe(5 + 9.806_65);
    // @ts-expect-error -- the language declares hypot and g, so both implementations are required
    const missing = () => compile(parseText('hypot(3, 4)', { language: physics }), { language: physics });
    expect(thrown(missing)).toBeInstanceOf(InvalidArgumentError);
  });

  it('receive numbers only: never the AST, the scope or a this', () => {
    const calls: unknown[][] = [];
    function spy(this: unknown, ...args: unknown[]): number {
      calls.push([this, ...args]);
      return 1;
    }
    const f = compile(parseText('hypot(x, x + 1, 2)', { language: physics }), {
      language: physics,
      variables: ['x'],
      functions: { hypot: spy },
      constants: { g: 0 },
    });
    f({ x: 2 });
    expect(calls).toEqual([[undefined, 2, 3, 2]]);
  });

  it('a host result of NaN or Infinity is a typed error in f() and a gap in sample', () => {
    const f = compile(parseText('hypot(x, 1)', { language: physics }), {
      language: physics,
      variables: ['x'],
      functions: { hypot: (a: number) => (a < 0 ? Number.NaN : a > 10 ? Number.POSITIVE_INFINITY : a) },
      constants: { g: 0 },
    });
    expect(thrown(() => f.at(-1))).toBeInstanceOf(InvalidArgumentError);
    expect(thrown(() => f.at(11))).toBeInstanceOf(NumericRangeError);
    expect([...f.sample(new Float64Array([-1, 2, 11]), new Float64Array(3))]).toEqual([Number.NaN, 2, Number.NaN]);
  });

  it('a host function that calls back into the same compiled function does not clobber its slots', () => {
    const lang = defineLanguage({ extends: scientific, functions: { inner: { arity: 1 } } });
    const self: { f?: (x: number) => number } = {};
    // x is read after the nested call returns, so a clobbered slot would show.
    const g = compile(parseText('inner(x) + x', { language: lang }), {
      language: lang,
      variables: ['x'],
      functions: { inner: (a: number) => (a > 1 && self.f !== undefined ? self.f(a - 1) : 0) },
    });
    self.f = x => g.at(x);
    // g(3) = 3 + g(2) = 3 + 2 + g(1) = 3 + 2 + 1 + 0
    expect(g.at(3)).toBe(6);
  });
});

describe('security', () => {
  it('prototype names are ordinary variables, read only from the scope’s own keys', () => {
    const variables: string[] = ['constructor', '__proto__', 'toString'];
    const f = compile(parseText('constructor + __proto__ * toString'), { variables });
    const scope = Object.defineProperty({ constructor: 1, toString: 3 }, '__proto__', {
      value: 2,
      enumerable: true,
    });
    expect(f(scope)).toBe(7);
    // An empty scope still "has" constructor and toString through its prototype: they must not be read.
    expect(thrown(() => f({}))).toBeInstanceOf(InvalidArgumentError);
  });

  it('a prototype name is not a constant or a function', () => {
    expect(parseError(() => compile(parseText('constructor'))).code).toBe('unknown-name');
    expect(parseError(() => compile(parseText('valueOf + 1'), { constants: {} })).code).toBe('unknown-name');
  });

  it('builds closures, never code from text', () => {
    // A name that would be code in JavaScript is only a name here.
    const f = compile(parseText('process + globalThis'), { variables: ['process', 'globalThis'] });
    expect(f({ process: 1, globalThis: 2 })).toBe(3);
  });
});

describe('gamma', () => {
  // Graphing users type gamma(x) (mathjs had it); it must plot, with poles as gaps, not crash.
  it('evaluates the gamma function, matching factorial at integers', () => {
    expect(evaluate('gamma(5)')).toBe(24);
    expect(evaluate('gamma(0.5)')).toBeCloseTo(Math.sqrt(Math.PI), 14);
    expect(evaluate('gamma(4.5)')).toBeCloseTo(evaluate('3.5!'), 14);
  });

  it('throws a typed error at a pole in a single evaluation', () => {
    expect(evaluateText('gamma(0)')).toMatchObject({ code: 'expr.no_value', cause: expect.any(InvalidArgumentError) });
    expect(evaluateText('gamma(-2)')).toMatchObject({ code: 'expr.no_value', cause: expect.any(InvalidArgumentError) });
  });

  it('marks poles as gaps in sample()', () => {
    const f = compile(parseText('gamma(x)'), { variables: ['x'] });
    const out = new Float64Array(3);
    f.sample(Float64Array.of(-1, 0.5, 3), out);
    expect(Number.isNaN(out[0])).toBe(true);
    expect(out[1]).toBeCloseTo(Math.sqrt(Math.PI), 14);
    expect(out[2]).toBe(2);
  });
});
