/**
 * `@arki/expr/rational`: the Rational domain (RFC §8). Values are
 * `Rational`s from `@arki/math/rational`; literals are read from their text,
 * so `0.1` is exactly 1/10.
 *
 * Never rounds. `+ - * /` and integer powers are exact. A root or a
 * non-integer power is computed only when the result is rational
 * (`8^(2/3)` is 4, `sqrt(9/4)` is 3/2); otherwise it throws
 * `RoundingNecessaryError`: the exact answer exists but this type cannot
 * hold it. Logarithms, `exp`, trigonometry and the constants `pi`, `e` have
 * no rational value and are a compile-time `not-in-domain`.
 */
import type { RationalInput } from '@arki/math/rational';
import { decimal, isDecimal } from '@arki/math/decimal';
import { nthRoot } from '@arki/math/decimal-math';
import { DivisionByZeroError, InvalidArgumentError, RoundingNecessaryError } from '@arki/math/errors';
import { isRational, ratio, Rational } from '@arki/math/rational';

import type { Equation, Expr } from './ast.js';
import type {
  Builtin,
  CallOptions,
  Domain,
  Env,
  ExactEquation,
  ExactFunction,
  HostTables,
  Scientific,
} from './exact.js';
import type { Language } from './language.js';
import type { ExactLimits, Limits } from './limits.js';
import type { Syntax } from './syntax.js';
import {
  compileEquationExact,
  compileExact,
  evaluateExact,
  factorialOf,
  LARGE,
  log10Abs,
  powerBudget,
  rationalSize,
  unitPower,
} from './exact.js';

export type { Rational, RationalInput } from '@arki/math/rational';
export type { Reading } from './bind.js';
export type { CallOptions, Detailed } from './exact.js';
export type { AbortSignalLike } from './float.js';
export type { ExactLimits } from './limits.js';

type RationalEnv = Env<undefined>;

/** A host function in this domain: Rationals in, a Rational out. */
export type RationalFunction = (...args: Rational[]) => Rational;

/** Values for the declared variables: anything `ratio()` accepts. Extra keys are ignored. */
export type Scope<V extends string = string> = Readonly<Record<V, RationalInput>>;

export type CompiledFunction<V extends string = string> = ExactFunction<Rational, RationalInput, V>;
export type CompiledEquation<V extends string = string> = ExactEquation<Rational, RationalInput, V>;

export type CompileOptions<L extends Language = Scientific, V extends string = string> = {
  /** The language the expression was parsed with. Default `scientific`. */
  readonly language?: L;
  /** The variables, in slot order. Any other name must be a constant or split into declared letters. */
  readonly variables?: readonly V[];
  readonly limits?: ExactLimits;
} & HostTables<L, RationalFunction, RationalInput>;

export type EvaluateOptions<L extends Language = Scientific> = CallOptions & {
  readonly language?: L;
  readonly syntax?: Syntax;
  /** Parse budgets plus the compile budgets. */
  readonly limits?: Limits & ExactLimits;
} & HostTables<L, RationalFunction, RationalInput>;

/** ⌊n / d⌋ for d > 0. */
function floorOf(n: bigint, d: bigint): bigint {
  const q = n / d;
  return n % d !== 0n && n < 0n ? q - 1n : q;
}

/** The exact n-th root of `value >= 0`, or `undefined` when it is not an integer. */
function integerRoot(value: bigint, n: number): bigint | undefined {
  const root = nthRoot(decimal(value), n, { scale: 0, rounding: 'down' }).toBigInt();
  if (root <= 1n) return root === value ? root : undefined;
  return root ** BigInt(n) === value ? root : undefined;
}

/** The n-th root of `x` when it is rational, otherwise `undefined`. */
function rootOf(x: Rational, n: number): Rational | undefined {
  const top = integerRoot(x.isNegative() ? -x.numerator : x.numerator, n);
  const bottom = integerRoot(x.denominator, n);
  if (top === undefined || bottom === undefined) return undefined;
  return Rational.fromParts(x.isNegative() ? -top : top, bottom);
}

function notRational(what: string): RoundingNecessaryError {
  return new RoundingNecessaryError(`${what} is not rational: the rational domain cannot hold it`);
}

/** sqrt, cbrt and nthRoot: the root when it is rational. */
function exactRoot(x: Rational, n: number, name: string): Rational {
  if (x.isNegative() && n % 2 === 0) throw new InvalidArgumentError(`${name}(${x.toString()}) is not real`);
  const root = rootOf(x, n);
  if (root === undefined) throw notRational(`${name}(${x.toString()})`);
  return root;
}

