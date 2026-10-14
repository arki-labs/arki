/**
 * Probability distributions and the special functions behind them, over plain
 * JS numbers. Pure TypeScript, no platform APIs.
 *
 * Parameters are validated and throw `InvalidArgumentError`. `pdf`/`cdf`/`pmf`
 * accept `±Infinity` (they are legitimate arguments) but reject `NaN`. Results
 * never carry `-0`. Where a moment does not exist (for example the mean of a
 * Cauchy-like t with `df <= 1`) it is `undefined`, or `Infinity` when it diverges.
 */

import { InvalidArgumentError, NumericRangeError } from './errors.js';
import { assertFinite } from './number.js';

/** A continuous probability distribution. */
export type ContinuousDistribution = {
  /** Probability density at x. */
  pdf(x: number): number;
  /** P(X ≤ x). */
  cdf(x: number): number;
  /** Survival function P(X > x) = 1 − cdf(x), computed on the accurate side where the distribution allows. */
  sf(x: number): number;
  /**
   * Quantile: the x with cdf(x) = p, p in (0, 1), solved on the accurate side to 1e-12 of the
   * smaller tail (|cdf(x) − p| ≤ 1e-12·p for p ≤ ½, |sf(x) − (1 − p)| ≤ 1e-12·(1 − p) above), so
   * far-tail quantiles keep their relative accuracy; p = 0 / 1 return the support bounds
   * (±Infinity where unbounded).
   */
  quantile(p: number): number;
  /** Expected value, or `undefined` when the distribution has none. */
  readonly mean: number | undefined;
  /** Variance: `Infinity` when it diverges, `undefined` when the distribution has none. */
  readonly variance: number | undefined;
};

/** A discrete probability distribution over the non-negative integers. */
export type DiscreteDistribution = {
  /** P(X = k) for integer k (0 for any other k). */
  pmf(k: number): number;
  /** P(X ≤ k). */
  cdf(k: number): number;
  /** Survival function P(X > k) = 1 − cdf(k), computed on the accurate side. */
  sf(k: number): number;
  /**
   * Quantile: exactly the smallest integer k with `cdf(k) >= p`, using this object's own `cdf`
   * (no tolerance), so `quantile(cdf(k)) === k`. p = 0 gives 0; p = 1 gives the support's upper bound.
   */
  quantile(p: number): number;
  /** Expected value. */
  readonly mean: number;
  /** Variance. */
  readonly variance: number;
};

const EPS = 1e-16;
const FPMIN = 1e-300;
const MAX_ITER = 100_000;
const SQRT2 = Math.SQRT2;
const SQRT_2PI = Math.sqrt(2 * Math.PI);
const LN_SQRT_PI = 0.5 * Math.log(Math.PI);
const LN_2PI = Math.log(2 * Math.PI);

function noNegativeZero(value: number): number {
  return value === 0 ? 0 : value;
}

function assertPositive(value: number, name: string): void {
  assertFinite(value, name);
  if (!(value > 0)) throw new InvalidArgumentError(`${name} must be greater than 0, got ${value}`);
}

function assertProbability(p: number): void {
  if (typeof p !== 'number') throw new TypeError('p must be a number');
  if (!(p >= 0 && p <= 1)) throw new InvalidArgumentError(`p must be in [0, 1], got ${p}`);
}

function assertPoint(x: number, name: string): void {
  if (typeof x !== 'number') throw new TypeError(`${name} must be a number`);
  if (Number.isNaN(x)) throw new InvalidArgumentError(`${name} must not be NaN`);
}

// ---------------------------------------------------------------------------
// Special functions
// ---------------------------------------------------------------------------

const LANCZOS = [
  0.999_999_999_999_809_93, 676.520_368_121_885_1, -1259.139_216_722_402_8, 771.323_428_777_653_13,
  -176.615_029_162_140_59, 12.507_343_278_686_905, -0.138_571_095_265_720_12, 9.984_369_578_019_571_6e-6,
  1.505_632_735_149_311_6e-7,
];

function lnGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const z = x - 1;
  const t = z + 7.5;
  let a = LANCZOS[0] ?? 0;
  for (let i = 1; i < LANCZOS.length; i++) a += (LANCZOS[i] ?? 0) / (z + i);
  return 0.5 * LN_2PI + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Natural log of the gamma function, ln Γ(x), for x > 0 (Lanczos, g = 7, ~1e-15). */
export function gammaLn(x: number): number {
  assertFinite(x, 'x');
  if (!(x > 0)) throw new InvalidArgumentError(`x must be greater than 0, got ${x}`);
  return noNegativeZero(lnGamma(x));
}

const MAX_GAMMA_ARG = 171.624_376_956_302_7; // Γ(x) overflows a double just above this

function positiveGamma(x: number): number {
  // x >= 0.5. Same Lanczos sum as lnGamma, but exponentiated directly (no ln/exp round trip)
  // so the relative error stays near 1e-15. Two half-powers avoid overflow of t^(z + 0.5).
  const z = x - 1;
  const t = z + 7.5;
  let a = LANCZOS[0] ?? 0;
  for (let i = 1; i < LANCZOS.length; i++) a += (LANCZOS[i] ?? 0) / (z + i);
  const half = t ** ((z + 0.5) / 2);
  return SQRT_2PI * half * (Math.exp(-t) * half) * a;
}

/**
 * The gamma function Γ(x) for finite `x`. `Γ(n + 1) = n!`, so this is the float
 * factorial for `n > 18`. Positive integers up to 171 are exact products;
 * other values use Lanczos (relative error ~1e-15) with the reflection formula
 * for `x < 0.5`. Poles (`0` and the negative integers) throw
 * `InvalidArgumentError`; a result beyond the double range (`x` above about
 * 171.62, or `x` within ~1e-308 of a pole) throws `NumericRangeError`.
 * Very negative `x` whose true value is below the smallest double returns `0`.
 */
