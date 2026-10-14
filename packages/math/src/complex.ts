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

/**
 * `ln|z|`. Uses `ln(re² + im²) / 2` while that sum is a normal float: it skips
 * `Math.hypot` and is at least as accurate (checked against 60-digit references).
 * Falls back to `ln(hypot)` near overflow or underflow.
 */
function logModulus(re: number, im: number): number {
  const squares = re * re + im * im;
  if (squares > 1e-290 && squares < Infinity) return 0.5 * Math.log(squares);
  const modulus = Math.hypot(re, im);
  // |z| can exceed Number.MAX_VALUE (by up to √2) while ln|z| is about 710: halve, then add ln 2.
  return modulus === Infinity ? Math.log(Math.hypot(re / 2, im / 2)) + Math.LN2 : Math.log(modulus);
}

/** `|z|^p`, also when `|z|` itself (up to √2 × `Number.MAX_VALUE`) does not fit a float. */
function modulusPower(re: number, im: number, p: number): number {
  const modulus = Math.hypot(re, im);
  return modulus === Infinity ? Math.hypot(re / 2, im / 2) ** p * 2 ** p : modulus ** p;
}

/** Division scaling thresholds (Baudin & Smith 2012), with ε = 2⁻⁵³. */
const HALF_MAX = Number.MAX_VALUE / 2;
/** 2⁻¹⁰²² · 2 / ε: below this, parts are scaled up before dividing. */
const TINY = 2 ** -968;
/** 2 / ε², the exact power of two used to scale tiny parts up. */
const UPSCALE = 2 ** 107;

/**
 * `(a + b·r) / denominator`, the real part of `(a + b·i) / (c + d·i)` for
 * `|d| ≤ |c|`, given `ratio = d / c` and `denominator = c + d·ratio`. When
 * `b·ratio` or `ratio` underflows to 0, it regroups so `b` still counts
 * (Baudin & Smith 2012). The imaginary part is `smithPart(b, -a, ...)`.
 */
