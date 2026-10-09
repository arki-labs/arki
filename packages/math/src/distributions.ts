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
  /** Quantile: the x with cdf(x) = p, p in (0, 1); p = 0 / 1 return the support bounds (±Infinity where unbounded). */
  inv(p: number): number;
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
  /** Smallest k with cdf(k) ≥ p (compared with a 1e-12 relative tolerance). */
  inv(p: number): number;
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
const DISCRETE_TOLERANCE = 1e-12;

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

/** I_x(a, b) where `y` must equal `1 - x` (passed separately so callers keep tail precision). */
function betaI(x: number, y: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (y <= 0) return 1;
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(y));
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

function erfRaw(x: number): number {
  const ax = Math.abs(x);
  if (ax === 0) return 0;
  if (ax > 6) return x < 0 ? -1 : 1;
  const { p } = gammaPQ(0.5, ax * ax, LN_SQRT_PI);
  return x < 0 ? -p : p;
}

function erfcRaw(x: number): number {
  if (x === Infinity) return 0;
  if (x < 0) return 2 - erfcRaw(-x);
  if (x === 0) return 1;
  return gammaPQ(0.5, x * x, LN_SQRT_PI).q;
}

/** The error function erf(x) = 2/√π ∫₀ˣ e^(−t²) dt (via the incomplete gamma function, ~1e-15). */
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

