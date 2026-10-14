/**
 * Polynomials over plain JS floats, stored as coefficient arrays.
 *
 * Order: highest degree first, so the array reads like the written
 * polynomial — `[1, -6, 11, -6]` is `x³ - 6x² + 11x - 6`. This is the order
 * of MATLAB `polyval`/`roots` and NumPy `polyval`/`roots`, and it matches the
 * argument order of `quadraticRoots(a, b, c)` and `cubicRoots(a, b, c, d)`,
 * so one convention holds across the module.
 *
 * Inputs may carry leading zeros (`[0, 1, 2]` is `x + 2`); results never do.
 * The zero polynomial is `[0]`. Every coefficient must be finite. Inputs are
 * never modified, and results never carry `-0`.
 *
 * Root finders return a tagged result so callers know at compile time whether
 * they got real numbers or `Complex` values: check `kind` first.
 */

import { Complex } from './complex.js';
import { ConvergenceError, InvalidArgumentError, NumericRangeError } from './errors.js';
import { assertFinite } from './number.js';

/** Coefficients, highest degree first. */
export type Coefficients = readonly number[];

/**
 * Two real roots in ascending order (a double root is listed twice), or a
 * conjugate pair (positive imaginary part first). `discriminant` is `b² - 4ac`;
 * its sign is what chose `kind` (`>= 0` real, `< 0` complex).
 */
export type QuadraticRoots =
  | { readonly kind: 'real'; readonly roots: readonly [number, number]; readonly discriminant: number }
  | { readonly kind: 'complex'; readonly roots: readonly [Complex, Complex]; readonly discriminant: number };

/**
 * Three real roots in ascending order (repeated roots listed by multiplicity),
 * or one real root plus a conjugate pair (positive imaginary part first).
 */
export type CubicRoots =
  | { readonly kind: 'real'; readonly roots: readonly [number, number, number] }
  | { readonly kind: 'mixed'; readonly real: number; readonly complex: readonly [Complex, Complex] };

const EPSILON = Number.EPSILON;

/** Validates and strips leading zeros; the zero polynomial becomes `[0]`. */
function normalize(coefficients: Coefficients, name: string): number[] {
  if (!Array.isArray(coefficients)) throw new TypeError(`${name} must be an array of numbers`);
  if (coefficients.length === 0) throw new InvalidArgumentError(`${name} must not be empty`);
  let start = 0;
  for (const [index, value] of coefficients.entries()) {
    assertFinite(value, `${name}[${index}]`);
    if (value === 0 && start === index) start++;
  }
  if (start === coefficients.length) return [0];
  return coefficients.slice(start).map(value => value + 0);
}

function finite(value: number, operation: string): number {
  if (!Number.isFinite(value)) throw new NumericRangeError(`${operation} overflows the float range`);
  return value + 0;
}

/** Horner evaluation at a complex point, returning raw parts (no checks). */
function hornerComplex(coefficients: readonly number[], re: number, im: number): [number, number] {
  let pr = 0;
  let pi = 0;
  for (const c of coefficients) {
    const nextRe = pr * re - pi * im + c;
    pi = pr * im + pi * re;
    pr = nextRe;
  }
  return [pr, pi];
}

/**
 * The value at `x` by Horner's rule (one multiply and one add per
 * coefficient). A `Complex` point gives a `Complex` value.
 */
export function evaluatePolynomial(coefficients: Coefficients, x: number): number;
export function evaluatePolynomial(coefficients: Coefficients, x: Complex): Complex;
export function evaluatePolynomial(coefficients: Coefficients, x: number | Complex): number | Complex {
  const p = normalize(coefficients, 'coefficients');
  if (x instanceof Complex) {
    const [re, im] = hornerComplex(p, x.re, x.im);
    return Complex.fromParts(finite(re, 'evaluatePolynomial'), finite(im, 'evaluatePolynomial'));
  }
  assertFinite(x, 'x');
  let value = 0;
  for (const c of p) value = value * x + c;
  return finite(value, 'evaluatePolynomial');
}

