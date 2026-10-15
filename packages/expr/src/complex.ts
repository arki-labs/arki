/**
 * `@arki/expr/complex`: the Complex domain (RFC §8). Values are `Complex`es
 * from `@arki/math/complex`: float64 parts, never claimed exact, so
 * `f.detailed()` always reports `exact: false`.
 *
 * Principal branches, as `@arki/math/complex` defines them (C99 Annex G, with
 * Kahan's counter-clockwise rule on the cuts): `sqrt(-4)` is `2i`, `ln(-1)`
 * is `πi`, `i^i` is `e^(-π/2)`, `asin(2)` is `π/2 - 1.317i`. On the real axis,
 * wherever the float domain has a value, this domain returns that same value
 * (`log10(1000)` is 3, `2^0.5` is `Math.SQRT2`); it leaves the real axis only
 * where float has no real answer (`sqrt(-2)`, `asin(2)`, `(-8)^(1/3)`).
 *
 * `i` is a constant here, so declaring `i` as a variable is a `name-conflict`
 * in this domain only.
 *
 * Not in this domain (compile-time `not-in-domain`): `cbrt` and `nthRoot`,
 * because float's real root (`cbrt(-8)` is -2) and the principal root
 * (`1 + 1.732i`) are different numbers — write `x^(1/3)` for the principal
 * one; and `sign ceil floor round fix mod factorial gamma`, which have no
 * complex definition in `@arki/math`.
 *
 * Degrees (`angle: 'deg'`) measure real angles: a trigonometric function
 * takes a real argument and an inverse one must return a real angle, both
 * computed as the float domain computes them (`cos(90)` is 0). Anything else
 * is `InvalidArgumentError`. Hyperbolic functions take no angle.
 *
 * Errors: `x/0` is `DivisionByZeroError`; a part too large for a float is
 * `NumericRangeError`; a pole (`ln(0)`, `atanh(1)`, `cot(0)`) is
 * `InvalidArgumentError`. No result has a `NaN` or infinite part.
 */
import { Complex, isComplex } from '@arki/math/complex';
import { InvalidArgumentError, NumericRangeError } from '@arki/math/errors';

import type { Equation, Expr } from './ast.js';
import type {
  Binary,
  Builtin,
  CallOptions,
  Domain,
  ExactEquation,
  ExactFunction,
  HostTables,
  Scientific,
} from './exact.js';
import type { Angle } from './float-builtins.js';
import type { Language } from './language.js';
import type { ExactLimits, Limits } from './limits.js';
import type { Syntax } from './syntax.js';
import { compileEquationExact, compileExact, evaluateExact } from './exact.js';
import { trig } from './float-builtins.js';

export type { Complex } from '@arki/math/complex';
export type { Reading } from './bind.js';
export type { CallOptions, Detailed } from './exact.js';
export type { AbortSignalLike } from './float.js';
export type { Angle } from './float-builtins.js';
export type { ExactLimits } from './limits.js';

/**
 * A value for a variable or a host constant: a `Complex`, a finite number
 * (a real), or finite `{ re, im }` parts. Text is not a value: parse it.
 */
export type ComplexLike = Complex | number | { readonly re: number; readonly im: number };

/** A host function in this domain: Complexes in, a Complex out. */
export type ComplexFunction = (...args: Complex[]) => Complex;

/** Values for the declared variables. Extra keys are ignored. */
export type Scope<V extends string = string> = Readonly<Record<V, ComplexLike>>;

export type CompiledFunction<V extends string = string> = ExactFunction<Complex, ComplexLike, V>;
export type CompiledEquation<V extends string = string> = ExactEquation<Complex, ComplexLike, V>;

export type CompileOptions<L extends Language = Scientific, V extends string = string> = {
  /** The language the expression was parsed with. Default `scientific`. */
  readonly language?: L;
  /** The variables, in slot order. `i` cannot be one: it is a constant here. */
  readonly variables?: readonly V[];
  /** The unit of trigonometric arguments and inverse-trigonometric results. Default `'rad'`. */
  readonly angle?: Angle;
  readonly limits?: ExactLimits;
} & HostTables<L, ComplexFunction, ComplexLike>;

