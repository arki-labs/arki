/**
 * Complex numbers on plain JS floats (`number`). A `Complex` is an immutable
 * value with finite `re` and `im` parts, and it uses the same verbs as
 * `Decimal`: `plus`, `minus`, `times`, `dividedBy`, `negated`, `abs`, `pow`,
 * `eq`.
 *
 * Results are approximate like any float math, with one rule kept exact:
 * an integer power is computed by repeated multiplication, so
 * `complex(1, 1).pow(2)` is exactly `2i`.
 *
 * There is no `NaN` or `Infinity` channel. Division by zero throws
 * `DivisionByZeroError`; a result too large for a float throws
 * `NumericRangeError`. Results never carry `-0`, so the principal argument
 * is always in `(-π, π]` and `ln(-1)` is `πi`, never `-πi`.
 *
 * Text format: `toString()` prints `3 + 4i`, `3 - 4i`, `-2i`, `i`, `5`.
 * Each part uses JS shortest round-trip number text (`1e-7`, `1e+21`), so
 * `Complex.from(z.toString())` gives back `z` exactly. The parser accepts
 * that format with or without spaces around the middle sign (`3+4i`), and
 * rejects anything else (`i4`, `3 + -4i`, `NaN`, `Infinity`, `3+4j`).
 */

import { DivisionByZeroError, InvalidArgumentError, NumberFormatError, NumericRangeError } from './errors.js';
import { assertFinite } from './number.js';

/** Anything `Complex.from` accepts: a `Complex`, a finite number, or text like `'3+4i'`. */
export type ComplexInput = Complex | number | string;

/** Polar form: modulus `r` (≥ 0) and argument `theta` in radians. */
export type Polar = {
  r: number;
  theta: number;
};

const BRAND = Symbol('arki.math.complex');

function refuseCoercion(): never {
  throw new TypeError(
    'A Complex cannot be used as a number. Read .re / .im, or use .plus()/.times()/... for complex arithmetic',
  );
}

/** Builds a result, turning overflow into a typed error and `-0` into `0`. */
function result(re: number, im: number, operation: string): Complex {
  if (!Number.isFinite(re) || !Number.isFinite(im)) {
    throw new NumericRangeError(`${operation} overflows the float range`);
  }
  return Complex.fromParts(re, im);
}

const NUMBER = String.raw`(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+|E[+-]?\d+)?`;
const REAL_ONLY = new RegExp(String.raw`^([+-]?${NUMBER})$`);
const IMAGINARY_ONLY = new RegExp(String.raw`^([+-]?)(${NUMBER})?i$`);
const BOTH = new RegExp(String.raw`^([+-]?${NUMBER})\s*([+-])\s*(${NUMBER})?i$`);

function parseComplex(input: string): Complex {
  const text = input.trim();
  let re = '0';
  let im = '0';
  let match = REAL_ONLY.exec(text);
  if (match) {
    re = match[1] ?? '0';
  } else if ((match = IMAGINARY_ONLY.exec(text))) {
    im = `${match[1] ?? ''}${match[2] ?? '1'}`;
  } else if ((match = BOTH.exec(text))) {
    re = match[1] ?? '0';
    im = `${match[2] ?? '+'}${match[3] ?? '1'}`;
  } else {
    throw new NumberFormatError(`"${input}" is not a complex number (expected forms like 3+4i, -2i, 5)`);
  }
  const reValue = Number(re);
  const imValue = Number(im);
  if (!Number.isFinite(reValue) || !Number.isFinite(imValue)) {
    throw new NumericRangeError(`"${input}" is outside the float range`);
  }
  return Complex.fromParts(reValue, imValue);
}

/** `x` as complex-number text, dropping a leading `1` before `i`. */
function imaginaryText(x: number): string {
  if (x === 1) return 'i';
  if (x === -1) return '-i';
  return `${x}i`;
}

/**
 * An immutable complex number `re + im·i` with finite float parts. Create one
 * with `complex(3, 4)`, `complex('3+4i')` or `Complex.fromPolar(r, theta)`.
 * Equality (`eq`) is exact; use `approxEqual` after float arithmetic.
 */
export class Complex {
  static readonly ZERO: Complex = new Complex(0, 0, BRAND);
  static readonly ONE: Complex = new Complex(1, 0, BRAND);
  static readonly I: Complex = new Complex(0, 1, BRAND);

  readonly re: number;
  readonly im: number;

  private constructor(re: number, im: number, brand: typeof BRAND) {
    if (brand !== BRAND) throw new TypeError('Use complex(re, im) instead of new Complex()');
    this.re = re;
    this.im = im;
    Object.freeze(this);
  }

  /** Builds `re + im·i` from finite parts. `-0` becomes `0`. */
  static fromParts(re: number, im: number): Complex {
    assertFinite(re, 're');
    assertFinite(im, 'im');
    return new Complex(re + 0, im + 0, BRAND);
  }