export function gamma(x: number): number {
  assertFinite(x, 'x');
  if (Number.isInteger(x)) {
    if (x <= 0) throw new InvalidArgumentError(`gamma has a pole at ${x}`);
    if (x > 171) throw new NumericRangeError(`gamma(${x}) exceeds the largest finite number`);
    let result = 1;
    for (let i = 2; i < x; i++) result *= i;
    return result;
  }
  if (x > MAX_GAMMA_ARG) throw new NumericRangeError(`gamma(${x}) exceeds the largest finite number`);
  let result: number;
  if (x < 0.5) {
    const sine = Math.sin(Math.PI * x);
    // Γ(1 - x) overflows for x < -170.6, where |Γ(x)| is below the smallest double anyway.
    if (1 - x > MAX_GAMMA_ARG) return 0;
    result = Math.PI / (sine * positiveGamma(1 - x));
  } else {
    result = positiveGamma(x);
  }
  if (!Number.isFinite(result)) throw new NumericRangeError(`gamma(${x}) exceeds the largest finite number`);
  return noNegativeZero(result);
}

/** ln B(a, b) = ln Γ(a) + ln Γ(b) − ln Γ(a + b), for `a, b > 0`. */
export function betaLn(a: number, b: number): number {
  return noNegativeZero(gammaLn(a) + gammaLn(b) - gammaLn(a + b));
}

/** The beta function B(a, b) = Γ(a)Γ(b) / Γ(a + b), for `a, b > 0`. Underflows to `0` for very large arguments. */
export function beta(a: number, b: number): number {
  return Math.exp(betaLn(a, b));
}

function gammaSeries(a: number, x: number, gln: number): number {
  let ap = a;
  let del = 1 / a;
  let sum = del;
  for (let n = 0; n < MAX_ITER; n++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * EPS) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - gln);
}

function gammaContinuedFraction(a: number, x: number, gln: number): number {
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < MAX_ITER; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h;
}

/** Lower (`p`) and upper (`q`) regularized incomplete gamma, each computed on its accurate side. */
function gammaPQ(a: number, x: number, gln: number = lnGamma(a)): { p: number; q: number } {
  if (x <= 0) return { p: 0, q: 1 };
  if (x < a + 1) {
    const p = Math.min(1, gammaSeries(a, x, gln));
    return { p, q: 1 - p };
  }
  const q = Math.min(1, gammaContinuedFraction(a, x, gln));
  return { p: 1 - q, q };
}