/** The derivative. A constant's derivative is `[0]`. */
export function polynomialDerivative(coefficients: Coefficients): number[] {
  const p = normalize(coefficients, 'coefficients');
  const degree = p.length - 1;
  if (degree === 0) return [0];
  const result: number[] = [];
  for (let k = 0; k < degree; k++) result.push(finite(p[k]! * (degree - k), 'polynomialDerivative'));
  return result;
}

/** The sum `p + q`. */
export function addPolynomials(p: Coefficients, q: Coefficients): number[] {
  const a = normalize(p, 'p');
  const b = normalize(q, 'q');
  const [longer, shorter] = a.length >= b.length ? [a, b] : [b, a];
  const offset = longer.length - shorter.length;
  const sum = longer.map((value, index) =>
    finite(index < offset ? value : value + shorter[index - offset]!, 'addPolynomials'),
  );
  return normalize(sum, 'sum');
}

/** The product `p × q` (coefficient convolution). */
export function multiplyPolynomials(p: Coefficients, q: Coefficients): number[] {
  const a = normalize(p, 'p');
  const b = normalize(q, 'q');
  const product: number[] = Array.from({ length: a.length + b.length - 1 }, () => 0);
  for (const [i, x] of a.entries()) {
    for (const [j, y] of b.entries()) product[i + j] = product[i + j]! + x * y;
  }
  return normalize(
    product.map(value => finite(value, 'multiplyPolynomials')),
    'product',
  );
}

// ---------------------------------------------------------------------------
// Closed-form roots
// ---------------------------------------------------------------------------

/**
 * A power of two that brings the largest coefficient near 1. Multiplying by
 * it is exact, so roots are unchanged while products cannot overflow.
 */
function powerOfTwoScale(values: readonly number[]): number {
  let largest = 0;
  for (const value of values) largest = Math.max(largest, Math.abs(value));
  const exponent = Math.min(1000, Math.max(-1000, Math.floor(Math.log2(largest))));
  return 2 ** -exponent;
}

/** Splits a float into two halves whose products are exact (Veltkamp). */
function split(a: number): [number, number] {
  const c = 134_217_729 * a; // 2^27 + 1
  const high = c - (c - a);
  return [high, a - high];
}

/** `a × b` as an unevaluated sum `product + error`, exactly (Dekker). */
function twoProduct(a: number, b: number): [number, number] {
  const product = a * b;
  const [ah, al] = split(a);
  const [bh, bl] = split(b);
  return [product, ah * bh - product + ah * bl + al * bh + al * bl];
}

/**
 * `b² - 4ac` with the products formed exactly, so a near-double root does
 * not lose its discriminant to cancellation (Kahan's method).
 */
function discriminant(a: number, b: number, c: number): number {
  const [bb, bbError] = twoProduct(b, b);
  const [ac4, ac4Error] = twoProduct(4 * a, c);
  return bb - ac4 + (bbError - ac4Error);
}

/**
 * Roots of `ax² + bx + c` (`a ≠ 0`). Uses `q = -(b + sign(b)·√D) / 2`,
 * then `q / a` and `c / q`, so neither root suffers cancellation — the small
 * root of `x² - 1e8·x + 1` comes out to full precision. The discriminant is
 * computed with exact products, so near-double roots stay accurate: for
 * Kahan's `94906265.625x² - 189812534x + 94906268.375` it is the exact `7.5625`
 * where the plain float formula gives `0` (a false double root).
 *
 * The returned `discriminant` is that same value, and its sign decides `kind`.
 * It is formed on the coefficients rescaled by a power of two (exact), so the
 * decision is right even when `b² - 4ac` itself is out of range; only then does
 * the reported value overflow to `±Infinity` or underflow to `0`.
 */
export function quadraticRoots(a: number, b: number, c: number): QuadraticRoots {
  assertFinite(a, 'a');
  assertFinite(b, 'b');
  assertFinite(c, 'c');
  if (a === 0) throw new InvalidArgumentError('a must not be 0 (not a quadratic)');
  const scale = powerOfTwoScale([a, b, c]);
  const sa = a * scale;
  const sb = b * scale;
  const sc = c * scale;
  const d = discriminant(sa, sb, sc);
  // Undo the rescaling: d = scale² · (b² - 4ac), and dividing by a power of two is exact.
  const unscaled = d / scale / scale + 0;
  if (d < 0) {
    const re = -sb / (2 * sa) + 0;
    const im = Math.sqrt(-d) / (2 * Math.abs(sa));
    return { kind: 'complex', roots: [Complex.fromParts(re, im), Complex.fromParts(re, -im)], discriminant: unscaled };
  }
  const q = -(sb + (sb < 0 ? -1 : 1) * Math.sqrt(d)) / 2;
  if (q === 0) return { kind: 'real', roots: [0, 0], discriminant: unscaled };
  const x1 = q / sa + 0;
  const x2 = sc / q + 0;
  return { kind: 'real', roots: x1 <= x2 ? [x1, x2] : [x2, x1], discriminant: unscaled };
}

