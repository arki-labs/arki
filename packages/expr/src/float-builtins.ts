/**
 * The `scientific` functions and constants in the float domain (RFC §8).
 * Each function has a `raw` IEEE form, which may return `NaN` or ±Infinity
 * (the `sample` tree turns those into gaps), and a `checked` form, which
 * throws `@arki/math`'s typed errors instead (the `f()` / `f.at()` tree).
 *
 * The rule for a non-finite raw result: `NaN`, or ±Infinity from a function
 * that cannot overflow (a pole such as `ln(0)` or `cot(0)`), is outside the
 * domain (`InvalidArgumentError`); ±Infinity from one that can (`exp`,
 * `cosh`, `^`) is `NumericRangeError`.
 */
import { gamma } from '@arki/math/distributions';
import { DivisionByZeroError, InvalidArgumentError, NumericRangeError } from '@arki/math/errors';
import { factorial as integerFactorial } from '@arki/math/integer';

export type Angle = 'rad' | 'deg';

export type Unary = (a: number) => number;
export type Binary = (a: number, b: number) => number;

export type Impl<F> = { readonly raw: F; readonly checked: F };

/** A built-in function: its one-argument and two-argument forms (`log(x)`, `log(x, b)`). */
export type Builtin = { readonly unary?: Impl<Unary>; readonly binary?: Impl<Binary> };

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

function failure(call: string, result: number, overflows: boolean): Error {
  return Number.isNaN(result) || !overflows
    ? new InvalidArgumentError(`${call} is not defined`)
    : new NumericRangeError(`${call} is too large for a number`);
}

function unary(name: string, raw: Unary, overflows = false): Impl<Unary> {
  return {
    raw,
    checked: a => {
      const result = raw(a);
      if (result - result === 0) return result;
      throw failure(`${name}(${a})`, result, overflows);
    },
  };
}

function binary(name: string, raw: Binary): Impl<Binary> {
  return {
    raw,
    checked: (a, b) => {
      const result = raw(a, b);
      if (result - result === 0) return result;
      throw failure(`${name}(${a}, ${b})`, result, false);
    },
  };
}

/** `a ^ b`, shared by the operator and `pow`. `0 ^ -1` divides by zero. */
export function powChecked(a: number, b: number): number {
  const result = a ** b;
  if (result - result === 0) return result;
  if (a === 0) throw new DivisionByZeroError(`0^${b} divides by zero`);
  if (Number.isNaN(result)) throw new InvalidArgumentError(`${a}^${b} is not a real number`);
  throw new NumericRangeError(`${a}^${b} is too large for a number`);
}

export const pow: Impl<Binary> = { raw: (a, b) => a ** b, checked: powChecked };

// Degree trigonometry reduces the angle mod 360 first (exact in IEEE), and
// multiples of 90° give exact results: sin(180°) is 0 and tan(90°) is a pole,
// not 1.2e-16 and 1.6e16.
function quarter(reduced: number): number {
  return (((reduced / 90) % 4) + 4) % 4;
}

function sinDeg(a: number): number {
  const r = a % 360;
  if (r % 90 !== 0) return Math.sin(r * RAD);
  const q = quarter(r);
  return q === 1 ? 1 : q === 3 ? -1 : 0;
}

function cosDeg(a: number): number {
  const r = a % 360;
  if (r % 90 !== 0) return Math.cos(r * RAD);
  const q = quarter(r);
  return q === 0 ? 1 : q === 2 ? -1 : 0;
}

function tanDeg(a: number): number {
  const r = a % 180;
  if (r % 90 !== 0) return Math.tan(r * RAD);
  return r === 0 ? 0 : Number.POSITIVE_INFINITY;
}

function factorialRaw(a: number): number {
  if (Number.isInteger(a) && a < 0) return Number.NaN;
  if (a > 171) return Number.POSITIVE_INFINITY;
  try {
    return gamma(a + 1);
  } catch {
    return Number.NaN;
  }
}

/** Integers up to 18 by `@arki/math/integer` (exact), everything else by `gamma(a + 1)`. */
function factorialChecked(a: number): number {
  if (Number.isInteger(a)) {
    if (a < 0) throw new InvalidArgumentError(`factorial(${a}) is not defined: it needs n >= 0`);
    if (a <= 18) return integerFactorial(a);
    if (a > 170) throw new NumericRangeError(`factorial(${a}) is too large for a number`);
  }
  return gamma(a + 1);
}

/** Half away from zero, as calculators round. */
function round(a: number): number {
  return a < 0 ? -Math.round(-a) : Math.round(a);
}

/** Floored modulo: the result has the sign of the divisor. */
function modRaw(a: number, b: number): number {
  if (b === 0) return Number.NaN;
  const r = a % b;
  return r !== 0 && r < 0 !== b < 0 ? r + b : r;
}