/** Regularized lower incomplete gamma P(a, x) = γ(a, x) / Γ(a), for a > 0 and x ≥ 0. */
export function regularizedGammaP(a: number, x: number): number {
  assertPositive(a, 'a');
  assertFinite(x, 'x');
  if (x < 0) throw new InvalidArgumentError(`x must be at least 0, got ${x}`);
  return noNegativeZero(gammaPQ(a, x).p);
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m < MAX_ITER; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** ln B(a, b) = ln Γ(a) + ln Γ(b) − ln Γ(a + b). */
function lnBeta(a: number, b: number): number {
  return lnGamma(a) + lnGamma(b) - lnGamma(a + b);
}

/**
 * I_x(a, b) where `y` must equal `1 - x` (passed separately so callers keep tail precision).
 * `lnB` = ln B(a, b); callers with fixed a, b pass it precomputed.
 */
function betaI(x: number, y: number, a: number, b: number, lnB: number = lnBeta(a, b)): number {
  if (x <= 0) return 0;
  if (y <= 0) return 1;
  const front = Math.exp(a * Math.log(x) + b * Math.log(y) - lnB);
  if (x < (a + 1) / (a + b + 2)) return Math.min(1, (front * betaContinuedFraction(a, b, x)) / a);
  return Math.max(0, 1 - (front * betaContinuedFraction(b, a, y)) / b);
}

/** Regularized incomplete beta I_x(a, b) for x in [0, 1] and a, b > 0. */
export function regularizedBeta(x: number, a: number, b: number): number {
  assertFinite(x, 'x');
  if (x < 0 || x > 1) throw new InvalidArgumentError(`x must be in [0, 1], got ${x}`);
  assertPositive(a, 'a');
  assertPositive(b, 'b');
  return noNegativeZero(betaI(x, 1 - x, a, b));
}

// W. J. Cody's rational Chebyshev approximations for erf and erfc (Math. Comp. 23, 1969; netlib
// specfun CALERF), accurate to about 1e-16 relative: erf on |x| ≤ 0.46875, erfc on (0.46875, 4]
// and erfc beyond 4. Each table is ordered as in CALERF.
const ERF_A = [
  3.161_123_743_870_565_5, 113.864_154_151_050_16, 377.485_237_685_302, 3209.377_589_138_469_4,
  0.185_777_706_184_603_15,
];
const ERF_B = [23.601_290_952_344_122, 244.024_637_934_444_17, 1282.616_526_077_372_3, 2844.236_833_439_171];
const ERFC_C = [
  0.564_188_496_988_670_1, 8.883_149_794_388_377, 66.119_190_637_141_63, 298.635_138_197_400_1, 881.952_221_241_769,
  1712.047_612_634_070_7, 2051.078_377_826_071_6, 1230.339_354_797_997_2, 2.153_115_354_744_038_3e-8,
];
const ERFC_D = [
  15.744_926_110_709_835, 117.693_950_891_312_5, 537.181_101_862_009_9, 1621.389_574_566_690_3, 3290.799_235_733_459_7,
  4362.619_090_143_247, 3439.367_674_143_721_6, 1230.339_354_803_749_5,
];
const ERFC_P = [
  0.305_326_634_961_232_36, 0.360_344_899_949_804_45, 0.125_781_726_111_229_26, 0.016_083_785_148_742_275,
  0.000_658_749_161_529_837_8, 0.016_315_387_137_302_097,
];
const ERFC_Q = [
  2.568_520_192_289_822, 1.872_952_849_923_467_3, 0.527_905_102_951_428_5, 0.060_518_341_312_441_32,
  0.002_335_204_976_268_691_8,
];
const ERF_SMALL = 0.468_75;
/** erfc(x) underflows to 0 beyond this. */
const ERFC_ZERO_FROM = 26.543;
const INV_SQRT_PI = 1 / Math.sqrt(Math.PI);

/** erf(x) for |x| ≤ ERF_SMALL. */
function erfSmall(x: number): number {
  const xx = x * x;
  let numerator = ERF_A[4]! * xx;
  let denominator = xx;
  for (let i = 0; i < 3; i++) {
    numerator = (numerator + ERF_A[i]!) * xx;
    denominator = (denominator + ERF_B[i]!) * xx;
  }
  return (x * (numerator + ERF_A[3]!)) / (denominator + ERF_B[3]!);
}

/** erfc(y) for y > ERF_SMALL. */
function erfcLarge(y: number): number {
  if (y >= ERFC_ZERO_FROM) return 0;
  let ratio: number;
  if (y <= 4) {
    let numerator = ERFC_C[8]! * y;
    let denominator = y;
    for (let i = 0; i < 7; i++) {
      numerator = (numerator + ERFC_C[i]!) * y;
      denominator = (denominator + ERFC_D[i]!) * y;
    }
    ratio = (numerator + ERFC_C[7]!) / (denominator + ERFC_D[7]!);
  } else {
    const inverseSquare = 1 / (y * y);
    let numerator = ERFC_P[5]! * inverseSquare;
    let denominator = inverseSquare;
    for (let i = 0; i < 4; i++) {
      numerator = (numerator + ERFC_P[i]!) * inverseSquare;
      denominator = (denominator + ERFC_Q[i]!) * inverseSquare;
    }
    ratio = (INV_SQRT_PI - (inverseSquare * (numerator + ERFC_P[4]!)) / (denominator + ERFC_Q[4]!)) / y;
  }
  // e^(−y²) split as e^(−r²)·e^(−(y − r)(y + r)) with r = y rounded down to 1/16, so y² never rounds.
  const rounded = Math.trunc(y * 16) / 16;
  return Math.exp(-rounded * rounded) * Math.exp(-(y - rounded) * (y + rounded)) * ratio;
}

function erfRaw(x: number): number {
  const ax = Math.abs(x);
  if (ax <= ERF_SMALL) return erfSmall(x);
  const value = 0.5 - erfcLarge(ax) + 0.5;
  return x < 0 ? -value : value;
}

function erfcRaw(x: number): number {
  const ax = Math.abs(x);
  if (ax <= ERF_SMALL) return 1 - erfSmall(x);
  const value = erfcLarge(ax);
  return x < 0 ? 2 - value : value;
}

/** The error function erf(x) = 2/√π ∫₀ˣ e^(−t²) dt (Cody's rational approximations, ~1e-16). */
export function erf(x: number): number {
  assertFinite(x, 'x');
  return noNegativeZero(erfRaw(x));
}

/** The complementary error function erfc(x) = 1 − erf(x), accurate in the far tail. */
export function erfc(x: number): number {
  assertFinite(x, 'x');
  return noNegativeZero(erfcRaw(x));
}

const ACKLAM_A = [
  -3.969_683_028_665_376e1, 2.209_460_984_245_205e2, -2.759_285_104_469_687e2, 1.383_577_518_672_69e2,
  -3.066_479_806_614_716e1, 2.506_628_277_459_239,
];
const ACKLAM_B = [
  -5.447_609_879_822_406e1, 1.615_858_368_580_409e2, -1.556_989_798_598_866e2, 6.680_131_188_771_972e1,
  -1.328_068_155_288_572e1,
];
const ACKLAM_C = [
  -7.784_894_002_430_293e-3, -3.223_964_580_411_365e-1, -2.400_758_277_161_838, -2.549_732_539_343_734,
  4.374_664_141_464_968, 2.938_163_982_698_783,
];
const ACKLAM_D = [7.784_695_709_041_462e-3, 3.224_671_290_700_398e-1, 2.445_134_137_142_996, 3.754_408_661_907_416];

function poly(coefficients: readonly number[], x: number): number {
  let result = 0;
  for (const c of coefficients) result = result * x + c;
  return result;
}

/** Acklam's rational approximation of the standard normal quantile (~1e-9 relative). */
function acklam(p: number): number {
  const pLow = 0.024_25;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return poly(ACKLAM_C, q) / (poly(ACKLAM_D, q) * q + 1);
  }
  if (p > 1 - pLow) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -poly(ACKLAM_C, q) / (poly(ACKLAM_D, q) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (poly(ACKLAM_A, r) * q) / (poly(ACKLAM_B, r) * r + 1);
}

/**
 * Standard normal quantile. In the middle, √2·erfInv(2p − 1): 2p − 1 is exact
 * there and erfInv keeps its relative accuracy even where the quantile is
 * tiny. In the tails, Acklam's guess and two Halley steps on erfc, taken in the
 * lower tail (the upper one by symmetry, as 1 − p is exact above ½).
 */
function normalQuantile(p: number): number {
  if (p >= 0.25 && p <= 0.75) return SQRT2 * erfInv(2 * p - 1);
  if (p > 0.5) return -normalQuantile(1 - p);
  let x = acklam(p);
  for (let i = 0; i < 2; i++) {
    const e = 0.5 * erfcRaw(-x / SQRT2) - p;
    const u = e * SQRT_2PI * Math.exp((x * x) / 2);
    if (!Number.isFinite(u)) break;
    x -= u / (1 + (x * u) / 2);
  }
  return x;
}

/** Inverse error function: the x with erf(x) = p, for p in [−1, 1] (±1 give ±Infinity). */
export function erfInv(p: number): number {
  assertFinite(p, 'p');
  if (p < -1 || p > 1) throw new InvalidArgumentError(`p must be in [-1, 1], got ${p}`);
  if (p === 1) return Infinity;
  if (p === -1) return -Infinity;
  if (p === 0) return 0;
  const a = Math.abs(p);
  let x = a < 0.5 ? acklam((1 + a) / 2) / SQRT2 : -acklam((1 - a) / 2) / SQRT2;
  for (let i = 0; i < 3; i++) {
    const f = a < 0.5 ? erfRaw(x) - a : 1 - a - erfcRaw(x);
    const d = (2 / Math.sqrt(Math.PI)) * Math.exp(-x * x);
    if (!(d > 0)) break;
    x -= f / (d + x * f);
  }
  return p < 0 ? -x : x;
}

// ---------------------------------------------------------------------------
// Quantile solver
// ---------------------------------------------------------------------------

type Bracket = { lo: number; hi: number; loFixed: boolean };

const QUANTILE_MAX_ITER = 400;
const QUANTILE_TOLERANCE = 1e-12;

function outOfRange(): NumericRangeError {
  return new NumericRangeError('quantile is outside the representable range');
}

/**
 * Bisection point: geometric when the bracket spans orders of magnitude on one
 * side of 0, `hi / zeroFactor` while the lower end is still the support bound 0,
 * else arithmetic.
 */
function bisectionPoint(lo: number, hi: number, zeroFactor: number): number {
  if (lo > 0 && hi > 64 * lo) return Math.sqrt(lo) * Math.sqrt(hi);
  if (hi < 0 && lo < 64 * hi) return -Math.sqrt(-lo) * Math.sqrt(-hi);
  if (lo === 0 && hi > 0) return hi / zeroFactor;
  return lo / 2 + hi / 2;
}

/** Grows a step factor by squaring, capped so a single step never jumps more than 2^64. */
function nextFactor(factor: number): number {
  return Math.min(factor * factor, 2 ** 64);
}

/**
 * Inverts a monotone distribution on its accurate side: for p ≤ ½ it solves
 * cdf(x) = p, above it sf(x) = 1 − p (exact in floating point there), each to
 * 1e-12 of that tail probability, so a quantile far out in either tail is as
 * accurate as one near the middle. First brackets the quantile, growing the
 * bracket by squaring factors so tails many orders of magnitude out are reached
 * in a few steps. Then runs Newton steps (when a pdf is given) safeguarded by
 * bisection — geometric when the bracket spans orders of magnitude, and
 * stepping toward a support bound of 0 by squaring factors. If the bracket
 * shrinks to adjacent doubles first, the endpoint with the smaller error is
 * returned. Throws `NumericRangeError` if the iteration cap is hit.
 */
function invertCdf(
  cdf: (x: number) => number,
  sf: (x: number) => number,
  p: number,
  bracket: Bracket,
  pdf?: (x: number) => number,
): number {
  const lowerTail = p <= 0.5;
  const q = 1 - p;
  // Increasing in x and zero at the quantile; its derivative is the pdf either way.
  const residual = lowerTail ? (x: number): number => cdf(x) - p : (x: number): number => q - sf(x);
  let { lo, hi } = bracket;
  let factor = 2;
  if (!bracket.loFixed) {
    while (residual(lo) > 0) {
      if (lo === -Number.MAX_VALUE) throw outOfRange();
      hi = lo;
      lo = Math.max(lo * factor, -Number.MAX_VALUE);
      factor = nextFactor(factor);
    }
  }
  factor = 2;
  while (residual(hi) < 0) {
    if (hi === Number.MAX_VALUE) throw outOfRange();
    lo = hi;
    hi = Math.min(hi * factor, Number.MAX_VALUE);
    factor = nextFactor(factor);
  }

  const tolerance = QUANTILE_TOLERANCE * (lowerTail ? p : q);
  // While lo is still the support bound 0, bisection steps toward it by squaring factors.
  let zeroFactor = 2;
  let x = bisectionPoint(lo, hi, zeroFactor);
  let previousError = Infinity;
  for (let i = 0; i < QUANTILE_MAX_ITER; i++) {
    const f = residual(x);
    const error = Math.abs(f);
    if (error <= tolerance) return x;
    if (f > 0) hi = x;
    else lo = x;
    let next = Number.NaN;
    // Newton, unless the last step failed to halve the error (then bisect once).
    if (pdf && error <= 0.5 * previousError) {
      const d = pdf(x);
      if (Number.isFinite(d) && d > 0) {
        const newton = x - f / d;
        if (newton > lo && newton < hi) next = newton;
      }
    }
    previousError = Number.isNaN(next) ? Infinity : error;
    if (Number.isNaN(next)) {
      if (lo === 0) zeroFactor = nextFactor(zeroFactor);
      next = bisectionPoint(lo, hi, zeroFactor);
      if (!(next > lo && next < hi)) {
        // lo and hi are adjacent doubles: no representable x does better.
        return Math.abs(residual(lo)) <= Math.abs(residual(hi)) ? lo : hi;
      }
    }
    x = next;
  }
  throw new NumericRangeError(
    `quantile did not converge to within ${tolerance} of the ${lowerTail ? 'lower' : 'upper'} tail probability in ${QUANTILE_MAX_ITER} iterations (p = ${p})`,
  );
}

function solveQuantile(p: number, lower: number, upper: number, solve: () => number): number {
  assertProbability(p);
  if (p === 0) return lower;
  if (p === 1) return upper;
  return noNegativeZero(solve());
}

// ---------------------------------------------------------------------------
// Continuous distributions
// ---------------------------------------------------------------------------

/** Normal distribution N(mean, stddev²). Defaults to the standard normal. */
export function normal(mean = 0, stddev = 1): ContinuousDistribution {
  assertFinite(mean, 'mean');
  assertPositive(stddev, 'stddev');
  const pdfNorm = stddev * SQRT_2PI;
  const erfcScale = stddev * SQRT2;
  const quantile = (p: number): number =>
    solveQuantile(p, -Infinity, Infinity, () => mean + stddev * normalQuantile(p));
  return {
    pdf(x) {
      assertPoint(x, 'x');
      const z = (x - mean) / stddev;
      return noNegativeZero(Math.exp(-0.5 * z * z) / pdfNorm);
    },
    cdf(x) {
      assertPoint(x, 'x');
      return noNegativeZero(0.5 * erfcRaw(-(x - mean) / erfcScale));
    },
    sf(x) {
      assertPoint(x, 'x');
      return noNegativeZero(0.5 * erfcRaw((x - mean) / erfcScale));
    },
    quantile,
    mean,
    variance: stddev * stddev,
  };
}

function studentTCdf(x: number, df: number, lnB: number): number {
  if (x === Infinity) return 1;
  if (x === -Infinity) return 0;
  if (x === 0) return 0.5;
  const t2 = x * x;
  const tail = Number.isFinite(t2)
    ? 0.5 * betaI(df / (df + t2), t2 / (df + t2), df / 2, 0.5, lnB)
    : 0.5 * betaI(df / x / x, 1, df / 2, 0.5, lnB);
  return x > 0 ? 1 - tail : tail;
}

/** ln of the central t density's normalizer, ln Γ((df+1)/2) − ln Γ(df/2) − ½ ln(df·π). */
function studentTLnNorm(df: number): number {
  return lnGamma((df + 1) / 2) - lnGamma(df / 2) - 0.5 * Math.log(df * Math.PI);
}

function studentTPdf(x: number, df: number, lnNorm: number): number {
  return Math.exp(lnNorm - ((df + 1) / 2) * Math.log1p((x * x) / df));
}

/** Student's t distribution with `df > 0` degrees of freedom. */
export function studentT(df: number): ContinuousDistribution {
  assertPositive(df, 'df');
  const lnB = lnBeta(df / 2, 0.5);
  const lnNorm = studentTLnNorm(df);
  const cdf = (x: number): number => studentTCdf(x, df, lnB);
  const pdf = (x: number): number => studentTPdf(x, df, lnNorm);
  const quantile = (p: number): number =>
    solveQuantile(p, -Infinity, Infinity, () =>
      p === 0.5 ? 0 : invertCdf(cdf, x => cdf(-x), p, { lo: -1, hi: 1, loFixed: false }, pdf),
    );
  return {
    pdf(x) {
      assertPoint(x, 'x');
      return Number.isFinite(x) ? pdf(x) : 0;
    },
    cdf(x) {
      assertPoint(x, 'x');
      return noNegativeZero(cdf(x));
    },
    sf(x) {
      assertPoint(x, 'x');
      return noNegativeZero(cdf(-x));
    },
    quantile,
    mean: df > 1 ? 0 : undefined,
    variance: df > 2 ? df / (df - 2) : df > 1 ? Infinity : undefined,
  };
}

/**
 * Largest |ncp| `noncentralT` accepts: beyond it `exp(−ncp²/2)` underflows in
 * the AS 243 series. Power is already 1 (or 0) to double precision there, so
 * callers can clamp to this value without changing any visible result.
 */
export const MAX_NONCENTRALITY = 37.62;
const MAX_NCP = MAX_NONCENTRALITY;
const SQRT_2_OVER_PI = Math.sqrt(2 / Math.PI);
const NCT_MAX_TERMS = 5000;
const NCT_RELATIVE_ERROR = 1e-15;

/**
 * P(T ≤ tt) for tt ≥ 0, where T is noncentral t with `df` and noncentrality
 * `ncp` (or `−ncp` when `flip`). Per-distribution constants are hoisted here.
 */
type NctKernel = (tt: number, flip: boolean) => number;

function nctKernel(df: number, ncp: number): NctKernel {
  const b = 0.5 * df;
  const lnB = lnBeta(0.5, b);
  const lambda = ncp * ncp;
  const p0 = 0.5 * Math.exp(-0.5 * lambda);
  const q0 = SQRT_2_OVER_PI * p0;
  const phiOf = [0.5 * erfcRaw(ncp / SQRT2), 0.5 * erfcRaw(-ncp / SQRT2)];
  const lenthS = 1 / (4 * df);
  return (tt, flip) => {
    const del = flip ? -ncp : ncp;
    const phi = phiOf[flip ? 1 : 0] ?? 0;
    if (df > 4e5) {
      // Lenth's normal approximation for very large df (written to stay finite as tt → ∞).
      const s = lenthS;
      const z =
        tt > 1
          ? (1 - s - del / tt) / Math.sqrt(1 / (tt * tt) + 2 * s)
          : (tt * (1 - s) - del) / Math.sqrt(1 + tt * tt * 2 * s);
      return 0.5 * erfcRaw(-z / SQRT2);
    }
    if (tt === 0) return phi;
    // x = t²/(t²+df), y = df/(t²+df) = 1 − x, formed so neither overflows nor loses the tail.
    const t2 = tt * tt;
    let x: number;
    let y: number;
    if (Number.isFinite(t2)) {
      x = t2 / (t2 + df);
      y = df / (t2 + df);
    } else {
      const r = df / tt / tt;
      x = 1 / (1 + r);
      y = r / (1 + r);
    }
    // y underflowed: every incomplete beta term is exactly 1, so the series sums to its limit, 1.
    if (y === 0) return 1;
    // Lenth (1989), AS 243: Poisson-weighted series of incomplete beta terms.
    let p = p0;
    let q = q0 * del;
    let s = 0.5 - p;
    let a = 0.5;
    const lnY = Math.log(y);
    const rxb = Math.exp(b * lnY);
    let xodd = betaI(x, y, a, b, lnB);
    let godd = 2 * rxb * Math.exp(a * Math.log(x) - lnB);
    const bx = b * x;
    let xeven = bx < EPS ? bx : -Math.expm1(b * lnY);
    let geven = bx * rxb;
    let tnc = p * xodd + q * xeven;
    for (let it = 1; it < NCT_MAX_TERMS; it++) {
      a += 1;
      xodd -= godd;
      xeven -= geven;
      godd *= (x * (a + b - 1)) / a;
      geven *= (x * (a + b - 0.5)) / (a + 0.5);
      p *= lambda / (2 * it);
      q *= lambda / (2 * it + 1);
      tnc += p * xodd + q * xeven;
      s -= p;
      if (s < -1e-10) break;
      if (s <= 0 && it > 1) break;
      // Stop once the remaining-terms bound is negligible relative to the running value.
      if (Math.abs(2 * s * (xodd - godd)) <= NCT_RELATIVE_ERROR * Math.abs(tnc + phi)) break;
    }
    return tnc + phi;
  };
}

function nctCdfFrom(kernel: NctKernel, t: number): number {
  if (t === Infinity) return 1;
  if (t === -Infinity) return 0;
  const v = t >= 0 ? kernel(t, false) : 1 - kernel(-t, true);
  return Math.min(1, Math.max(0, v));
}

function nctSfFrom(kernel: NctKernel, t: number): number {
  if (t === Infinity) return 0;
  if (t === -Infinity) return 1;
  const v = t >= 0 ? 1 - kernel(t, false) : kernel(-t, true);
  return Math.min(1, Math.max(0, v));
}

/**
 * Noncentral t density near 0 by the Johnson–Kotz–Balakrishnan power series
 * f(x) = C(x) · Σⱼ Γ((df+j+1)/2)/(Γ((df+1)/2)·j!) · zʲ, z = ncp·x·√2/√(df+x²),
 * split into even and odd terms with exact ratio recurrences and rescaled
 * before it can overflow. For z ≥ 0 every term is positive, so it is stable
 * at any size; for z < 0 the terms alternate, so it is only used while
 * |z|·√((df+1)/2) ≤ 2.5 (cancellation then costs < 3 digits).
 */
function nctPdfSeries(x: number, df: number, lnC: number, gammaRatio: number, z: number): number {
  const z2 = z * z;
  let even = 1;
  let odd = gammaRatio * z;
  let sum = even + odd;
  let lnScale = 0;
  for (let k = 0; k < NCT_PDF_MAX_TERMS; k++) {
    even *= ((df + 2 * k + 1) / 2) * (z2 / ((2 * k + 1) * (2 * k + 2)));
    odd *= ((df + 2 * k + 2) / 2) * (z2 / ((2 * k + 2) * (2 * k + 3)));
    sum += even + odd;
    if (sum > 1e280) {
      even /= 1e280;
      odd /= 1e280;
      sum /= 1e280;
      lnScale += LN_1E280;
    }
    if (Math.abs(even) + Math.abs(odd) <= 1e-17 * Math.abs(sum)) break;
  }
  return Math.exp(lnC + lnScale - ((df + 1) / 2) * Math.log(df + x * x)) * sum;
}

const NCT_PDF_MAX_TERMS = 4000;
const LN_1E280 = Math.log(1e280);
/** Largest |z|·√((df+1)/2) at which the alternating (z < 0) power series is used. */
const NCT_SERIES_LIMIT = 2.5;
/**
 * Largest z·√((df+1)/2) at which the all-positive (z ≥ 0) series is used; with
 * z < √2·37.62 this bounds the series to well under NCT_PDF_MAX_TERMS terms.
 */
const NCT_POSITIVE_SERIES_LIMIT = 400;

/**
 * Noncentral t distribution with `df > 0` degrees of freedom and noncentrality
 * `ncp` (|ncp| ≤ 37.62). `cdf` is Lenth's (1989) AS 243 series (~1e-14; a normal
 * approximation is used for df > 4e5); it returns the exact limits 1 / 0 once
 * df/x² underflows. `pdf` uses the Johnson–Kotz–Balakrishnan power series on
 * the side of 0 where x and ncp share a sign (all terms positive) and close to
 * 0 on the other side; elsewhere it uses the identity
 * f(x) = df/x · [F(x·√(1+2/df); df+2) − F(x; df)], where the cdf difference no
 * longer cancels (accurate to ~1e-15 absolute, so relative accuracy fades only
 * where the density itself is below ~1e-13). `quantile` is the safeguarded Newton solver.
 * With `ncp = 0` it equals `studentT(df)`.
 */
export function noncentralT(df: number, ncp: number): ContinuousDistribution {
  assertPositive(df, 'df');
  assertFinite(ncp, 'ncp');
  if (Math.abs(ncp) > MAX_NCP) throw new InvalidArgumentError(`ncp must be within ±${MAX_NCP}, got ${ncp}`);
  const mean = df > 1 ? ncp * Math.sqrt(df / 2) * Math.exp(lnGamma((df - 1) / 2) - lnGamma(df / 2)) : undefined;
  const variance =
    mean !== undefined && df > 2 ? (df * (1 + ncp * ncp)) / (df - 2) - mean * mean : df > 1 ? Infinity : undefined;
  if (ncp === 0) {
    const central = studentT(df);
    return { ...central, mean, variance };
  }
  const kernel = nctKernel(df, ncp);
  const kernelPlus2 = nctKernel(df + 2, ncp);
  const cdf = (x: number): number => nctCdfFrom(kernel, x);
  const stretch = Math.sqrt(1 + 2 / df);
  const halfDfPlus1 = (df + 1) / 2;
  const seriesScale = Math.sqrt(halfDfPlus1);
  const lnC = (df / 2) * Math.log(df) - (ncp * ncp) / 2 + lnGamma(halfDfPlus1) - lnGamma(df / 2) - LN_SQRT_PI;
  const gammaRatio = Math.exp(lnGamma(df / 2 + 1) - lnGamma(halfDfPlus1));
  const pdf = (x: number): number => {
    if (!Number.isFinite(x)) return 0;
    const z = (ncp * x * SQRT2) / Math.sqrt(df + x * x);
    const w = z * seriesScale;
    if (w >= -NCT_SERIES_LIMIT && w <= NCT_POSITIVE_SERIES_LIMIT) return nctPdfSeries(x, df, lnC, gammaRatio, z);
    return Math.max(0, (df / x) * (nctCdfFrom(kernelPlus2, x * stretch) - cdf(x)));
  };
  const quantile = (p: number): number =>
    solveQuantile(p, -Infinity, Infinity, () =>
      invertCdf(cdf, x => nctSfFrom(kernel, x), p, { lo: -1, hi: 1, loFixed: false }, pdf),
    );
  return {
    pdf(x) {
      assertPoint(x, 'x');
      return noNegativeZero(pdf(x));
    },
    cdf(x) {
      assertPoint(x, 'x');
      return noNegativeZero(cdf(x));
    },
    sf(x) {
      assertPoint(x, 'x');
      return noNegativeZero(nctSfFrom(kernel, x));
    },
    quantile,
    mean,
    variance,
  };
}

/** Chi-square distribution with `df > 0` degrees of freedom. */
export function chiSquare(df: number): ContinuousDistribution {
  assertPositive(df, 'df');
  const k = df / 2;
  const gln = lnGamma(k);
  const lnNorm = k * Math.LN2 + gln;
  const cdf = (x: number): number => {
    if (x <= 0) return 0;
    if (x === Infinity) return 1;
    return gammaPQ(k, x / 2, gln).p;
  };
  const sf = (x: number): number => {
    if (x <= 0) return 1;
    if (x === Infinity) return 0;
    return gammaPQ(k, x / 2, gln).q;
  };
  const pdf = (x: number): number => {
    if (x < 0 || x === Infinity) return 0;
    if (x === 0) return df < 2 ? Infinity : df === 2 ? 0.5 : 0;
    return Math.exp((k - 1) * Math.log(x) - x / 2 - lnNorm);
  };
  const quantile = (p: number): number =>
    solveQuantile(p, 0, Infinity, () => invertCdf(cdf, sf, p, { lo: 0, hi: Math.max(1, df), loFixed: true }, pdf));
  return {
    pdf(x) {
      assertPoint(x, 'x');
      return pdf(x);
    },
    cdf(x) {
      assertPoint(x, 'x');
      return noNegativeZero(cdf(x));
    },
    sf(x) {
      assertPoint(x, 'x');
      return noNegativeZero(sf(x));
    },
    quantile,
    mean: df,
    variance: 2 * df,
  };
}

/** Fisher's F distribution with `df1, df2 > 0` degrees of freedom. */
export function fisherF(df1: number, df2: number): ContinuousDistribution {
  assertPositive(df1, 'df1');
  assertPositive(df2, 'df2');
  const a = df1 / 2;
  const b = df2 / 2;
  const lnB = lnBeta(a, b);
  const lnPdfConst = 0.5 * df2 * Math.log(df2) - lnB;
  const cdf = (x: number): number => {
    if (x <= 0) return 0;
    if (x === Infinity) return 1;
    const d = df1 * x + df2;
    return betaI((df1 * x) / d, df2 / d, a, b, lnB);
  };
  const sf = (x: number): number => {
    if (x <= 0) return 1;
    if (x === Infinity) return 0;
    const d = df1 * x + df2;
    // 1 − I_u(a, b) = I_{1−u}(b, a), evaluated on its own accurate side.
    return betaI(df2 / d, (df1 * x) / d, b, a, lnB);
  };
  const pdf = (x: number): number => {
    if (x < 0 || x === Infinity) return 0;
    if (x === 0) return df1 < 2 ? Infinity : df1 === 2 ? 1 : 0;
    const lnNum = 0.5 * (df1 * Math.log(df1 * x) - (df1 + df2) * Math.log(df1 * x + df2));
    return Math.exp(lnNum + lnPdfConst - Math.log(x));
  };
  const quantile = (p: number): number =>
    solveQuantile(p, 0, Infinity, () => invertCdf(cdf, sf, p, { lo: 0, hi: 1, loFixed: true }, pdf));
  return {
    pdf(x) {
      assertPoint(x, 'x');
      return pdf(x);
    },
    cdf(x) {
      assertPoint(x, 'x');
      return noNegativeZero(cdf(x));
    },
    sf(x) {
      assertPoint(x, 'x');
      return noNegativeZero(sf(x));
    },
    quantile,
    mean: df2 > 2 ? df2 / (df2 - 2) : undefined,
    variance:
      df2 > 4
        ? (2 * df2 * df2 * (df1 + df2 - 2)) / (df1 * (df2 - 2) * (df2 - 2) * (df2 - 4))
        : df2 > 2
          ? Infinity
          : undefined,
  };
}

/** Exponential distribution with `rate > 0`. */
export function exponential(rate: number): ContinuousDistribution {
  assertPositive(rate, 'rate');
  const quantile = (p: number): number => solveQuantile(p, 0, Infinity, () => -Math.log1p(-p) / rate);
  return {
    pdf(x) {
      assertPoint(x, 'x');
      return x < 0 ? 0 : noNegativeZero(rate * Math.exp(-rate * x));
    },
    cdf(x) {
      assertPoint(x, 'x');
      return x <= 0 ? 0 : noNegativeZero(-Math.expm1(-rate * x));
    },
    sf(x) {
      assertPoint(x, 'x');
      return x <= 0 ? 1 : noNegativeZero(Math.exp(-rate * x));
    },
    quantile,
    mean: 1 / rate,
    variance: 1 / (rate * rate),
  };
}

/** Continuous uniform distribution on `[min, max]`, with `min < max`. */
export function uniform(min: number, max: number): ContinuousDistribution {
  assertFinite(min, 'min');
  assertFinite(max, 'max');
  if (!(min < max)) throw new InvalidArgumentError(`min (${min}) must be less than max (${max})`);
  const width = max - min;
  const quantile = (p: number): number => solveQuantile(p, min, max, () => min + p * width);
  return {
    pdf(x) {
      assertPoint(x, 'x');
      return x < min || x > max ? 0 : 1 / width;
    },
    cdf(x) {
      assertPoint(x, 'x');
      return x <= min ? 0 : x >= max ? 1 : noNegativeZero((x - min) / width);
    },
    sf(x) {
      assertPoint(x, 'x');
      return x <= min ? 1 : x >= max ? 0 : noNegativeZero((max - x) / width);
    },
    quantile,
    mean: (min + max) / 2,
    variance: (width * width) / 12,
  };
}

// ---------------------------------------------------------------------------
// Discrete distributions
// ---------------------------------------------------------------------------

/** Smallest k in [0, upper] with cdf(k) ≥ p exactly (no tolerance), by binary search. */
function searchDiscrete(cdf: (k: number) => number, p: number, upper: number): number {
  let lo = 0;
  let hi = upper;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (cdf(mid) >= p) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Binomial distribution: `n` trials (non-negative safe integer), success probability `p` in [0, 1]. */
export function binomial(n: number, p: number): DiscreteDistribution {
  if (typeof n !== 'number') throw new TypeError('n must be a number');
  if (!Number.isSafeInteger(n) || n < 0)
    throw new InvalidArgumentError(`n must be a non-negative safe integer, got ${n}`);
  assertFinite(p, 'p');
  if (p < 0 || p > 1) throw new InvalidArgumentError(`p must be in [0, 1], got ${p}`);
  const lnN = lnGamma(n + 1);
  const lnP = Math.log(p);
  const ln1mP = Math.log1p(-p);
  const cdf = (k: number): number => {
    if (k < 0) return 0;
    if (k >= n) return 1;
    const f = Math.floor(k);
    return betaI(1 - p, p, n - f, f + 1);
  };
  const quantile = (q: number): number => {
    assertProbability(q);
    if (q === 0) return 0;
    if (q === 1) return n;
    return searchDiscrete(cdf, q, n);
  };
  return {
    pmf(k) {
      assertPoint(k, 'k');
      if (!Number.isInteger(k) || k < 0 || k > n) return 0;
      if (p === 0) return k === 0 ? 1 : 0;
      if (p === 1) return k === n ? 1 : 0;
      return Math.exp(lnN - lnGamma(k + 1) - lnGamma(n - k + 1) + k * lnP + (n - k) * ln1mP);
    },
    cdf(k) {
      assertPoint(k, 'k');
      return noNegativeZero(cdf(k));
    },
    sf(k) {
      assertPoint(k, 'k');
      if (k < 0) return 1;
      if (k >= n) return 0;
      const f = Math.floor(k);
      // P(X > f) = I_p(f + 1, n − f), the complement of the cdf's I_{1−p}(n − f, f + 1).
      return noNegativeZero(betaI(p, 1 - p, f + 1, n - f));
    },
    quantile,
    mean: n * p,
    variance: n * p * (1 - p),
  };
}

/** Poisson distribution with rate `lambda > 0`. */
export function poisson(lambda: number): DiscreteDistribution {
  assertPositive(lambda, 'lambda');
  const lnLambda = Math.log(lambda);
  const cdf = (k: number): number => {
    if (k < 0) return 0;
    if (k === Infinity) return 1;
    return gammaPQ(Math.floor(k) + 1, lambda).q;
  };
  const quantile = (q: number): number => {
    assertProbability(q);
    if (q === 0) return 0;
    if (q === 1) return Infinity;
    let hi = Math.max(1, Math.ceil(lambda));
    while (cdf(hi) < q) hi *= 2;
    return searchDiscrete(cdf, q, hi);
  };
  return {
    pmf(k) {
      assertPoint(k, 'k');
      if (!Number.isInteger(k) || k < 0 || k === Infinity) return 0;
      return Math.exp(k * lnLambda - lambda - lnGamma(k + 1));
    },
    cdf(k) {
      assertPoint(k, 'k');
      return noNegativeZero(cdf(k));
    },
    sf(k) {
      assertPoint(k, 'k');
      if (k < 0) return 1;
      if (k === Infinity) return 0;
      return noNegativeZero(gammaPQ(Math.floor(k) + 1, lambda).p);
    },
    quantile,
    mean: lambda,
    variance: lambda,
  };
}

/** The standard normal, N(0, 1), shared so callers do not rebuild it on every call. */
export const standardNormal: ContinuousDistribution = normal();