/** `a + b` as an unevaluated sum `sum + error`, exactly (Knuth). */
function twoSum(a: number, b: number): [number, number] {
  const sum = a + b;
  const bVirtual = sum - a;
  return [sum, a - (sum - bVirtual) + (b - bVirtual)];
}

/**
 * Horner's rule with each step's rounding error carried along (compensated
 * Horner), so the value is as accurate as if computed in twice the precision.
 * Newton polishing needs this: near a root, plain Horner's value is mostly
 * rounding noise and cannot tell the polisher which way to move.
 */
function compensatedHorner(coefficients: readonly number[], x: number): number {
  let value = coefficients[0]!;
  let error = 0;
  for (let k = 1; k < coefficients.length; k++) {
    const [product, productError] = twoProduct(value, x);
    const [sum, sumError] = twoSum(product, coefficients[k]!);
    value = sum;
    error = error * x + (productError + sumError);
  }
  return value + error;
}

/** Up to four Newton steps, kept only while the (compensated) residual shrinks. */
function polishCubicRoot(cubic: readonly number[], x: number): number {
  const [a, b, c] = [cubic[0]!, cubic[1]!, cubic[2]!];
  let best = x;
  let residual = Math.abs(compensatedHorner(cubic, best));
  for (let step = 0; step < 4 && residual > 0; step++) {
    const slope = (3 * a * best + 2 * b) * best + c;
    if (slope === 0) break;
    const next = best - compensatedHorner(cubic, best) / slope;
    const nextResidual = Math.abs(compensatedHorner(cubic, next));
    if (!(nextResidual < residual)) break;
    best = next;
    residual = nextResidual;
  }
  return best + 0;
}

function sortedTriple(x: number, y: number, z: number): [number, number, number] {
  const values = [x + 0, y + 0, z + 0];
  values.sort((p, q) => p - q);
  return [values[0]!, values[1]!, values[2]!];
}

/**
 * Roots of `ax³ + bx² + cx + d` (`a ≠ 0`).
 *
 * The case is chosen by the sign of the discriminant formed from the
 * original coefficients (exact for moderate integer coefficients), not from
 * the shifted cubic, so `x³ - 4x² + 5x - 2` is recognised as a double root.
 * Three distinct real roots use the trigonometric method (no complex cube
 * roots); one real root uses Cardano's formula in its cancellation-free form.
 * Real roots are then polished with Newton steps.
 */