  /** Converts a number, a `Complex`, or text such as `'3+4i'`, `'-2i'`, `'5'`. */
  static from(value: ComplexInput): Complex {
    if (value instanceof Complex) return value;
    if (typeof value === 'number') return Complex.fromParts(value, 0);
    if (typeof value === 'string') return parseComplex(value);
    throw new TypeError('expected a Complex, a number, or a string');
  }

  /** `r·(cos θ + i·sin θ)`. `r` must be ≥ 0; both must be finite. */
  static fromPolar(r: number, theta: number): Complex {
    assertFinite(r, 'r');
    assertFinite(theta, 'theta');
    if (r < 0) throw new InvalidArgumentError(`r must be non-negative, got ${r}`);
    return result(r * Math.cos(theta), r * Math.sin(theta), 'fromPolar');
  }

  plus(other: ComplexInput): Complex {
    const that = Complex.from(other);
    return result(this.re + that.re, this.im + that.im, 'plus');
  }

  minus(other: ComplexInput): Complex {
    const that = Complex.from(other);
    return result(this.re - that.re, this.im - that.im, 'minus');
  }

  times(other: ComplexInput): Complex {
    const that = Complex.from(other);
    return result(this.re * that.re - this.im * that.im, this.re * that.im + this.im * that.re, 'times');
  }

  /** Smith's algorithm, which avoids overflow in `|divisor|²`. Throws on a zero divisor. */
  dividedBy(other: ComplexInput): Complex {
    const that = Complex.from(other);
    if (that.isZero()) throw new DivisionByZeroError(`${this.toString()} divided by zero`);
    const { re: a, im: b } = this;
    const { re: c, im: d } = that;
    if (Math.abs(c) >= Math.abs(d)) {
      const ratio = d / c;
      const denominator = c + d * ratio;
      return result((a + b * ratio) / denominator, (b - a * ratio) / denominator, 'dividedBy');
    }
    const ratio = c / d;
    const denominator = c * ratio + d;
    return result((a * ratio + b) / denominator, (b * ratio - a) / denominator, 'dividedBy');
  }

  /** `1 / z`. Throws `DivisionByZeroError` for zero. */
  inverse(): Complex {
    return Complex.ONE.dividedBy(this);
  }

  negated(): Complex {
    return Complex.fromParts(-this.re, -this.im);
  }

  /** `re - im·i`. */
  conjugate(): Complex {
    return Complex.fromParts(this.re, -this.im);
  }

  /** Modulus `|z|`, via `Math.hypot` so large parts do not overflow. */
  abs(): number {
    return Math.hypot(this.re, this.im);
  }

  /** Principal argument in `(-π, π]`. The argument of zero is `0`, as in C's `carg`. */
  arg(): number {
    return Math.atan2(this.im, this.re);
  }

  toPolar(): Polar {
    return { r: this.abs(), theta: this.arg() };
  }

  /** `e^z`. */
  exp(): Complex {
    const scale = Math.exp(this.re);
    if (this.im === 0) return result(scale, 0, 'exp');
    return result(scale * Math.cos(this.im), scale * Math.sin(this.im), 'exp');
  }

  /** Principal natural logarithm `ln|z| + i·arg(z)`. Throws `InvalidArgumentError` for zero. */
  ln(): Complex {
    if (this.isZero()) throw new InvalidArgumentError('ln is not defined at zero');
    return result(Math.log(this.abs()), this.arg(), 'ln');
  }

  /** Principal logarithm in `base`: `ln(z) / ln(base)`. `base` must not be 0 or 1. */
  log(base: ComplexInput): Complex {
    const b = Complex.from(base);
    if (b.isZero() || b.eq(Complex.ONE)) {
      throw new InvalidArgumentError(`log base must not be 0 or 1, got ${b.toString()}`);
    }
    return this.ln().dividedBy(b.ln());
  }

  /** Principal square root: the root with `re > 0`, or `im ≥ 0` when `re` is 0. */
  sqrt(): Complex {
    if (this.isZero()) return Complex.ZERO;
    const { re, im } = this;
    // t = sqrt((|re| + |z|) / 2) never cancels; the other part is im / 2t.
    const t = Math.sqrt((Math.abs(re) + this.abs()) / 2);
    if (re >= 0) return result(t, im / (2 * t), 'sqrt');
    return result(Math.abs(im) / (2 * t), im < 0 ? -t : t, 'sqrt');
  }

  /**
   * Principal power `z^w = e^(w·ln z)`. An integer `w` uses repeated
   * multiplication (exact for small Gaussian integers); a real `w` uses polar
   * form (`|z|^w` at angle `w·arg z`). `0^w` is `1` for `w = 0` and `0` when
   * `re(w) > 0`; otherwise it throws `DivisionByZeroError`.
   */
  pow(exponent: ComplexInput): Complex {
    const w = Complex.from(exponent);
    if (w.im === 0 && Number.isInteger(w.re)) return this.integerPower(w.re);
    if (this.isZero()) {
      if (w.re > 0) return Complex.ZERO;
      throw new DivisionByZeroError(`0 raised to ${w.toString()}`);
    }
    if (w.im === 0) {
      const magnitude = this.abs() ** w.re;
      const angle = this.arg() * w.re;
      if (angle === 0) return result(magnitude, 0, 'pow');
      return result(magnitude * Math.cos(angle), magnitude * Math.sin(angle), 'pow');
    }
    const logModulus = Math.log(this.abs());
    const angle = this.arg();
    return Complex.fromParts(w.re * logModulus - w.im * angle, w.re * angle + w.im * logModulus).exp();
  }