function nthRootRaw(a: number, n: number): number {
  if (n === 0) return Number.NaN;
  if (a >= 0) return a ** (1 / n);
  return Number.isInteger(n) && n % 2 !== 0 ? -((-a) ** (1 / n)) : Number.NaN;
}

const ln = unary('ln', Math.log);

function trig(angle: Angle): [string, Builtin][] {
  const deg = angle === 'deg';
  const sin = deg ? sinDeg : Math.sin;
  const cos = deg ? cosDeg : Math.cos;
  const tan = deg ? tanDeg : Math.tan;
  const out = (f: Unary): Unary => (deg ? (a: number) => f(a) * DEG : f);
  return [
    ['sin', { unary: unary('sin', sin) }],
    ['cos', { unary: unary('cos', cos) }],
    ['tan', { unary: unary('tan', tan) }],
    ['sec', { unary: unary('sec', a => 1 / cos(a)) }],
    ['csc', { unary: unary('csc', a => 1 / sin(a)) }],
    ['cot', { unary: unary('cot', deg ? a => cosDeg(a) / sinDeg(a) : a => 1 / Math.tan(a)) }],
    ['asin', { unary: unary('asin', out(Math.asin)) }],
    ['acos', { unary: unary('acos', out(Math.acos)) }],
    ['atan', { unary: unary('atan', out(Math.atan)) }],
    [
      'asec',
      {
        unary: unary(
          'asec',
          out(a => Math.acos(1 / a)),
        ),
      },
    ],
    [
      'acsc',
      {
        unary: unary(
          'acsc',
          out(a => Math.asin(1 / a)),
        ),
      },
    ],
    [
      'acot',
      {
        unary: unary(
          'acot',
          out(a => Math.atan(1 / a)),
        ),
      },
    ],
  ];
}

const ANGLE_FREE: readonly [string, Builtin][] = [
  ['sinh', { unary: unary('sinh', Math.sinh, true) }],
  ['cosh', { unary: unary('cosh', Math.cosh, true) }],
  ['tanh', { unary: unary('tanh', Math.tanh) }],
  ['sech', { unary: unary('sech', a => 1 / Math.cosh(a)) }],
  ['csch', { unary: unary('csch', a => 1 / Math.sinh(a)) }],
  ['coth', { unary: unary('coth', a => 1 / Math.tanh(a)) }],
  ['asinh', { unary: unary('asinh', Math.asinh) }],
  ['acosh', { unary: unary('acosh', Math.acosh) }],
  ['atanh', { unary: unary('atanh', Math.atanh) }],
  ['asech', { unary: unary('asech', a => Math.acosh(1 / a)) }],
  ['acsch', { unary: unary('acsch', a => Math.asinh(1 / a)) }],
  ['acoth', { unary: unary('acoth', a => Math.atanh(1 / a)) }],
  ['exp', { unary: unary('exp', Math.exp, true) }],
  ['ln', { unary: ln }],
  ['log', { unary: ln, binary: binary('log', (a, b) => Math.log(a) / Math.log(b)) }],
  ['log10', { unary: unary('log10', Math.log10) }],
  ['log2', { unary: unary('log2', Math.log2) }],
  ['sqrt', { unary: unary('sqrt', Math.sqrt) }],
  ['cbrt', { unary: unary('cbrt', Math.cbrt) }],
  ['nthRoot', { unary: unary('nthRoot', Math.sqrt), binary: binary('nthRoot', nthRootRaw) }],
  ['pow', { binary: pow }],
  ['abs', { unary: unary('abs', Math.abs) }],
  ['sign', { unary: unary('sign', Math.sign) }],
  ['ceil', { unary: unary('ceil', Math.ceil) }],
  ['floor', { unary: unary('floor', Math.floor) }],
  ['round', { unary: unary('round', round) }],
  ['fix', { unary: unary('fix', Math.trunc) }],
  ['factorial', { unary: { raw: factorialRaw, checked: factorialChecked } }],
  [
    'mod',
    {
      binary: {
        raw: modRaw,
        checked: (a, b) => {
          if (b === 0) throw new DivisionByZeroError(`mod(${a}, 0) divides by zero`);
          return modRaw(a, b);
        },
      },
    },
  ],
];

const tables = new Map<Angle, ReadonlyMap<string, Builtin>>();

/** The built-in functions for an angle unit, built on first use (no work at module load). */
export function builtins(angle: Angle): ReadonlyMap<string, Builtin> {
  let table = tables.get(angle);
  if (table === undefined) {
    table = new Map([...trig(angle), ...ANGLE_FREE]);
    tables.set(angle, table);
  }
  return table;
}

/** `pi` and `e` as doubles. `i` is a constant of `scientific` but not of this domain. */
export const FLOAT_CONSTANTS: ReadonlyMap<string, number> = new Map([
  ['pi', Math.PI],
  ['e', Math.E],
]);