/** Standard normal quantile: Acklam's guess, then two Halley steps on erfc. */
function normalQuantile(p: number): number {
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

/**
 * Inverts a monotone cdf: expands a bracket, then runs Newton steps (when a
 * pdf is given) safeguarded by bisection, to a ~1e-15 relative x tolerance.
 */
function invertCdf(cdf: (x: number) => number, p: number, bracket: Bracket, pdf?: (x: number) => number): number {
  let { lo, hi } = bracket;
  if (!bracket.loFixed) {
    for (let n = 0; cdf(lo) > p; n++) {
      if (n > 1000) throw new NumericRangeError('quantile is outside the representable range');
      hi = lo;
      lo *= 2;
    }
  }
  for (let n = 0; cdf(hi) < p; n++) {
    if (n > 1000) throw new NumericRangeError('quantile is outside the representable range');
    lo = hi;
    hi *= 2;
  }
  let x = (lo + hi) / 2;
  for (let i = 0; i < 400; i++) {
    const f = cdf(x) - p;
    if (f === 0) return x;
    if (f > 0) hi = x;
    else lo = x;
    if (hi - lo <= 1e-15 * Math.max(1, Math.abs(x))) return x;
    let next = (lo + hi) / 2;
    if (pdf) {
      const d = pdf(x);
      if (Number.isFinite(d) && d > 0) {
        const newton = x - f / d;
        if (newton > lo && newton < hi) next = newton;
      }
    }
    if (Math.abs(next - x) <= 1e-15 * (1 + Math.abs(x))) return next;
    x = next;
  }
  return x;
}

function quantile(p: number, lower: number, upper: number, solve: () => number): number {
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
  return {
    pdf(x) {
      assertPoint(x, 'x');
      const z = (x - mean) / stddev;
      return noNegativeZero(Math.exp(-0.5 * z * z) / (stddev * SQRT_2PI));
    },
    cdf(x) {
      assertPoint(x, 'x');
      return noNegativeZero(0.5 * erfcRaw(-(x - mean) / (stddev * SQRT2)));
    },
    inv(p) {
      return quantile(p, -Infinity, Infinity, () => mean + stddev * normalQuantile(p));
    },
    mean,
    variance: stddev * stddev,
  };
}

function studentTCdf(x: number, df: number): number {
  if (x === Infinity) return 1;
  if (x === -Infinity) return 0;
  if (x === 0) return 0.5;
  const t2 = x * x;
  const tail = 0.5 * betaI(df / (df + t2), t2 / (df + t2), df / 2, 0.5);
  return x > 0 ? 1 - tail : tail;
}

function studentTPdf(x: number, df: number): number {
  const lnNorm = lnGamma((df + 1) / 2) - lnGamma(df / 2) - 0.5 * Math.log(df * Math.PI);
  return Math.exp(lnNorm - ((df + 1) / 2) * Math.log1p((x * x) / df));
}

/** Student's t distribution with `df > 0` degrees of freedom. */
export function studentT(df: number): ContinuousDistribution {
  assertPositive(df, 'df');
  const cdf = (x: number): number => studentTCdf(x, df);
  const pdf = (x: number): number => studentTPdf(x, df);
  return {
    pdf(x) {
      assertPoint(x, 'x');
      return Number.isFinite(x) ? pdf(x) : 0;
    },
    cdf(x) {
      assertPoint(x, 'x');
      return noNegativeZero(cdf(x));
    },
    inv(p) {
      return quantile(p, -Infinity, Infinity, () =>
        p === 0.5 ? 0 : invertCdf(cdf, p, { lo: -1, hi: 1, loFixed: false }, pdf),
      );
    },
    mean: df > 1 ? 0 : undefined,
    variance: df > 2 ? df / (df - 2) : df > 1 ? Infinity : undefined,
  };
}

/** Largest |ncp| the AS 243 series handles before exp(−ncp²/2) underflows. */
/**
 * Largest |ncp| `noncentralT` accepts: beyond it `exp(−ncp²/2)` underflows in
 * the AS 243 series. Power is already 1 (or 0) to double precision there, so
 * callers can clamp to this value without changing any visible result.
 */
export const MAX_NONCENTRALITY = 37.62;
const MAX_NCP = MAX_NONCENTRALITY;

function nctCdf(t: number, df: number, ncp: number): number {
  if (t === Infinity) return 1;
  if (t === -Infinity) return 0;
  if (ncp === 0) return studentTCdf(t, df);
  const negative = t < 0;
  const tt = Math.abs(t);
  const del = negative ? -ncp : ncp;
  let tnc: number;
  if (df > 4e5) {
    // Lenth's normal approximation for very large df.
    const s = 1 / (4 * df);
    tnc = 0.5 * erfcRaw(-(tt * (1 - s) - del) / (Math.sqrt(1 + tt * tt * 2 * s) * SQRT2));
    return Math.min(1, Math.max(0, negative ? 1 - tnc : tnc));
  }
  const x = (tt * tt) / (tt * tt + df);
  const y = df / (tt * tt + df);
  tnc = 0;
  if (x > 0) {
    // Lenth (1989), AS 243: Poisson-weighted series of incomplete beta terms.
    const lambda = del * del;
    let p = 0.5 * Math.exp(-0.5 * lambda);
    let q = (Math.SQRT2 / Math.sqrt(Math.PI)) * p * del;
    let s = 0.5 - p;
    const b = 0.5 * df;
    let a = 0.5;
    const rxb = Math.exp(b * Math.log(y));
    const albeta = LN_SQRT_PI + lnGamma(b) - lnGamma(0.5 + b);
    let xodd = betaI(x, y, a, b);
    let godd = 2 * rxb * Math.exp(a * Math.log(x) - albeta);
    tnc = b * x;
    let xeven = tnc < EPS ? tnc : -Math.expm1(b * Math.log(y));
    let geven = tnc * rxb;
    tnc = p * xodd + q * xeven;
    for (let it = 1; it < 5000; it++) {
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
      if (Math.abs(2 * s * (xodd - godd)) < 1e-14) break;
    }
  }
  tnc += 0.5 * erfcRaw(del / SQRT2);
  return Math.min(1, Math.max(0, negative ? 1 - tnc : tnc));
}

/**
 * Noncentral t distribution with `df > 0` degrees of freedom and noncentrality
 * `ncp` (|ncp| ≤ 37.62). `cdf` is Lenth's (1989) AS 243 series (~1e-12; a normal
 * approximation is used for df > 4e5). `pdf` uses the exact identity
 * f(x) = df/x · [F(x·√(1+2/df); df+2) − F(x; df)]. `inv` brackets then bisects
 * the cdf to ~1e-15 in x. With `ncp = 0` it equals `studentT(df)`.
 */
export function noncentralT(df: number, ncp: number): ContinuousDistribution {
  assertPositive(df, 'df');
  assertFinite(ncp, 'ncp');
  if (Math.abs(ncp) > MAX_NCP) throw new InvalidArgumentError(`ncp must be within ±${MAX_NCP}, got ${ncp}`);
  const cdf = (x: number): number => nctCdf(x, df, ncp);
  const lnCentral = lnGamma((df + 1) / 2) - lnGamma(df / 2) - 0.5 * Math.log(df * Math.PI);
  const mean = df > 1 ? ncp * Math.sqrt(df / 2) * Math.exp(lnGamma((df - 1) / 2) - lnGamma(df / 2)) : undefined;
  return {
    pdf(x) {
      assertPoint(x, 'x');
      if (!Number.isFinite(x)) return 0;
      if (ncp === 0) return studentTPdf(x, df);
      if (x === 0) return Math.exp(lnCentral - (ncp * ncp) / 2);
      return Math.max(0, (df / x) * (nctCdf(x * Math.sqrt(1 + 2 / df), df + 2, ncp) - cdf(x)));
    },
    cdf(x) {
      assertPoint(x, 'x');
      return noNegativeZero(cdf(x));
    },
    inv(p) {
      return quantile(p, -Infinity, Infinity, () => invertCdf(cdf, p, { lo: -1, hi: 1, loFixed: false }));
    },
    mean,
    variance:
      mean !== undefined && df > 2 ? (df * (1 + ncp * ncp)) / (df - 2) - mean * mean : df > 1 ? Infinity : undefined,
  };
}

/** Chi-square distribution with `df > 0` degrees of freedom. */
export function chiSquare(df: number): ContinuousDistribution {
  assertPositive(df, 'df');
  const k = df / 2;
  const gln = lnGamma(k);
  const cdf = (x: number): number => {
    if (x <= 0) return 0;
    if (x === Infinity) return 1;
    return gammaPQ(k, x / 2, gln).p;
  };
  const pdf = (x: number): number => {
    if (x < 0 || x === Infinity) return 0;
    if (x === 0) return df < 2 ? Infinity : df === 2 ? 0.5 : 0;
    return Math.exp((k - 1) * Math.log(x) - x / 2 - k * Math.LN2 - gln);
  };
  return {
    pdf(x) {
      assertPoint(x, 'x');
      return pdf(x);
    },
    cdf(x) {
      assertPoint(x, 'x');
      return noNegativeZero(cdf(x));
    },
    inv(p) {
      return quantile(p, 0, Infinity, () => invertCdf(cdf, p, { lo: 0, hi: Math.max(1, df), loFixed: true }, pdf));
    },
    mean: df,
    variance: 2 * df,
  };
}

/** Fisher's F distribution with `df1, df2 > 0` degrees of freedom. */
export function fisherF(df1: number, df2: number): ContinuousDistribution {
  assertPositive(df1, 'df1');
  assertPositive(df2, 'df2');
  const lnBeta = lnGamma(df1 / 2) + lnGamma(df2 / 2) - lnGamma((df1 + df2) / 2);
  const cdf = (x: number): number => {
    if (x <= 0) return 0;
    if (x === Infinity) return 1;
    const d = df1 * x + df2;
    return betaI((df1 * x) / d, df2 / d, df1 / 2, df2 / 2);
  };
  const pdf = (x: number): number => {
    if (x < 0 || x === Infinity) return 0;
    if (x === 0) return df1 < 2 ? Infinity : df1 === 2 ? 1 : 0;
    const lnNum = 0.5 * (df1 * Math.log(df1 * x) + df2 * Math.log(df2) - (df1 + df2) * Math.log(df1 * x + df2));
    return Math.exp(lnNum - Math.log(x) - lnBeta);
  };
  return {
    pdf(x) {
      assertPoint(x, 'x');
      return pdf(x);
    },
    cdf(x) {
      assertPoint(x, 'x');
      return noNegativeZero(cdf(x));
    },
    inv(p) {
      return quantile(p, 0, Infinity, () => invertCdf(cdf, p, { lo: 0, hi: 1, loFixed: true }, pdf));
    },
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
  return {
    pdf(x) {
      assertPoint(x, 'x');
      return x < 0 ? 0 : noNegativeZero(rate * Math.exp(-rate * x));
    },
    cdf(x) {
      assertPoint(x, 'x');
      return x <= 0 ? 0 : noNegativeZero(-Math.expm1(-rate * x));
    },
    inv(p) {
      return quantile(p, 0, Infinity, () => -Math.log1p(-p) / rate);
    },
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
  return {
    pdf(x) {
      assertPoint(x, 'x');
      return x < min || x > max ? 0 : 1 / width;
    },
    cdf(x) {
      assertPoint(x, 'x');
      return x <= min ? 0 : x >= max ? 1 : noNegativeZero((x - min) / width);
    },
    inv(p) {
      return quantile(p, min, max, () => min + p * width);
    },
    mean: (min + max) / 2,
    variance: (width * width) / 12,
  };
}

// ---------------------------------------------------------------------------
// Discrete distributions
// ---------------------------------------------------------------------------

/** Smallest k in [0, upper] with cdf(k) ≥ p (within tolerance), by binary search. */
function searchDiscrete(cdf: (k: number) => number, p: number, upper: number): number {
  const target = p * (1 - DISCRETE_TOLERANCE);
  let lo = 0;
  let hi = upper;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (cdf(mid) >= target) hi = mid;
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
  const cdf = (k: number): number => {
    if (k < 0) return 0;
    if (k >= n) return 1;
    const f = Math.floor(k);
    return betaI(1 - p, p, n - f, f + 1);
  };
  return {
    pmf(k) {
      assertPoint(k, 'k');
      if (!Number.isInteger(k) || k < 0 || k > n) return 0;
      if (p === 0) return k === 0 ? 1 : 0;
      if (p === 1) return k === n ? 1 : 0;
      return Math.exp(lnN - lnGamma(k + 1) - lnGamma(n - k + 1) + k * Math.log(p) + (n - k) * Math.log1p(-p));
    },
    cdf(k) {
      assertPoint(k, 'k');
      return noNegativeZero(cdf(k));
    },
    inv(q) {
      assertProbability(q);
      if (q === 0) return 0;
      if (q === 1) return n;
      return searchDiscrete(cdf, q, n);
    },
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
    inv(q) {
      assertProbability(q);
      if (q === 0) return 0;
      if (q === 1) return Infinity;
      const target = q * (1 - DISCRETE_TOLERANCE);
      let hi = Math.max(1, Math.ceil(lambda));
      while (cdf(hi) < target) hi *= 2;
      return searchDiscrete(cdf, q, hi);
    },
    mean: lambda,
    variance: lambda,
  };
}

/** The standard normal, N(0, 1), shared so callers do not rebuild it on every call. */
export const standardNormal: ContinuousDistribution = normal();