export type EvaluateOptions<L extends Language = Scientific> = CallOptions & {
  readonly language?: L;
  readonly syntax?: Syntax;
  readonly angle?: Angle;
  /** Parse budgets plus the compile budgets. */
  readonly limits?: Limits & ExactLimits;
} & HostTables<L, ComplexFunction, ComplexLike>;

type Fn = (z: Complex) => Complex;
type RealFn = (x: number) => number;

const real = (x: number): Complex => Complex.fromParts(x, 0);

/** `1 / z` inside `sec`, `acot`, …: zero is a pole, outside the domain as in float. */
function reciprocal(z: Complex, name: string): Complex {
  if (z.isZero()) throw new InvalidArgumentError(`${name} has a pole there: 1/0`);
  return z.inverse();
}

/** The float value on the real axis when float has one, otherwise the principal complex value. */
function lift(raw: RealFn, off: Fn): Fn {
  return z => {
    if (z.im === 0) {
      const x = raw(z.re);
      if (x - x === 0) return real(x);
    }
    return off(z);
  };
}

/** `1 / f(z)` (sec, coth, …), with float's `1 / g(x)` on the real axis: sech(800) is 0 there, as in float. */
const over = (f: Fn, g: RealFn, name: string): Fn =>
  lift(
    x => 1 / g(x),
    z => reciprocal(f(z), name),
  );
/** `f(1 / z)` (asec, acot, …), with float's `g(1 / x)` on the real axis: acot(0) is π/2 there, as in float. */
const under = (f: Fn, g: RealFn, name: string): Fn =>
  lift(
    x => g(1 / x),
    z => f(reciprocal(z, name)),
  );

const TRIG: readonly [string, Fn][] = [
  ['sin', z => z.sin()],
  ['cos', z => z.cos()],
  ['tan', z => z.tan()],
  ['sec', over(z => z.cos(), Math.cos, 'sec')],
  ['csc', over(z => z.sin(), Math.sin, 'csc')],
  ['cot', over(z => z.tan(), Math.tan, 'cot')],
  ['asin', z => z.asin()],
  ['acos', z => z.acos()],
  ['atan', z => z.atan()],
  ['asec', under(z => z.acos(), Math.acos, 'asec')],
  ['acsc', under(z => z.asin(), Math.asin, 'acsc')],
  ['acot', under(z => z.atan(), Math.atan, 'acot')],
];

const ANGLE_FREE: readonly [string, Fn][] = [
  ['sinh', z => z.sinh()],
  ['cosh', z => z.cosh()],
  ['tanh', z => z.tanh()],
  ['sech', over(z => z.cosh(), Math.cosh, 'sech')],
  ['csch', over(z => z.sinh(), Math.sinh, 'csch')],
  ['coth', over(z => z.tanh(), Math.tanh, 'coth')],
  ['asinh', z => z.asinh()],
  ['acosh', z => z.acosh()],
  ['atanh', z => z.atanh()],
  ['asech', under(z => z.acosh(), Math.acosh, 'asech')],
  ['acsch', under(z => z.asinh(), Math.asinh, 'acsch')],
  ['acoth', under(z => z.atanh(), Math.atanh, 'acoth')],
  ['exp', z => z.exp()],
  ['sqrt', z => z.sqrt()],
  ['abs', z => real(z.abs())],
];

/** `a ^ b`: float's `a ** b` when both are real and it is finite, else the principal power. */
const power: Binary<Complex, undefined> = (a, b) => {
  if (a.im === 0 && b.im === 0) {
    const x = a.re ** b.re;
    if (x - x === 0) return real(x);
  }
  return a.pow(b);
};