export function cubicRoots(a: number, b: number, c: number, d: number): CubicRoots {
  assertFinite(a, 'a');
  assertFinite(b, 'b');
  assertFinite(c, 'c');
  assertFinite(d, 'd');
  if (a === 0) throw new InvalidArgumentError('a must not be 0 (not a cubic)');
  const scale = powerOfTwoScale([a, b, c, d]);
  const cubic = [a * scale, b * scale, c * scale, d * scale];
  const [sa, sb, sc, sd] = [cubic[0]!, cubic[1]!, cubic[2]!, cubic[3]!];

  const terms = [
    18 * sa * sb * sc * sd,
    -4 * sb * sb * sb * sd,
    sb * sb * sc * sc,
    -4 * sa * sc * sc * sc,
    -27 * sa * sa * sd * sd,
  ];
  let delta = 0;
  let magnitude = 0;
  for (const term of terms) {
    delta += term;
    magnitude += Math.abs(term);
  }
  const noise = 16 * EPSILON * magnitude;

  if (Math.abs(delta) <= noise) {
    // A multiple root. With delta0 = b² - 3ac, all three coincide when it is 0.
    const delta0 = sb * sb - 3 * sa * sc;
    if (Math.abs(delta0) <= 16 * EPSILON * (sb * sb + 3 * Math.abs(sa * sc))) {
      const triple = -sb / (3 * sa) + 0;
      return { kind: 'real', roots: [triple, triple, triple] };
    }
    const double = (9 * sa * sd - sb * sc) / (2 * delta0);
    const simple = (4 * sa * sb * sc - 9 * sa * sa * sd - sb * sb * sb) / (sa * delta0);
    return { kind: 'real', roots: sortedTriple(double, double, simple) };
  }

  // Depressed cubic t³ + pt + q with x = t - B/3.
  const B = sb / sa;
  const C = sc / sa;
  const D = sd / sa;
  const shift = B / 3;
  const p = C - B * shift;
  const q = ((2 * B * B) / 27 - C / 3) * B + D;

  if (delta > 0) {
    // Three distinct real roots; p < 0 here.
    const m = 2 * Math.sqrt(Math.max(0, -p / 3));
    const cosine = m === 0 ? 0 : Math.min(1, Math.max(-1, (3 * q) / (p * m)));
    const theta = Math.acos(cosine) / 3;
    const roots = [0, 1, 2].map(k => polishCubicRoot(cubic, m * Math.cos(theta - (2 * Math.PI * k) / 3) - shift));
    return { kind: 'real', roots: sortedTriple(roots[0]!, roots[1]!, roots[2]!) };
  }

  // One real root and a conjugate pair.
  const halfQ = q / 2;
  const inner = Math.sqrt(Math.max(0, halfQ * halfQ + (p / 3) ** 3));
  const u = -(halfQ < 0 ? -1 : 1) * Math.cbrt(Math.abs(halfQ) + inner);
  const v = u === 0 ? 0 : -p / (3 * u);
  const real = polishCubicRoot(cubic, u + v - shift);
  // Vieta from the polished root: the roots sum to -B and multiply to -D, so
  // the pair has real part (-B - real) / 2 and |z|² = -D / real (or C when
  // real is 0). Measured on random cubics this is ~100× more accurate than
  // Cardano's own imaginary part, (√3/2)·|u - v|, which cancels.
  const re = (-B - real) / 2 + 0;
  const modulusSquared = real === 0 ? C : -D / real;
  const im = Math.sqrt(Math.max(0, modulusSquared - re * re));
  return {
    kind: 'mixed',
    real,
    complex: [Complex.fromParts(re, im), Complex.fromParts(re, -im)],
  };
}

// ---------------------------------------------------------------------------
// Any degree
// ---------------------------------------------------------------------------

const MAX_ITERATIONS = 500;

function compareComplex(x: Complex, y: Complex): number {
  return x.re - y.re || x.im - y.im;
}

/**
 * All roots of a polynomial of any degree, as `Complex` values listed by
 * multiplicity and sorted by real part, then imaginary part.
 *
 * Zero roots are factored out exactly; degree 1–3 use the closed forms above.
 * Degree 4 and up use the Aberth–Ehrlich iteration, which refines all roots
 * at once. Each root stops once `|p(z)|` is within the rounding noise of
 * evaluating `p` at `z`, so it is as accurate as the polynomial's
 * conditioning allows: simple roots to near full precision, a root of
 * multiplicity m to about 16/m digits. A real or imaginary part below
 * `1e-14 × |z|` is set to exactly 0, so real roots report `isReal()`.
 *
 * A constant has no roots (`[]`); the zero polynomial throws, because every
 * number is a root.
 */
export function polynomialRoots(coefficients: Coefficients): Complex[] {
  const p = normalize(coefficients, 'coefficients');
  if (p.length === 1) {
    if (p[0] === 0) throw new InvalidArgumentError('the zero polynomial has every number as a root');
    return [];
  }
  let end = p.length;
  while (p[end - 1] === 0) end--;
  const zeros = Array.from({ length: p.length - end }, () => Complex.ZERO);
  const reduced = p.slice(0, end);
  const roots = [...zeros, ...nonZeroRoots(reduced)];
  roots.sort(compareComplex);
  return roots;
}