function power(a: Rational, b: Rational, env: RationalEnv): Rational {
  const size = rationalSize(a);
  if (b.isInteger()) {
    if (size === 0) return ratio(unitPower(a.sign(), b.numerator));
    powerBudget(size, Number(b.numerator), env.digits);
    return a.pow(Number(b.numerator));
  }
  // a^(p/q) = (q-th root of a)^p, when that root is rational.
  if (a.isNegative()) throw new InvalidArgumentError(`${a.toString()}^(${b.toString()}) is not a real number`);
  if (a.isZero()) {
    if (b.isNegative()) throw new DivisionByZeroError(`0^(${b.toString()}) divides by zero`);
    return a;
  }
  if (size === 0) return a;
  powerBudget(size, 10 ** (log10Abs(b.numerator) - log10Abs(b.denominator)), env.digits);
  const q = Number(b.denominator);
  // A root of degree q of anything but 1 needs at least q bits; size > 0 here, so a huge q has no exact root.
  const root = Number.isSafeInteger(q) && q <= 4 * size + 4 ? rootOf(a, q) : undefined;
  if (root === undefined) throw notRational(`${a.toString()}^(${b.toString()})`);
  return root.pow(Number(b.numerator));
}

function degree(n: Rational): number {
  const value = n.isInteger() && n.isPositive() ? Number(n.numerator) : 0;
  if (Number.isSafeInteger(value) && value > 0) return value;
  throw new InvalidArgumentError(`nthRoot needs a positive integer degree, got ${n.toString()}`);
}

/** Floored modulo, as in float: the result has the sign of the divisor. */
function mod(a: Rational, b: Rational): Rational {
  if (b.isZero()) throw new DivisionByZeroError(`mod(${a.toString()}, 0) divides by zero`);
  const q = a.dividedBy(b);
  return a.minus(b.times(floorOf(q.numerator, q.denominator)));
}

function factorial(x: Rational, env: RationalEnv): Rational {
  if (!x.isInteger()) {
    throw new InvalidArgumentError(
      `factorial(${x.toString()}) needs an integer: the rational domain has no gamma function`,
    );
  }
  return ratio(factorialOf(x.numerator, env.digits, x.toString()));
}

const sqrt = (x: Rational): Rational => exactRoot(x, 2, 'sqrt');

const FUNCTIONS = new Map<string, Builtin<Rational, undefined>>([
  ['sqrt', { unary: sqrt }],
  ['cbrt', { unary: x => exactRoot(x, 3, 'cbrt') }],
  ['nthRoot', { unary: sqrt, binary: (x, n) => exactRoot(x, degree(n), 'nthRoot') }],
  ['pow', { binary: power }],
  ['abs', { unary: x => x.abs() }],
  ['sign', { unary: x => ratio(x.sign()) }],
  ['ceil', { unary: x => ratio(-floorOf(-x.numerator, x.denominator)) }],
  ['floor', { unary: x => ratio(floorOf(x.numerator, x.denominator)) }],
  [
    // Half away from zero, as calculators (and the float domain) round.
    'round',
    {
      unary: x => {
        const half = floorOf(2n * (x.isNegative() ? -x.numerator : x.numerator) + x.denominator, 2n * x.denominator);
        return ratio(x.isNegative() ? -half : half);
      },
    },
  ],
  ['fix', { unary: x => ratio(x.numerator / x.denominator) }],
  ['factorial', { unary: factorial }],
  ['mod', { binary: mod }],
]);

const DOMAIN: Domain<Rational, undefined> = {
  name: 'rational',
  literal: raw => ratio(raw),
  input: value =>
    isRational(value) ||
    isDecimal(value) ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint'
      ? ratio(value)
      : undefined,
  is: isRational,
  large: value => value.denominator >= LARGE || (value.numerator < 0n ? -value.numerator : value.numerator) >= LARGE,
  negate: a => a.negated(),
  ops: {
    '+': (a, b) => a.plus(b),
    '-': (a, b) => a.minus(b),
    '*': (a, b) => a.times(b),
    '/': (a, b) => {
      if (b.isZero()) throw new DivisionByZeroError(`Division by zero: ${a.toString()} / 0`);
      return a.dividedBy(b);
    },
    '^': power,
  },
  functions: FUNCTIONS,
  constants: new Map(),
};

/**
 * Compiles an expression to a function of its declared variables, on
 * Rationals. Throws `ParseError` (`unknown-name`, `name-conflict`,
 * `not-in-domain` for `exp`, logarithms, trigonometry, `pi`, `e`, `i`,
 * `arity`) and `ExprLimitError` here, before any evaluation. Constant
 * subtrees are folded.
 *
 * ```ts
 * compile(parse('x/3 + 1/6'), { variables: ['x'] })({ x: '0.5' }).toString(); // '1/3'
 * ```
 */
export function compile<const V extends string = never, L extends Language = Scientific>(
  expr: Expr,
  options?: CompileOptions<L, V>,
): CompiledFunction<V> {
  return compileExact(DOMAIN, undefined, expr, [...(options?.variables ?? [])], options ?? {});
}

/** Compiles both sides of `lhs = rhs` and their difference, on one set of slots. */
export function compileEquation<const V extends string = never, L extends Language = Scientific>(
  equation: Equation,
  options?: CompileOptions<L, V>,
): CompiledEquation<V> {
  return compileEquationExact(DOMAIN, undefined, equation, [...(options?.variables ?? [])], options ?? {});
}

/** Parses, compiles and evaluates an expression with no variables: `evaluate('8^(2/3)')` is 4. */
export function evaluate<L extends Language = Scientific>(text: string, options?: EvaluateOptions<L>): Rational {
  return evaluateExact(DOMAIN, undefined, text, options ?? {});
}