  private integerPower(n: number): Complex {
    if (n === 0) return Complex.ONE;
    if (this.isZero()) {
      if (n > 0) return Complex.ZERO;
      throw new DivisionByZeroError(`0 raised to ${n}`);
    }
    // Invert first so a tiny result underflows to 0 instead of a huge
    // intermediate overflowing.
    const base = n < 0 ? this.inverse() : this;
    let re = 1;
    let im = 0;
    let remaining = Math.abs(n);
    let baseRe = base.re;
    let baseIm = base.im;
    while (remaining > 0) {
      if (remaining % 2 === 1) {
        const nextRe = re * baseRe - im * baseIm;
        im = re * baseIm + im * baseRe;
        re = nextRe;
      }
      remaining = Math.floor(remaining / 2);
      if (remaining > 0) {
        const squaredRe = baseRe * baseRe - baseIm * baseIm;
        baseIm = 2 * baseRe * baseIm;
        baseRe = squaredRe;
      }
    }
    return result(re, im, 'pow');
  }

  /**
   * All `n` complex `n`-th roots, counter-clockwise from the principal root
   * (index 0, the one `pow(1/n)` returns). Zero has `n` roots, all zero.
   */
  nthRoots(n: number): Complex[] {
    if (!Number.isSafeInteger(n) || n < 1) {
      throw new InvalidArgumentError(`n must be a positive safe integer, got ${n}`);
    }
    if (this.isZero()) return Array.from({ length: n }, () => Complex.ZERO);
    const modulus = this.abs() ** (1 / n);
    const angle = this.arg();
    const roots: Complex[] = [];
    for (let k = 0; k < n; k++) {
      const theta = (angle + 2 * Math.PI * k) / n;
      roots.push(
        theta === 0
          ? result(modulus, 0, 'nthRoots')
          : result(modulus * Math.cos(theta), modulus * Math.sin(theta), 'nthRoots'),
      );
    }
    return roots;
  }

  isReal(): boolean {
    return this.im === 0;
  }

  isZero(): boolean {
    return this.re === 0 && this.im === 0;
  }

  /** Exact equality of both parts. */
  eq(other: ComplexInput): boolean {
    const that = Complex.from(other);
    return this.re === that.re && this.im === that.im;
  }

  /**
   * `|z - w| ≤ tolerance × max(1, |z|, |w|)`: absolute near zero, relative
   * for large values, like `approxEqual` for numbers.
   */
  approxEqual(other: ComplexInput, tolerance = 1e-9): boolean {
    const that = Complex.from(other);
    assertFinite(tolerance, 'tolerance');
    if (tolerance < 0) throw new InvalidArgumentError('tolerance must be non-negative');
    const distance = Math.hypot(this.re - that.re, this.im - that.im);
    return distance <= tolerance * Math.max(1, this.abs(), that.abs());
  }

  /** `3 + 4i`, `3 - 4i`, `-2i`, `i`, `5` (see the module notes for the grammar). */
  toString(): string {
    if (this.im === 0) return `${this.re}`;
    if (this.re === 0) return imaginaryText(this.im);
    const sign = this.im < 0 ? '-' : '+';
    return `${this.re} ${sign} ${imaginaryText(Math.abs(this.im))}`;
  }

  toJSON(): string {
    return this.toString();
  }

  /** Console display in Node and Bun: `Complex(3 + 4i)`. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `Complex(${this.toString()})`;
  }

  /** Console display in Deno. */
  [Symbol.for('Deno.customInspect')](): string {
    return `Complex(${this.toString()})`;
  }

  /** Throws. A `Complex` never silently becomes a float. */
  valueOf(): never {
    return refuseCoercion();
  }

  [Symbol.toPrimitive](hint: 'string' | 'number' | 'default'): string {
    return hint === 'string' ? this.toString() : refuseCoercion();
  }

  readonly [Symbol.toStringTag] = 'Complex';
}

/** `complex(3, 4)` is `3 + 4i`; `complex(5)` is real; `complex('3+4i')` parses. */
export function complex(re: number, im?: number): Complex;
export function complex(value: Complex | string): Complex;
export function complex(first: ComplexInput, im?: number): Complex {
  if (im === undefined) return Complex.from(first);
  if (typeof first !== 'number') throw new TypeError('complex(re, im) takes two numbers');
  return Complex.fromParts(first, im);
}

export function isComplex(value: unknown): value is Complex {
  return value instanceof Complex;
}