function nonZeroRoots(p: readonly number[]): Complex[] {
  const degree = p.length - 1;
  if (degree === 0) return [];
  if (degree === 1) return [Complex.fromParts(-p[1]! / p[0]!, 0)];
  if (degree === 2) {
    const found = quadraticRoots(p[0]!, p[1]!, p[2]!);
    return found.kind === 'real' ? found.roots.map(x => Complex.fromParts(x, 0)) : [...found.roots];
  }
  if (degree === 3) {
    const found = cubicRoots(p[0]!, p[1]!, p[2]!, p[3]!);
    return found.kind === 'real'
      ? found.roots.map(x => Complex.fromParts(x, 0))
      : [Complex.fromParts(found.real, 0), ...found.complex];
  }
  return aberth(p);
}

function aberth(input: readonly number[]): Complex[] {
  const scale = powerOfTwoScale(input);
  const p = input.map(c => c * scale);
  const degree = p.length - 1;
  const derivative = p.slice(0, degree).map((c, k) => c * (degree - k));
  const magnitudes = p.map(c => Math.abs(c));

  // Start on a circle whose radius matches the roots' geometric scale,
  // rotated off the real axis so conjugate pairs can separate.
  let radius = 0;
  for (let k = 1; k <= degree; k++) radius = Math.max(radius, Math.abs(p[k]! / p[0]!) ** (1 / k));
  const re: number[] = [];
  const im: number[] = [];
  for (let k = 0; k < degree; k++) {
    const angle = (2 * Math.PI * k) / degree + 0.4;
    re.push(radius * Math.cos(angle));
    im.push(radius * Math.sin(angle));
  }

  const done = Array.from({ length: degree }, () => false);
  let remaining = degree;
  const tolerance = 4 * (degree + 1) * EPSILON;
  for (let iteration = 0; iteration < MAX_ITERATIONS && remaining > 0; iteration++) {
    for (let k = 0; k < degree; k++) {
      if (done[k]) continue;
      const zr = re[k]!;
      const zi = im[k]!;
      const [vr, vi] = hornerComplex(p, zr, zi);
      // Rounding noise of Horner at |z|: Σ|a_i|·|z|^(n-i).
      let bound = 0;
      const modulus = Math.hypot(zr, zi);
      for (const m of magnitudes) bound = bound * modulus + m;
      if (Math.hypot(vr, vi) <= tolerance * bound) {
        done[k] = true;
        remaining--;
        continue;
      }
      const [dr, di] = hornerComplex(derivative, zr, zi);
      // ratio = p(z) / p'(z)
      const dd = dr * dr + di * di;
      if (dd === 0) {
        // A critical point: nudge off it rather than divide by zero.
        re[k] = zr + EPSILON * Math.max(1, modulus);
        continue;
      }
      const ratioRe = (vr * dr + vi * di) / dd;
      const ratioIm = (vi * dr - vr * di) / dd;
      // sum = Σ 1 / (z_k - z_j)
      let sumRe = 0;
      let sumIm = 0;
      for (let j = 0; j < degree; j++) {
        if (j === k) continue;
        const xr = zr - re[j]!;
        const xi = zi - im[j]!;
        const xx = xr * xr + xi * xi;
        if (xx === 0) continue;
        sumRe += xr / xx;
        sumIm -= xi / xx;
      }
      // w = ratio / (1 - ratio·sum)
      const denominatorRe = 1 - (ratioRe * sumRe - ratioIm * sumIm);
      const denominatorIm = -(ratioRe * sumIm + ratioIm * sumRe);
      const den = denominatorRe * denominatorRe + denominatorIm * denominatorIm;
      const wr = den === 0 ? ratioRe : (ratioRe * denominatorRe + ratioIm * denominatorIm) / den;
      const wi = den === 0 ? ratioIm : (ratioIm * denominatorRe - ratioRe * denominatorIm) / den;
      re[k] = zr - wr;
      im[k] = zi - wi;
    }
  }
  if (remaining > 0) {
    throw new ConvergenceError(`polynomialRoots did not converge in ${MAX_ITERATIONS} iterations`);
  }
  return re.map((x, k) => {
    const y = im[k]!;
    const noise = 1e-14 * Math.hypot(x, y);
    return Complex.fromParts(Math.abs(x) <= noise ? 0 : x, Math.abs(y) <= noise ? 0 : y);
  });
}