function smithPart(a: number, b: number, c: number, d: number, ratio: number, denominator: number): number {
  if (ratio !== 0) {
    const bRatio = b * ratio;
    return bRatio === 0 ? a / denominator + (b / denominator) * ratio : (a + bRatio) / denominator;
  }
  return (a + d * (b / c)) / denominator;
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
 * A complex number `re + im·i` with finite float parts. Create one with
 * `complex(3, 4)`, `complex('3+4i')` or `Complex.fromPolar(r, theta)`.
 * Equality (`eq`) is exact; use `approxEqual` after float arithmetic.
 *
 * Immutable: methods never modify their operands and the fields are `readonly`.
 * Instances are not frozen — `Object.freeze` per result cost 5–7× in hot loops,
 * and no peer library (decimal.js, big.js, fraction.js, complex.js) freezes —
 * but the shared constants arithmetic can return are frozen.
 */
export class Complex {
  // Frozen below the class: arithmetic returns them (`pow`, `sqrt`, `inverse`).
  static readonly ZERO: Complex = new Complex(0, 0, BRAND);
  static readonly ONE: Complex = new Complex(1, 0, BRAND);
  static readonly I: Complex = new Complex(0, 1, BRAND);

  readonly re: number;
  readonly im: number;

  private constructor(re: number, im: number, brand: typeof BRAND) {
    if (brand !== BRAND) throw new TypeError('Use complex(re, im) instead of new Complex()');
    this.re = re;
    this.im = im;
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

  /**
   * Robust complex division (Baudin & Smith 2012, "A Robust Complex Division
   * in Scilab"): Smith's algorithm, which avoids overflow in `|divisor|²`,
   * plus exact power-of-two scaling when a part is near overflow or underflow,
   * so `(1e308 + 1e308i) / (1e308 + 1e308i)` is `1`. Throws on a zero divisor,
   * and `NumericRangeError` only when the quotient itself is out of range.
   */
  dividedBy(other: ComplexInput): Complex {
    const that = Complex.from(other);
    if (that.isZero()) throw new DivisionByZeroError(`${this.toString()} divided by zero`);
    let a = this.re;
    let b = this.im;
    let c = that.re;
    let d = that.im;
    const absC = Math.abs(c);
    const absD = Math.abs(d);
    const ab = Math.max(Math.abs(a), Math.abs(b));
    const cd = Math.max(absC, absD);
    let scale = 1;
    // Only extreme exponents take this branch; scaling by a power of two is exact.
    if (!(ab < HALF_MAX && ab > TINY && cd < HALF_MAX && cd > TINY)) {
      if (ab >= HALF_MAX) {
        a *= 0.5;
        b *= 0.5;
        scale *= 2;
      } else if (ab <= TINY) {
        a *= UPSCALE;
        b *= UPSCALE;
        scale /= UPSCALE;
      }
      if (cd >= HALF_MAX) {
        c *= 0.5;
        d *= 0.5;
        scale *= 0.5;
      } else if (cd <= TINY) {
        c *= UPSCALE;
        d *= UPSCALE;
        scale *= UPSCALE;
      }
    }
    let re: number;
    let im: number;
    // Scaling keeps the order of |c| and |d|.
    if (absD <= absC) {
      const ratio = d / c;
      const denominator = c + d * ratio;
      re = smithPart(a, b, c, d, ratio, denominator);
      im = smithPart(b, -a, c, d, ratio, denominator);
    } else {
      // (b + a·i) / (d + c·i) is the conjugate of the quotient.
      const ratio = c / d;
      const denominator = d + c * ratio;
      re = smithPart(b, a, d, c, ratio, denominator);
      im = -smithPart(a, -b, d, c, ratio, denominator);
    }
    return result(re * scale, im * scale, 'dividedBy');
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

  /**
   * Modulus `|z|`, via `Math.hypot` so large parts do not overflow. Throws
   * `NumericRangeError` when `|z|` itself is beyond the float range, which
   * finite parts allow (up to √2 × `Number.MAX_VALUE`, as for `1e308 + 1e308i`).
   */
  abs(): number {
    const modulus = Math.hypot(this.re, this.im);
    if (modulus === Infinity) throw new NumericRangeError('abs overflows the float range');
    return modulus;
  }

  /** Principal argument in `(-π, π]`. The argument of zero is `0`, as in C's `carg`. */
  arg(): number {
    return Math.atan2(this.im, this.re);
  }

  /** `{ r: abs(), theta: arg() }`; throws `NumericRangeError` where `abs` does. */
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
    return result(logModulus(this.re, this.im), this.arg(), 'ln');
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
    // |z| is √(re² + im²) while that sum is a normal float: as accurate as
    // Math.hypot here (same max error against 80-digit references) and several
    // times faster in V8. Math.hypot takes over near overflow and underflow.
    const squares = re * re + im * im;
    const modulus = squares > 1e-290 && squares < Infinity ? Math.sqrt(squares) : Math.hypot(re, im);
    // t = sqrt((|re| + |z|) / 2) never cancels; the other part is im / 2t.
    let t = Math.sqrt((Math.abs(re) + modulus) / 2);
    // Near the top of the float range |re| + |z| overflows though t does not:
    // t = 2 sqrt((|re/4| + |z/4|) / 2), and dividing such large parts by 4 is exact.
    if (t === Infinity) t = 2 * Math.sqrt((Math.abs(re / 4) + Math.hypot(re / 4, im / 4)) / 2);
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
      const magnitude = modulusPower(this.re, this.im, w.re);
      const angle = this.arg() * w.re;
      if (angle === 0) return result(magnitude, 0, 'pow');
      return result(magnitude * Math.cos(angle), magnitude * Math.sin(angle), 'pow');
    }
    const lnModulus = logModulus(this.re, this.im);
    const angle = this.arg();
    // e^(w·ln z), without building the intermediate w·ln z as a Complex.
    const exponentRe = w.re * lnModulus - w.im * angle;
    const exponentIm = w.re * angle + w.im * lnModulus;
    if (!Number.isFinite(exponentRe) || !Number.isFinite(exponentIm)) {
      throw new NumericRangeError('pow overflows the float range');
    }
    const scale = Math.exp(exponentRe);
    if (exponentIm === 0) return result(scale, 0, 'pow');
    return result(scale * Math.cos(exponentIm), scale * Math.sin(exponentIm), 'pow');
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
    const modulus = modulusPower(this.re, this.im, 1 / n);
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
    // Near the top of the float range the distance or a modulus would overflow:
    // compare everything at a quarter of its size there (exact for such parts).
    const largest = Math.max(Math.abs(this.re), Math.abs(this.im), Math.abs(that.re), Math.abs(that.im));
    const k = largest > 2 ** 1022 ? 0.25 : 1;
    const distance = Math.hypot(this.re * k - that.re * k, this.im * k - that.im * k);
    return (
      distance <= tolerance * Math.max(k, Math.hypot(this.re * k, this.im * k), Math.hypot(that.re * k, that.im * k))
    );
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

Object.freeze(Complex.ZERO);
Object.freeze(Complex.ONE);
Object.freeze(Complex.I);

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