function functionsFor(angle: Angle): Map<string, Builtin<Complex, undefined>> {
  const table = new Map<string, Builtin<Complex, undefined>>();
  if (angle === 'deg') {
    // Real angles only: float's degree trigonometry (exact at multiples of 90°), else an error.
    for (const [name, builtin] of trig('deg')) {
      const raw = builtin.unary?.raw;
      const off: Fn = z => {
        throw new InvalidArgumentError(
          `${name}(${z.toString()}) has no real angle: in degrees, trigonometry takes and returns real angles`,
        );
      };
      table.set(name, { unary: raw === undefined ? off : lift(raw, off) });
    }
  } else {
    for (const [name, f] of TRIG) table.set(name, { unary: f });
  }
  for (const [name, f] of ANGLE_FREE) table.set(name, { unary: f });
  const log10 = lift(Math.log10, z => z.log(10));
  const log2 = lift(Math.log2, z => z.log(2));
  const ln = lift(Math.log, z => z.ln());
  table.set('ln', { unary: ln });
  table.set('log10', { unary: log10 });
  table.set('log2', { unary: log2 });
  table.set('log', {
    unary: ln,
    // log(x, 10) and log(x, 2) are log10 and log2, as in float: log(1000, 10) is 3.
    binary: (a, b) => {
      if (b.im === 0 && b.re === 10) return log10(a);
      if (b.im === 0 && b.re === 2) return log2(a);
      if (a.im === 0 && b.im === 0) {
        const x = Math.log(a.re) / Math.log(b.re);
        if (x - x === 0) return real(x);
      }
      return a.log(b);
    },
  });
  table.set('pow', { binary: power });
  return table;
}

const CONSTANTS = new Map<string, () => Complex>([
  ['pi', () => real(Math.PI)],
  ['e', () => real(Math.E)],
  ['i', () => Complex.I],
]);

function input(value: unknown): Complex | undefined {
  if (isComplex(value)) return value;
  if (typeof value === 'number') return real(value);
  if (typeof value === 'object' && value !== null) {
    const re: unknown = Reflect.get(value, 're');
    const im: unknown = Reflect.get(value, 'im');
    if (typeof re === 'number' && typeof im === 'number') return Complex.fromParts(re, im);
  }
  return undefined;
}

const domains = new Map<Angle, Domain<Complex, undefined>>();

/** The domain for an angle unit, built on first use (no work at module load). */
function domainFor(unit: unknown = 'rad'): Domain<Complex, undefined> {
  if (unit !== 'rad' && unit !== 'deg') throw new InvalidArgumentError(`options.angle must be 'rad' or 'deg'`);
  let domain = domains.get(unit);
  if (domain === undefined) {
    domain = {
      name: 'complex',
      approximate: true,
      literal: raw => {
        const value = Number(raw);
        if (!Number.isFinite(value)) throw new NumericRangeError(`The literal ${raw} is too large for a number`);
        return real(value);
      },
      input,
      is: isComplex,
      large: () => false,
      negate: a => a.negated(),
      ops: {
        '+': (a, b) => a.plus(b),
        '-': (a, b) => a.minus(b),
        '*': (a, b) => a.times(b),
        '/': (a, b) => a.dividedBy(b),
        '^': power,
      },
      functions: functionsFor(unit),
      constants: CONSTANTS,
    };
    domains.set(unit, domain);
  }
  return domain;
}

/**
 * Compiles an expression to a function of its declared variables, on
 * Complexes. Throws `ParseError` (`unknown-name`, `name-conflict` — `i` is a
 * constant here —, `not-in-domain` for `cbrt nthRoot sign ceil floor round fix
 * mod factorial gamma`, `arity`) and `ExprLimitError` here, before any
 * evaluation. Constant subtrees are folded.
 *
 * ```ts
 * compile(parse('sqrt(x)'), { variables: ['x'] })({ x: -4 }).toString(); // '2i'
 * ```
 */
export function compile<const V extends string = never, L extends Language = Scientific>(
  expr: Expr,
  options?: CompileOptions<L, V>,
): CompiledFunction<V> {
  return compileExact(domainFor(options?.angle), undefined, expr, [...(options?.variables ?? [])], options ?? {});
}

/** Compiles both sides of `lhs = rhs` and their difference, on one set of slots. */
export function compileEquation<const V extends string = never, L extends Language = Scientific>(
  equation: Equation,
  options?: CompileOptions<L, V>,
): CompiledEquation<V> {
  return compileEquationExact(
    domainFor(options?.angle),
    undefined,
    equation,
    [...(options?.variables ?? [])],
    options ?? {},
  );
}

/** Parses, compiles and evaluates an expression with no variables: `evaluate('sqrt(-4)')` is `2i`. */
export function evaluate<L extends Language = Scientific>(text: string, options?: EvaluateOptions<L>): Complex {
  return evaluateExact(domainFor(options?.angle), undefined, text, options ?? {});
}
