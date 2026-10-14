/**
 * Descriptive statistics over plain JS numbers, or over `Decimal` values.
 *
 * `mean`, `median`, `minMax`, `variance` and `stddev` follow the element type:
 * plain numbers give a fast, approximate `number`; `Decimal` elements give an
 * exact `Decimal`. `sum` is number-only because an empty input cannot tell
 * which zero to return; use `Decimal.sum` for an exact total. `mode`,
 * `percentile`, `quantile`, `correlation` and `linearRegression` are
 * number-only: interpolation and regression are approximate by nature, so an
 * exact type would promise precision they lack.
 *
 * Every input must be finite; `NaN` and `±Infinity` throw rather than spread.
 * Inputs may be any iterable but are read once and never modified (no in-place
 * sort). Results never carry `-0`.
 */

import type { ScaleOptions } from './decimal.js';
import type { RoundingMode } from './rounding.js';
import { Decimal, isDecimal } from './decimal.js';
import { normal, studentT } from './distributions.js';
import { EmptyDataError, InvalidArgumentError, NumericRangeError, RoundingNecessaryError } from './errors.js';
import { divideRounded, pow10 } from './internal/bigint.js';
import { assertScale } from './internal/fraction.js';
import { applyQTranspose, backSubstitute, householderQr } from './internal/householder.js';
import { assertFinite } from './number.js';

export type VarianceOptions = {
  /** Delta degrees of freedom: 1 = sample (default), 0 = population. */
  ddof?: 0 | 1;
};

export type MinMax = {
  min: number;
  max: number;
};

/**
 * `y = intercept + slope * x`, with the usual least-squares diagnostics. They use
 * n - 2 residual degrees of freedom (n - k - 1 with k = 1 predictor) and are
 * `undefined` for exactly two points, where no residual freedom is left.
 */
export type LinearFit = Fit &
  FitDiagnostics & {
    readonly slope: number;
    readonly intercept: number;
    /** Standard error of the slope: `residualStandardError / sqrt(sum((x - mean x)^2))`. */
    readonly slopeStandardError: number | undefined;
    /** Standard error of the intercept: `residualStandardError * sqrt(1/n + mean(x)^2 / sum((x - mean x)^2))`. */
    readonly interceptStandardError: number | undefined;
  };

/**
 * Hyndman & Fan's nine sample-quantile definitions (Amer. Statistician 50(4), 1996),
 * by NumPy's names; R's `quantile(x, type = k)` is the R-k column.
 *
 * | method                     | R   | also known as                                        |
 * | -------------------------- | --- | ---------------------------------------------------- |
 * | `'inverseCdf'`             | R-1 | nearest-rank method, SAS 3                           |
 * | `'averagedInverseCdf'`     | R-2 | SAS 5; averages at the jumps (the median rule)       |
 * | `'closestObservation'`     | R-3 | SAS 2; nearest order statistic, ties to the even one |
 * | `'interpolatedInverseCdf'` | R-4 | SAS 1; linear in the empirical CDF                   |
 * | `'hazen'`                  | R-5 | piecewise linear through the midpoints               |
 * | `'weibull'`                | R-6 | Excel `PERCENTILE.EXC` / `QUARTILE.EXC`, Minitab, SPSS |
 * | `'linear'` (default)       | R-7 | Excel `PERCENTILE.INC`, NumPy and R default          |
 * | `'medianUnbiased'`         | R-8 | Hyndman & Fan's recommendation                       |
 * | `'normalUnbiased'`         | R-9 | Blom; unbiased for normal data                       |
 *
 * R-1 to R-3 always return a data value; R-4 to R-9 interpolate. Positions
 * outside the data clamp to the smallest or largest value (so R-6's `q = 0.01`
 * of ten values is the minimum, where Excel's `PERCENTILE.EXC` errors).
 */
export const QUANTILE_METHODS = [
  'inverseCdf',
  'averagedInverseCdf',
  'closestObservation',
  'interpolatedInverseCdf',
  'hazen',
  'weibull',
  'linear',
  'medianUnbiased',
  'normalUnbiased',
] as const;

export type QuantileMethod = (typeof QUANTILE_METHODS)[number];

export type QuantileOptions = {
  /** Sample-quantile definition; default `'linear'` (R-7). */
  method?: QuantileMethod;
};

/**
 * A quantile method, or one of the two "median of each half" rules. They differ
 * only for an odd count, in where the middle value goes:
 * - `'tukey'`: Tukey's hinges; the median belongs to BOTH halves (R `fivenum`,
 *   `boxplot.stats`; Wikipedia's "Method 2").
 * - `'medianExcluded'`: the median belongs to NEITHER half (TI-83/TI-84
 *   `1-Var Stats`, Moore & McCabe; Wikipedia's "Method 1").
 *
 * For 6, 7, 15, 36, 39, 40, 41, 42, 43, 47, 49: `'medianExcluded'` gives Q1 = 15,
 * Q3 = 43; `'tukey'` gives Q1 = 25.5, Q3 = 42.5.
 */
export type QuartileMethod = QuantileMethod | 'tukey' | 'medianExcluded';

export type QuartileOptions = {
  /** Default `'linear'` (R-7), like `quantile`. */
  method?: QuartileMethod;
};

export type Quartiles = {
  /** First quartile (or lower hinge). */
  q1: number;
  /** The median. */
  q2: number;
  /** Third quartile (or upper hinge). */
  q3: number;
};

/**
 * How `percentileRank` counts values equal to the score (the `kind` of SciPy's
 * `percentileofscore`); with B values below and E equal, out of N:
 * - `'strict'`: B / N, the share strictly below.
 * - `'weak'`: (B + E) / N, the share at or below (the empirical CDF).
 * - `'mean'` (default): (B + E / 2) / N, the textbook percentile rank: half of the ties count as below.
 * - `'rank'`: SciPy's default, the average of the ranks the ties would take: (B + (E + 1) / 2) / N when E > 0, else B / N.
 */
export type PercentileRankKind = 'strict' | 'weak' | 'mean' | 'rank';

export type PercentileRankOptions = {
  kind?: PercentileRankKind;
};

/** Confidence-interval method: `'z'` (normal critical value) or `'t'` (Student's t, for estimated spread). */
export type IntervalMethod = 'z' | 't';

export type ConfidenceIntervalOptions = VarianceOptions & {
  /** Confidence level in (0, 1). Default 0.95. */
  level?: number;
  /** Default `'t'` with `n - 1` degrees of freedom. */
  method?: IntervalMethod;
};

export type ConfidenceInterval = {
  mean: number;
  lower: number;
  upper: number;
  marginOfError: number;
  level: number;
};

/**
 * A group known only by its size and SAMPLE spread (ddof 1): `{ n, stddev }` or
 * `{ n, variance }`. Accepted by `pooledVariance` and `pooledStddev`.
 */
export type SampleSummary =
  { n: number; stddev: number; variance?: never } | { n: number; variance: number; stddev?: never };

export type MarginOfErrorInput = {
  /** Standard deviation of the data (sample, unless you know the population value). */
  stddev: number;
  /** Number of observations. */
  n: number;
  level?: number;
  method?: IntervalMethod;
};

/** Sample size for estimating a mean to within `marginOfError`, given the spread `stddev`. */
export type MeanSampleSizeInput = { marginOfError: number; stddev: number; level?: number; proportion?: never };
/** Sample size for estimating a proportion; `proportion` defaults to 0.5, the worst case. */
export type ProportionSampleSizeInput = { marginOfError: number; proportion?: number; level?: number; stddev?: never };

/**
 * A fitted curve: its fit quality and a function to evaluate it.
 *
 * The coefficients and `predict` are computed by the fit itself. In the
 * exponential, logarithmic, power and polynomial fits, `r2` and the other
 * diagnostics are measured on first read: reading any one of them measures
 * them all, once, with the same arithmetic and the same result as an eager
 * fit. They are enumerable own getters, so `JSON.stringify(fit)`, `{ ...fit }`
 * and `Object.keys(fit)` show them as plain values. Until that first read the
 * fit holds its own copy of the data (never the caller's arrays, which may
 * change after the call returns); it drops the copy once the diagnostics are
 * measured. `linearRegression` measures its diagnostics during the call: its
 * residual pass costs less than the copy of the data a later pass would need.
 */
type Fit = {
  /** Coefficient of determination `1 - SSres / SStot`, measured on the original y values. */
  readonly r2: number;
  predict(x: number): number;
};

/**
 * Least-squares diagnostics with k predictors and n points, on df = n - k - 1
 * residual degrees of freedom. Both are `undefined` when df is 0 (the fit
 * passes through every point, so the scatter around it cannot be estimated).
 */
type FitDiagnostics = {
  /** `1 - (1 - r2) * (n - 1) / (n - k - 1)`: r2 penalised for the number of predictors. */
  readonly adjustedR2: number | undefined;
  /** Standard error of the estimate (R's "residual standard error", Excel `STEYX`): `sqrt(SSres / (n - k - 1))`. */
  readonly residualStandardError: number | undefined;
};

/** `y = a * e^(b * x)`. */
export type ExponentialFit = Fit & { readonly a: number; readonly b: number };
/** `y = a + b * ln(x)`. */
export type LogarithmicFit = Fit & { readonly a: number; readonly b: number };
/** `y = a * x^b`. */
export type PowerFit = Fit & { readonly a: number; readonly b: number };
/**
 * `y = c[0] + c[1] * x + c[2] * x^2 + ...`, lowest degree first. Diagnostics use
 * k = degree predictors, so n - degree - 1 residual degrees of freedom.
 */
export type PolynomialFit = Fit & FitDiagnostics & { readonly coefficients: readonly number[] };

type NumericValues = Iterable<number> | Iterable<Decimal>;

function mixedInputs(): TypeError {
  return new TypeError('mixed number and Decimal inputs; convert one side');
}

/** Reads the input once into an array (an array input is returned as-is). */
function materialize(values: Iterable<number | Decimal>): readonly (number | Decimal)[] {
  return Array.isArray(values) ? values : [...values];
}

/**
 * The first element, to pick the number or `Decimal` path, plus the whole
 * sequence for a single pass. Nothing is copied; a one-shot iterable (a
 * generator) is resumed rather than restarted.
 */
function peek(values: Iterable<number | Decimal>): {
  first: number | Decimal | undefined;
  all: Iterable<number | Decimal>;
} {
  if (Array.isArray(values)) return { first: values[0], all: values };
  const iterator = values[Symbol.iterator]();
  const head = iterator.next();
  if (head.done === true) return { first: undefined, all: [] };
  function* resumed(): Generator<number | Decimal> {
    yield head.value;
    for (let next = iterator.next(); next.done !== true; next = iterator.next()) yield next.value;
  }
  return { first: head.value, all: resumed() };
}

/** `ddof` checked once for both the number and the `Decimal` path. */
function ddofOf(options: VarianceOptions): 0 | 1 {
  const ddof: unknown = options.ddof ?? 1;
  if (ddof !== 0 && ddof !== 1) throw new InvalidArgumentError(`ddof must be 0 or 1, got ${String(ddof)}`);
  return ddof;
}

/** The number path's entry: rejects any `Decimal` element, then validates as before. */
function numbersFrom(items: readonly (number | Decimal)[], name: string): readonly number[] {
  if (items.every((item): item is number => typeof item === 'number')) return toNumbers(items, name);
  throw invalidElement(items, name);
}

function decimalsFrom(items: readonly (number | Decimal)[]): readonly Decimal[] {
  const out: Decimal[] = [];
  for (const item of items) {
    if (!isDecimal(item)) throw mixedInputs();
    out.push(item);
  }
  return out;
}

function scaleOptionsOf(options: Partial<ScaleOptions> | undefined): ScaleOptions | undefined {
  if (options?.scale === undefined) return undefined;
  return options.rounding === undefined
    ? { scale: options.scale }
    : { scale: options.scale, rounding: options.rounding };
}

function noNegativeZero(value: number): number {
  return value === 0 ? 0 : value;
}

/**
 * Validates every element and returns them as an array. An array input is
 * returned as-is (never mutated by this module — sorting works on a copy),
 * so the common case allocates nothing.
 */
function toNumbers(values: Iterable<number>, name: string): readonly number[] {
  const out: readonly number[] = Array.isArray(values) ? values : [...values];
  let index = 0;
  for (const value of out) {
    // Cheap check first; the message is only built for the failing element.
    if (typeof value !== 'number' || !Number.isFinite(value)) assertFinite(value, `${name}[${index}]`);
    index++;
  }
  return out;
}

/**
 * The error the number path throws for the first bad element of `items`:
 * a non-number (a mixed-in `Decimal`, or anything else) is reported before a
 * non-finite number, wherever each sits.
 */
function invalidElement(items: readonly unknown[], name: string): Error {
  const index = items.findIndex(item => typeof item !== 'number');
  if (index !== -1) return isDecimal(items[index]) ? mixedInputs() : elementError(items[index], `${name}[${index}]`);
  const bad = items.findIndex(item => !Number.isFinite(item));
  return elementError(items[bad], `${name}[${bad}]`);
}

/** The error `assertFinite` throws for an element that is not a finite number. */
function elementError(value: unknown, at: string): Error {
  return typeof value === 'number'
    ? new InvalidArgumentError(`${at} must be finite, got ${value}`)
    : new TypeError(`${at} must be a number`);
}

/**
 * Compensated sum of number elements, or a non-finite value when an element
 * is not finite or the sum overflows (a non-finite element makes the running
 * total non-finite for good, so no per-element check is needed). Four
 * interleaved streams each keep the exact error of every addition (Knuth's
 * TwoSum), and the stream totals are merged with TwoSum too, keeping those
 * errors: as accurate as one Neumaier pass, with four independent dependency
 * chains instead of one.
 */
function pairedSum(items: readonly unknown[], name: string): number {
  let total0 = 0;
  let error0 = 0;
  let total1 = 0;
  let error1 = 0;
  let total2 = 0;
  let error2 = 0;
  let total3 = 0;
  let error3 = 0;
  const length = items.length;
  let i = 0;
  for (; i + 3 < length; i += 4) {
    const a = items[i];
    const b = items[i + 1];
    const c = items[i + 2];
    const d = items[i + 3];
    if (typeof a !== 'number' || typeof b !== 'number' || typeof c !== 'number' || typeof d !== 'number') {
      throw invalidElement(items, name);
    }
    let next = total0 + a;
    let part = next - total0;
    error0 += total0 - (next - part) + (a - part);
    total0 = next;
    next = total1 + b;
    part = next - total1;
    error1 += total1 - (next - part) + (b - part);
    total1 = next;
    next = total2 + c;
    part = next - total2;
    error2 += total2 - (next - part) + (c - part);
    total2 = next;
    next = total3 + d;
    part = next - total3;
    error3 += total3 - (next - part) + (d - part);
    total3 = next;
  }
  for (; i < length; i++) {
    const a = items[i];
    if (typeof a !== 'number') throw invalidElement(items, name);
    const next = total0 + a;
    const part = next - total0;
    error0 += total0 - (next - part) + (a - part);
    total0 = next;
  }
  const low = total0 + total1;
  let part = low - total0;
  const lowError = total0 - (low - part) + (total1 - part);
  const high = total2 + total3;
  part = high - total2;
  const highError = total2 - (high - part) + (total3 - part);
  const total = low + high;
  part = total - low;
  return total + (error0 + error1 + error2 + error3 + lowError + highError + (low - (total - part)) + (high - part));
}

/**
 * Compensated sum of the elements, each checked to be a finite number
 * (`invalidElement` decides the error). The fast paired pass covers every
 * finite sum; otherwise one sequential Neumaier pass checks each element and
 * returns the overflowed total for the caller to handle.
 */
function checkedSum(items: readonly unknown[], name: string): number {
  const fast = pairedSum(items, name);
  if (Number.isFinite(fast)) return fast;
  let total = 0;
  let compensation = 0;
  for (const value of items) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidElement(items, name);
    const next = total + value;
    compensation += Math.abs(total) >= Math.abs(value) ? total - next + value : value - next + total;
    total = next;
  }
  return total + compensation;
}

function assertRepresentable(value: number, what: string): number {
  if (!Number.isFinite(value)) throw new NumericRangeError(`${what} is too large to represent`);
  return value;
}

/**
 * Mean that cannot overflow: the compensated sum divided by the count, or,
 * when the sum itself overflows, the sum of the values each divided by the
 * count (the mean of finite numbers is always finite).
 */
function meanOf(values: readonly unknown[], name = 'values'): number {
  const n = values.length;
  const total = checkedSum(values, name);
  if (Number.isFinite(total)) return total / n;
  let scaled = 0;
  let compensation = 0;
  for (const value of values) {
    if (typeof value !== 'number') continue; // unreachable: checkedSum validated every element
    const part = value / n;
    const next = scaled + part;
    compensation += Math.abs(scaled) >= Math.abs(part) ? scaled - next + part : part - next + scaled;
    scaled = next;
  }
  return scaled + compensation;
}

/** Linear interpolation that stays finite when `high - low` would overflow. */
function interpolate(low: number, high: number, fraction: number): number {
  const span = high - low;
  return Number.isFinite(span) ? low + span * fraction : low * (1 - fraction) + high * fraction;
}

function sortedCopy(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/**
 * Reorders `data` so `data[k]` holds the value a full sort would put there,
 * with nothing larger before it and nothing smaller after it. Quickselect
 * with a Hoare partition around a median-of-three pivot, so runs of equal
 * values split evenly; a range that keeps resisting partitioning is sorted
 * outright, which bounds the worst case at O(n log n).
 */
function selectInPlace(data: Float64Array, k: number): void {
  let left = 0;
  let right = data.length - 1;
  let budget = 2 * Math.ceil(Math.log2(data.length + 1)) + 4;
  while (left < right) {
    if (budget-- === 0) {
      data.subarray(left, right + 1).sort();
      return;
    }
    const a = data[left]!;
    const b = data[(left + right) >>> 1]!;
    const c = data[right]!;
    const pivot = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c)); // median of three
    let i = left;
    let j = right;
    while (i <= j) {
      while (data[i]! < pivot) i++;
      while (data[j]! > pivot) j--;
      if (i <= j) {
        const swap = data[i]!;
        data[i] = data[j]!;
        data[j] = swap;
        i++;
        j--;
      }
    }
    // Now data[left..j] <= pivot <= data[i..right], and everything between equals the pivot.
    if (k <= j) right = j;
    else if (k >= i) left = i;
    else return;
  }
}

function pairs(x: Iterable<number>, y: Iterable<number>): { xs: readonly number[]; ys: readonly number[] } {
  const xs = toNumbers(x, 'x');
  const ys = toNumbers(y, 'y');
  if (xs.length !== ys.length) {
    throw new InvalidArgumentError(`x and y must have the same length, got ${xs.length} and ${ys.length}`);
  }
  if (xs.length < 2) throw new InvalidArgumentError('at least 2 points are required');
  return { xs, ys };
}

type Centered = { sxx: number; syy: number; sxy: number; meanX: number; meanY: number; kx: number; ky: number };

/**
 * Centered sums of squares and cross-products. The sums are in units of `kx`
 * (for x) and `ky` (for y): the plain path has `kx = ky = 1`; when the plain
 * sums overflow, the data is rescaled by its largest magnitude, which leaves
 * correlation unchanged and slope recoverable as `sxy / sxx * ky / kx`.
 */
function centeredSums(xs: readonly number[], ys: readonly number[]): Centered {
  const meanX = meanOf(xs);
  const meanY = meanOf(ys);
  const plain = centeredAround(xs, ys, meanX, meanY);
  if (plain !== undefined) return plain;
  const kx = xs.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  const ky = ys.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [i, x] of xs.entries()) {
    const dx = x / kx - meanX / kx;
    const dy = (ys[i] ?? 0) / ky - meanY / ky;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  return { sxx, syy, sxy, meanX, meanY, kx, ky };
}

/**
 * Centered sums around the given means, in y's and x's own units, or
 * `undefined` when one overflows. Even and odd indices go to separate
 * accumulators (two independent chains, and an error bound of about n/2
 * roundings instead of n - 1), added together at the end.
 */
function centeredAround(
  xs: readonly number[],
  ys: readonly number[],
  meanX: number,
  meanY: number,
): Centered | undefined {
  let sxx0 = 0;
  let syy0 = 0;
  let sxy0 = 0;
  let sxx1 = 0;
  let syy1 = 0;
  let sxy1 = 0;
  const n = xs.length;
  let i = 0;
  for (; i + 1 < n; i += 2) {
    const dx0 = xs[i]! - meanX;
    const dy0 = ys[i]! - meanY;
    const dx1 = xs[i + 1]! - meanX;
    const dy1 = ys[i + 1]! - meanY;
    sxx0 += dx0 * dx0;
    syy0 += dy0 * dy0;
    sxy0 += dx0 * dy0;
    sxx1 += dx1 * dx1;
    syy1 += dy1 * dy1;
    sxy1 += dx1 * dy1;
  }
  if (i < n) {
    const dx0 = xs[i]! - meanX;
    const dy0 = ys[i]! - meanY;
    sxx0 += dx0 * dx0;
    syy0 += dy0 * dy0;
    sxy0 += dx0 * dy0;
  }
  const sxx = sxx0 + sxx1;
  const syy = syy0 + syy1;
  const sxy = sxy0 + sxy1;
  if (!Number.isFinite(sxx) || !Number.isFinite(syy) || !Number.isFinite(sxy)) return undefined;
  return { sxx, syy, sxy, meanX, meanY, kx: 1, ky: 1 };
}

/**
 * `meanOf(xs)`, `meanOf(ys)` and `centeredSums(xs, ys)` for two arrays in two
 * indexed passes, with the same arithmetic in the same order, so the results
 * are bit-identical to the general path. The first pass checks the element types and forms both
 * compensated sums the way `pairedSum` does. Returns `undefined` when the
 * lengths differ, there are fewer than 2 points, an element is not a finite
 * number (it makes a sum non-finite), or a sum overflows: the general path then
 * throws the same error it always did, or rescales.
 */
function arrayCenteredSums(xs: readonly unknown[], ys: readonly unknown[]): Centered | undefined {
  const n = xs.length;
  if (ys.length !== n || n < 2) return undefined;
  let x0 = 0;
  let xError0 = 0;
  let x1 = 0;
  let xError1 = 0;
  let y0 = 0;
  let yError0 = 0;
  let y1 = 0;
  let yError1 = 0;
  let i = 0;
  for (; i + 1 < n; i += 2) {
    const xa = xs[i];
    const xb = xs[i + 1];
    const ya = ys[i];
    const yb = ys[i + 1];
    if (typeof xa !== 'number' || typeof xb !== 'number' || typeof ya !== 'number' || typeof yb !== 'number') {
      return undefined;
    }
    let next = x0 + xa;
    let part = next - x0;
    xError0 += x0 - (next - part) + (xa - part);
    x0 = next;
    next = x1 + xb;
    part = next - x1;
    xError1 += x1 - (next - part) + (xb - part);
    x1 = next;
    next = y0 + ya;
    part = next - y0;
    yError0 += y0 - (next - part) + (ya - part);
    y0 = next;
    next = y1 + yb;
    part = next - y1;
    yError1 += y1 - (next - part) + (yb - part);
    y1 = next;
  }
  if (i < n) {
    const xa = xs[i];
    const ya = ys[i];
    if (typeof xa !== 'number' || typeof ya !== 'number') return undefined;
    let next = x0 + xa;
    let part = next - x0;
    xError0 += x0 - (next - part) + (xa - part);
    x0 = next;
    next = y0 + ya;
    part = next - y0;
    yError0 += y0 - (next - part) + (ya - part);
    y0 = next;
  }
  let total = x0 + x1;
  let part = total - x0;
  const sumX = total + (xError0 + xError1 + (x0 - (total - part)) + (x1 - part));
  total = y0 + y1;
  part = total - y0;
  const sumY = total + (yError0 + yError1 + (y0 - (total - part)) + (y1 - part));
  if (!Number.isFinite(sumX) || !Number.isFinite(sumY)) return undefined;
  // Every element is now known to be a finite number.
  return centeredAround(xs as readonly number[], ys as readonly number[], sumX / n, sumY / n);
}

/** Exact total and count of `Decimal` values in one pass, at the running largest scale; rejects numbers. */
function decimalTotal(values: Iterable<number | Decimal>): { total: Decimal; count: number } {
  let coefficient = 0n;
  let scale = 0;
  let count = 0;
  for (const value of values) {
    if (!isDecimal(value)) throw mixedInputs();
    if (value.scale > scale) {
      coefficient *= pow10(value.scale - scale);
      scale = value.scale;
    }
    coefficient += value.coefficient * pow10(scale - value.scale);
    count++;
  }
  return { total: Decimal.fromParts({ coefficient, scale }), count };
}

/** floor(sqrt(n)) for n >= 0, by Newton's iteration from above. */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  // 2^ceil(bits / 2) >= sqrt(n), and Newton's step decreases monotonically to the floor from above.
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const next = (x + n / x) >> 1n;
    if (next >= x) return x;
    x = next;
  }
}

/**
 * sqrt(numerator / denominator) rounded to an integer with `mode`, correctly:
 * the decision is made on exact integers, never on a rounded intermediate.
 * Both arguments are non-negative; `denominator` is positive.
 *
 * sqrt(N / D) = sqrt(N * D) / D. When N * D is a perfect square the value is
 * the rational root / D, which `divideRounded` rounds exactly (ties included).
 * Otherwise the value is irrational, so it is never on a tie: it lies strictly
 * between f = floor(root / D) and f + 1, and strictly above the half exactly
 * when 4 * N * D > ((2f + 1) * D)^2. A stand-in rational on the same side of
 * the half, (4f + 3) / 4 or (4f + 1) / 4, then rounds identically in every mode
 * (and makes `'unnecessary'` throw).
 */
function roundedSqrtOfRatio(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  const product = numerator * denominator;
  const root = isqrt(product);
  if (root * root === product) return divideRounded(root, denominator, mode);
  const floor = root / denominator;
  const twiceHalfway = (2n * floor + 1n) * denominator;
  const aboveHalf = 4n * product > twiceHalfway * twiceHalfway;
  return divideRounded(4n * floor + (aboveHalf ? 3n : 1n), 4n, mode);
}

/**
 * Standard deviation of `Decimal` values, correctly rounded at `scale`. With
 * every value at the common scale S (coefficients c), the variance is the
 * exact fraction (n * sum(c^2) - sum(c)^2) / (n * (n - ddof) * 10^(2S)); the
 * result's coefficient is the square root of that fraction times 10^(2 * scale),
 * rounded once.
 */
function decimalStddev(values: readonly Decimal[], ddof: 0 | 1, target: ScaleOptions): Decimal {
  const n = values.length;
  if (n <= ddof) throw new EmptyDataError(`variance needs more than ${ddof} value(s), got ${n}`);
  assertScale(target.scale);
  let common = 0;
  for (const value of values) if (value.scale > common) common = value.scale;
  let total = 0n;
  let squares = 0n;
  for (const value of values) {
    const coefficient = value.coefficient * pow10(common - value.scale);
    total += coefficient;
    squares += coefficient * coefficient;
  }
  const count = BigInt(n);
  const numerator = (count * squares - total * total) * pow10(2 * target.scale);
  const denominator = count * (count - BigInt(ddof)) * pow10(2 * common);
  const coefficient = roundedSqrtOfRatio(numerator, denominator, target.rounding ?? 'halfEven');
  return Decimal.fromParts({ coefficient, scale: target.scale });
}

/**
 * Mean for the variance's first pass, validating every element: a plain
 * paired sum, because the corrected second pass cancels the mean's rounding
 * error to first order. A sum that is not finite (a bad element, or an
 * overflow) goes through `meanOf`, which reports or handles it.
 */
function centerOf(items: readonly unknown[]): number {
  let total0 = 0;
  let total1 = 0;
  const length = items.length;
  let i = 0;
  for (; i + 1 < length; i += 2) {
    const a = items[i];
    const b = items[i + 1];
    if (typeof a !== 'number' || typeof b !== 'number') throw invalidElement(items, 'values');
    total0 += a;
    total1 += b;
  }
  if (i < length) {
    const a = items[i];
    if (typeof a !== 'number') throw invalidElement(items, 'values');
    total0 += a;
  }
  const total = total0 + total1;
  return Number.isFinite(total) ? total / length : meanOf(items);
}

/**
 * Two-pass variance of the number path's elements, validating them first: the
 * mean, then the sum of squared deviations less the rounding correction
 * (sum of deviations)² / n (the corrected two-pass algorithm of Chan, Golub
 * and LeVeque, more accurate than a one-pass update).
 */
function numberVariance(items: readonly unknown[], ddof: 0 | 1): number {
  const n = items.length;
  const mean = centerOf(items);
  if (n <= ddof) throw new EmptyDataError(`variance needs more than ${ddof} value(s), got ${n}`);
  // Two accumulators per sum, so consecutive additions do not wait on each other.
  let squares0 = 0;
  let squares1 = 0;
  let deviations0 = 0;
  let deviations1 = 0;
  let i = 0;
  for (; i + 1 < n; i += 2) {
    const a = items[i];
    const b = items[i + 1];
    if (typeof a !== 'number' || typeof b !== 'number') continue; // unreachable: centerOf validated every element
    const da = a - mean;
    const db = b - mean;
    squares0 += da * da;
    squares1 += db * db;
    deviations0 += da;
    deviations1 += db;
  }
  const last = items[i];
  if (i < n && typeof last === 'number') {
    const deviation = last - mean;
    squares0 += deviation * deviation;
    deviations0 += deviation;
  }
  const deviations = deviations0 + deviations1;
  const m2 = Math.max(0, squares0 + squares1 - (deviations * deviations) / n);
  return noNegativeZero(assertRepresentable(m2 / (n - ddof), 'variance'));
}

function decimalVariance(values: readonly Decimal[], ddof: number, options: ScaleOptions | undefined): Decimal {
  const n = values.length;
  if (n <= ddof) throw new EmptyDataError(`variance needs more than ${ddof} value(s), got ${n}`);
  const total = Decimal.sum(values);
  const squares = Decimal.sum(values.map(value => value.times(value)));
  const numerator = squares.times(n).minus(total.times(total));
  try {
    return numerator.dividedBy(n * (n - ddof), options);
  } catch (error) {
    if (error instanceof RoundingNecessaryError && options === undefined) {
      throw new RoundingNecessaryError('variance does not terminate in decimal; pass { scale, rounding } to round it');
    }
    throw error;
  }
}

/**
 * Total of the values using Neumaier compensated summation. An empty input
 * gives `0`. Numbers only: for an exact total of `Decimal` values use
 * `Decimal.sum`, which returns a `Decimal` zero for an empty input.
 */
export function sum(values: Iterable<number>): number {
  const items = materialize(values);
  if (isDecimal(items[0])) throw new TypeError('sum takes numbers; use Decimal.sum for Decimal values');
  return noNegativeZero(assertRepresentable(checkedSum(items, 'values'), 'sum'));
}

/** Arithmetic mean (compensated sum divided by the count). Throws `EmptyDataError` when empty. */
export function mean(values: Iterable<number>): number;
/**
 * Exact mean of `Decimal` values: the exact sum divided by the count. Like
 * `Decimal.dividedBy`, it throws `RoundingNecessaryError` when the result does
 * not terminate (`[1, 1, 2]`) unless you pass `{ scale, rounding }`.
 */
export function mean(values: Iterable<Decimal>, options?: ScaleOptions): Decimal;
export function mean(values: NumericValues, options?: ScaleOptions): number | Decimal {
  const { first, all } = peek(values);
  if (isDecimal(first)) {
    const { total, count } = decimalTotal(all);
    return total.dividedBy(count, options);
  }
  const data = materialize(all);
  if (data.length === 0) throw new EmptyDataError('mean of an empty data set');
  return noNegativeZero(meanOf(data));
}

/** Middle value; for an even count, the average of the two middle values. Throws `EmptyDataError` when empty. */
export function median(values: Iterable<number>): number;
/** Exact median of `Decimal` values; the midpoint of two middles, `(a + b) / 2`, is always exact in decimal. */
export function median(values: Iterable<Decimal>): Decimal;
export function median(values: NumericValues): number | Decimal {
  const items = materialize(values);
  if (isDecimal(items[0])) {
    const ordered = [...decimalsFrom(items)].sort((a, b) => a.compareTo(b));
    const middle = ordered.length >> 1;
    return ordered.length % 2 === 1 ? ordered[middle]! : ordered[middle - 1]!.plus(ordered[middle]!).dividedBy(2);
  }
  const sorted = sortedCopy(numbersFrom(items, 'values'));
  const n = sorted.length;
  if (n === 0) throw new EmptyDataError('median of an empty data set');
  const mid = n >> 1;
  return noNegativeZero(n % 2 === 1 ? sorted[mid]! : sorted[mid - 1]! / 2 + sorted[mid]! / 2);
}

/** Every most-frequent value, ascending. Ties return all tied values; an empty input gives `[]`. */
export function mode(values: Iterable<number>): number[] {
  const counts = new Map<number, number>();
  let best = 0;
  for (const value of toNumbers(values, 'values')) {
    const key = noNegativeZero(value);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count > best) best = count;
  }
  const result: number[] = [];
  for (const [value, count] of counts) if (count === best) result.push(value);
  return result.sort((a, b) => a - b);
}

/**
 * The `p`-th percentile, `p` in `[0, 100]`. By default linear interpolation
 * between closest ranks (R-7: Excel `PERCENTILE.INC`, NumPy default); pass
 * `{ method }` for any other Hyndman–Fan definition (see `QUANTILE_METHODS`).
 * Equal to `quantile(values, p / 100, options)`.
 * Throws `EmptyDataError` when empty and `InvalidArgumentError` when `p` is out of range.
 */
export function percentile(values: Iterable<number>, p: number, options: QuantileOptions = {}): number {
  assertFinite(p, 'p');
  if (p < 0 || p > 100) throw new InvalidArgumentError(`p must be within [0, 100], got ${p}`);
  return quantileOf(values, p / 100, quantileMethodOf(options.method), 'percentile');
}

/**
 * The `q`-th quantile, `q` in `[0, 1]`, with the same methods as `percentile`
 * (default R-7): `quantile(values, 0.9)` equals `percentile(values, 90)`.
 * Throws `EmptyDataError` when empty and `InvalidArgumentError` when `q` is out of range.
 */
export function quantile(values: Iterable<number>, q: number, options: QuantileOptions = {}): number {
  assertFinite(q, 'q');
  if (q < 0 || q > 1) throw new InvalidArgumentError(`q must be within [0, 1], got ${q}`);
  return quantileOf(values, q, quantileMethodOf(options.method), 'quantile');
}

function isQuantileMethod(value: unknown): value is QuantileMethod {
  return typeof value === 'string' && (QUANTILE_METHODS as readonly string[]).includes(value);
}

function quantileMethodOf(method: unknown): QuantileMethod {
  if (method === undefined) return 'linear';
  if (isQuantileMethod(method)) return method;
  const shown = typeof method === 'string' ? method : typeof method;
  throw new InvalidArgumentError(`method must be one of ${QUANTILE_METHODS.join(', ')}; got ${shown}`);
}

/** A position this close to a whole number is taken as whole: R's `4 * .Machine$double.eps`. */
const POSITION_FUZZ = 4 * Number.EPSILON;

/**
 * Where the `q`-th quantile of `n` sorted values sits: between the 0-based
 * indexes `lower` and `lower + 1` (either may fall outside the data and is then
 * clamped), `fraction` of the way. This is R's `quantile.default`, step for step.
 */
function quantilePosition(n: number, q: number, method: QuantileMethod): { lower: number; fraction: number } {
  switch (method) {
    case 'inverseCdf':
    case 'averagedInverseCdf':
    case 'closestObservation': {
      // 1-based: j = floor(nq + m), m = 0 (R-1, R-2) or -1/2 (R-3); then pick x_j, x_{j+1} or their mean.
      const position = method === 'closestObservation' ? n * q - 0.5 : n * q;
      const j = Math.floor(position + POSITION_FUZZ);
      // Within the fuzz of a whole number counts as on it: 10 * 0.3 is 3.0000000000000004, but nq is 3.
      const past = position - j > POSITION_FUZZ;
      let fraction: number;
      if (method === 'inverseCdf') fraction = past ? 1 : 0;
      else if (method === 'averagedInverseCdf') fraction = past ? 1 : 0.5;
      else fraction = past || Math.abs(j % 2) === 1 ? 1 : 0;
      return { lower: j - 1, fraction };
    }
    default: {
      // Continuous types: 1-based position a + q(n + 1 - a - b), here shifted to 0-based.
      const [a, b] = PLOTTING_POSITIONS[method];
      const position = a - 1 + q * (n + 1 - a - b);
      const lower = Math.floor(position + POSITION_FUZZ);
      const fraction = position - lower;
      return { lower, fraction: Math.abs(fraction) < POSITION_FUZZ ? 0 : fraction };
    }
  }
}

/** Hyndman & Fan's (alpha, beta) for the continuous definitions R-4 to R-9. */
const PLOTTING_POSITIONS: Record<
  Exclude<QuantileMethod, 'inverseCdf' | 'averagedInverseCdf' | 'closestObservation'>,
  readonly [number, number]
> = {
  interpolatedInverseCdf: [0, 1],
  hazen: [0.5, 0.5],
  weibull: [0, 0],
  linear: [1, 1],
  medianUnbiased: [1 / 3, 1 / 3],
  normalUnbiased: [3 / 8, 3 / 8],
};

function clampIndex(index: number, n: number): number {
  return Math.min(n - 1, Math.max(0, index));
}

/** The quantile at `position` of `sorted` (ascending). */
function quantileFromSorted(sorted: readonly number[], position: { lower: number; fraction: number }): number {
  const n = sorted.length;
  const low = sorted[clampIndex(position.lower, n)]!;
  if (position.fraction === 0) return noNegativeZero(low);
  const high = sorted[clampIndex(position.lower + 1, n)]!;
  if (position.fraction === 1) return noNegativeZero(high);
  return noNegativeZero(interpolate(low, high, position.fraction));
}

function quantileOf(values: Iterable<number>, q: number, method: QuantileMethod, label: string): number {
  const items: readonly unknown[] = Array.isArray(values) ? values : [...values];
  const n = items.length;
  // Validate into an unboxed copy, then select the two ranks needed instead of sorting everything.
  const data = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const value = items[i];
    if (typeof value !== 'number' || !Number.isFinite(value)) throw elementError(value, `values[${i}]`);
    data[i] = value;
  }
  if (n === 0) throw new EmptyDataError(`${label} of an empty data set`);
  const { lower, fraction } = quantilePosition(n, q, method);
  const lowIndex = clampIndex(lower, n);
  const highIndex = clampIndex(lower + 1, n);
  if (fraction === 1) {
    selectInPlace(data, highIndex);
    return noNegativeZero(data[highIndex]!);
  }
  selectInPlace(data, lowIndex);
  const low = data[lowIndex]!;
  if (fraction === 0 || highIndex === lowIndex) return noNegativeZero(low);
  // Everything after `lowIndex` is at least `low`; the next rank is the smallest of those.
  let high = data[lowIndex + 1]!;
  for (let i = lowIndex + 2; i < n; i++) if (data[i]! < high) high = data[i]!;
  return noNegativeZero(interpolate(low, high, fraction));
}

/**
 * The three quartiles in one sort. `method` is any `quantile` method (default
 * `'linear'`, R-7), or a "median of each half" rule (see `QuartileMethod`):
 * `'tukey'` (the box-plot hinges of R's `fivenum`, the middle value in both
 * halves when the count is odd) or `'medianExcluded'` (the TI-83 rule, the
 * middle value in neither half). A single value is all three quartiles.
 * Throws `EmptyDataError` when empty.
 */
export function quartiles(values: Iterable<number>, options: QuartileOptions = {}): Quartiles {
  const halves = options.method === 'tukey' || options.method === 'medianExcluded';
  const method = halves ? 'linear' : quantileMethodOf(options.method);
  const sorted = sortedCopy(toNumbers(values, 'values'));
  const n = sorted.length;
  if (n === 0) throw new EmptyDataError('quartiles of an empty data set');
  if (halves) {
    // The median of `length` sorted values starting at `start`.
    const medianOf = (start: number, length: number): number => {
      const low = sorted[start + Math.floor((length - 1) / 2)]!;
      const high = sorted[start + Math.floor(length / 2)]!;
      return noNegativeZero(low === high ? low : low / 2 + high / 2);
    };
    // Each half's length; an odd count's middle value joins both halves ('tukey') or neither.
    const half = n % 2 === 0 ? n / 2 : options.method === 'tukey' || n === 1 ? (n + 1) / 2 : (n - 1) / 2;
    return { q1: medianOf(0, half), q2: medianOf(0, n), q3: medianOf(n - half, half) };
  }
  const at = (q: number): number => quantileFromSorted(sorted, quantilePosition(n, q, method));
  return { q1: at(0.25), q2: at(0.5), q3: at(0.75) };
}

/**
 * Where `score` falls in `values`, as a percentage in `[0, 100]` — the inverse
 * of `percentile`. `kind` says how values equal to the score count (see
 * `PercentileRankKind`); the default `'mean'` counts half of them, so the
 * median of distinct values ranks 50. `score` need not be one of the values.
 * Matches SciPy's `percentileofscore(values, score, kind)`.
 * Throws `EmptyDataError` when empty.
 */
export function percentileRank(values: Iterable<number>, score: number, options: PercentileRankOptions = {}): number {
  assertFinite(score, 'score');
  const kind: unknown = options.kind ?? 'mean';
  if (kind !== 'strict' && kind !== 'weak' && kind !== 'mean' && kind !== 'rank') {
    throw new InvalidArgumentError(`kind must be 'strict', 'weak', 'mean' or 'rank', got ${String(kind)}`);
  }
  const data = toNumbers(values, 'values');
  const n = data.length;
  if (n === 0) throw new EmptyDataError('percentileRank of an empty data set');
  let below = 0;
  let equal = 0;
  for (const value of data) {
    if (value < score) below++;
    else if (value === score) equal++;
  }
  let count: number;
  switch (kind) {
    case 'strict': {
      count = below;
      break;
    }
    case 'weak': {
      count = below + equal;
      break;
    }
    case 'mean': {
      count = below + equal / 2;
      break;
    }
    default: {
      count = equal === 0 ? below : below + (equal + 1) / 2;
    }
  }
  return (count / n) * 100;
}

/**
 * Variance by the corrected two-pass algorithm. Sample (`ddof: 1`, divide by n - 1)
 * by default; `ddof: 0` gives the population variance (divide by n).
 * Throws `EmptyDataError` unless there are more than `ddof` values.
 */
export function variance(values: Iterable<number>, options?: VarianceOptions): number;
/**
 * Exact variance of `Decimal` values, computed as
 * `(n * sum(x^2) - sum(x)^2) / (n * (n - ddof))` with a single division, so
 * nothing is rounded before the end. Like `Decimal.dividedBy`, it throws
 * `RoundingNecessaryError` when the result does not terminate unless you pass
 * `{ scale, rounding }`.
 */
export function variance(values: Iterable<Decimal>, options?: VarianceOptions & Partial<ScaleOptions>): Decimal;
export function variance(
  values: NumericValues,
  options: VarianceOptions & Partial<ScaleOptions> = {},
): number | Decimal {
  const ddof = ddofOf(options);
  const items = materialize(values);
  if (isDecimal(items[0])) return decimalVariance(decimalsFrom(items), ddof, scaleOptionsOf(options));
  return numberVariance(items, ddof);
}

/** Square root of `variance`, with the same `ddof` convention (sample by default). */
export function stddev(values: Iterable<number>, options?: VarianceOptions): number;
/**
 * Square root of the exact variance, correctly rounded at the requested scale
 * (default rounding `'halfEven'`). A square root rarely terminates, so
 * `{ scale }` is required. The variance is kept as an exact fraction and the
 * root is rounded once, so tiny variances and near-ties round correctly.
 */
export function stddev(values: Iterable<Decimal>, options: VarianceOptions & ScaleOptions): Decimal;
export function stddev(values: NumericValues, options: VarianceOptions & Partial<ScaleOptions> = {}): number | Decimal {
  const ddof = ddofOf(options);
  const items = materialize(values);
  if (isDecimal(items[0])) {
    const target = scaleOptionsOf(options);
    if (target === undefined) throw new InvalidArgumentError('stddev of Decimal values needs { scale, rounding }');
    return decimalStddev(decimalsFrom(items), ddof, target);
  }
  return noNegativeZero(Math.sqrt(numberVariance(items, ddof)));
}

/**
 * The sum of squared deviations of one `pooledVariance` group, and its size.
 * A summary's spread is a SAMPLE spread (ddof 1), so its sum is `(n - 1) * s^2`.
 */
function groupSquares(group: Iterable<number> | SampleSummary, index: number): { squares: number; n: number } {
  if (Symbol.iterator in group) {
    const items = materialize(group);
    if (items.length === 0) throw new EmptyDataError(`samples[${index}] is empty`);
    // A population variance times n is the group's sum of squared deviations.
    return { squares: numberVariance(items, 0) * items.length, n: items.length };
  }
  const n = assertCount(group.n, 1);
  if (group.variance !== undefined && group.stddev !== undefined) {
    throw new InvalidArgumentError(`samples[${index}] gives both variance and stddev; give one`);
  }
  const variance =
    group.variance === undefined
      ? assertSpread(group.stddev ?? Number.NaN, 'stddev') ** 2
      : assertSpread(group.variance, 'variance');
  return { squares: (n - 1) * variance, n };
}

/**
 * Pooled variance of two or more groups that share one spread: the within-group
 * sums of squared deviations, added, over the pooled degrees of freedom,
 * `sum(SS_i) / (N - g * ddof)` for g groups of N values in all. The default
 * `ddof: 1` is the textbook pooled sample variance
 * `sum((n_i - 1) * s_i^2) / sum(n_i - 1)` (the two-sample t-test's s_p^2, ANOVA's
 * mean square within); `ddof: 0` divides by N. A group of one value adds no
 * spread and, with `ddof: 1`, no degrees of freedom.
 *
 * A group is its raw values, or a `SampleSummary` (`{ n, stddev }` or
 * `{ n, variance }`) when only summary data is at hand. A summary's spread is
 * read as a sample spread (ddof 1, what calculators and papers report), so it
 * stands for `(n - 1) * s^2` squared deviations whatever `ddof` you pool with;
 * a summary gives the same result as the raw values it summarizes.
 *
 * Throws `EmptyDataError` for no groups, an empty group, or no degrees of
 * freedom left, and `InvalidArgumentError` for a bad summary.
 */
export function pooledVariance(
  samples: Iterable<Iterable<number> | SampleSummary>,
  options: VarianceOptions = {},
): number {
  const ddof = ddofOf(options);
  let squares = 0;
  let freedom = 0;
  let groups = 0;
  for (const sample of samples) {
    const group = groupSquares(sample, groups);
    squares += group.squares;
    freedom += group.n - ddof;
    groups++;
  }
  if (groups === 0) throw new EmptyDataError('pooledVariance of no samples');
  if (freedom <= 0) throw new EmptyDataError('pooledVariance needs more values than groups');
  return noNegativeZero(assertRepresentable(squares / freedom, 'variance'));
}

/** Square root of `pooledVariance`, with the same groups and `ddof` convention (sample by default). */
export function pooledStddev(
  samples: Iterable<Iterable<number> | SampleSummary>,
  options: VarianceOptions = {},
): number {
  return Math.sqrt(pooledVariance(samples, options));
}

/** Smallest and largest value in a single pass. Throws `EmptyDataError` when empty. */
export function minMax(values: Iterable<number>): MinMax;
/** Smallest and largest `Decimal` in a single pass. Throws `EmptyDataError` when empty. */
export function minMax(values: Iterable<Decimal>): { min: Decimal; max: Decimal };
export function minMax(values: NumericValues): MinMax | { min: Decimal; max: Decimal } {
  const items = materialize(values);
  if (isDecimal(items[0])) {
    const decimals = decimalsFrom(items);
    let low = decimals[0]!;
    let high = low;
    for (const value of decimals) {
      if (value.lt(low)) low = value;
      if (value.gt(high)) high = value;
    }
    return { min: low, max: high };
  }
  const data = numbersFrom(items, 'values');
  if (data.length === 0) throw new EmptyDataError('minMax of an empty data set');
  let min = data[0]!;
  let max = min;
  for (const value of data) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min: noNegativeZero(min), max: noNegativeZero(max) };
}

/**
 * Pearson correlation coefficient `r` in `[-1, 1]`.
 * Throws `InvalidArgumentError` for different lengths, fewer than 2 points,
 * or when either side is constant (r is undefined).
 */
export function correlation(x: Iterable<number>, y: Iterable<number>): number {
  const { xs, ys } = pairs(x, y);
  const { sxx, syy, sxy } = centeredSums(xs, ys);
  if (sxx === 0 || syy === 0) throw new InvalidArgumentError('correlation is undefined when x or y is constant');
  const r = sxy / Math.sqrt(sxx) / Math.sqrt(syy);
  return noNegativeZero(Math.min(1, Math.max(-1, r)));
}

/**
 * Ordinary least-squares line `y = slope * x + intercept`.
 * Throws `InvalidArgumentError` for different lengths, fewer than 2 points,
 * or when x is constant (the slope is undefined).
 */
export function linearRegression(x: Iterable<number>, y: Iterable<number>): LinearFit {
  const { xs, ys, centered, slope, intercept } = fitLine(x, y);
  const { sxx, syy, meanX, kx, ky } = centered;
  const fit = { slope, intercept };
  const predict = (at: number): number => fit.intercept + fit.slope * at;
  // Two accumulators, as in `centeredAround`.
  let residual0 = 0;
  let residual1 = 0;
  const n = xs.length;
  let i = 0;
  for (; i + 1 < n; i += 2) {
    const miss0 = ys[i]! - (intercept + slope * xs[i]!);
    const miss1 = ys[i + 1]! - (intercept + slope * xs[i + 1]!);
    residual0 += miss0 * miss0;
    residual1 += miss1 * miss1;
  }
  if (i < n) {
    const miss0 = ys[i]! - (intercept + slope * xs[i]!);
    residual0 += miss0 * miss0;
  }
  const residual = residual0 + residual1;
  // In y's own units, the centered syy is exactly the total sum of squares.
  const total = kx === 1 && ky === 1 ? syy : sumsOfSquares(ys, ys).total; // (only its total is used)
  const quality = diagnosticsOf({ residual, total }, n, 1);
  const scatter = quality.residualStandardError;
  // sum((x - mean x)^2) is sxx * kx^2; keep the scale factor out of the square.
  const spreadX = Math.sqrt(sxx) * kx;
  const centerX = meanX / kx;
  return {
    ...fit,
    ...quality,
    slopeStandardError: scatter === undefined ? undefined : noNegativeZero(scatter / spreadX),
    interceptStandardError:
      scatter === undefined ? undefined : noNegativeZero(scatter * Math.sqrt(1 / n + (centerX * centerX) / sxx)),
    predict,
  };
}

/**
 * The data a fit keeps for diagnostics it measures later. A caller's array may
 * change after the call returns, so it is copied; an array this module built
 * (from any other iterable) is already the fit's own.
 */
function owned(data: readonly number[], input: Iterable<number>): readonly number[] {
  return data === input ? [...data] : data;
}

/**
 * `measure`'s result, computed on the first call and returned ever after. Once
 * it has run, `measure` (and the data it holds) is released.
 */
function once<T>(measure: () => T): () => T {
  let state: { measure: () => T } | { value: T } = { measure };
  return () => {
    if ('measure' in state) state = { value: state.measure() };
    return state.value;
  };
}

type Line = { xs: readonly number[]; ys: readonly number[]; centered: Centered; slope: number; intercept: number };

/**
 * The least-squares line of validated data, without diagnostics; every
 * line-based fit starts here. Two plain number arrays take the fused
 * `arrayCenteredSums` path; anything else (and any data that path declines)
 * goes through `pairs` and `centeredSums`, which report errors and rescale.
 */
function fitLine(x: Iterable<number>, y: Iterable<number>): Line {
  const fast = Array.isArray(x) && Array.isArray(y) ? arrayCenteredSums(x, y) : undefined;
  let xs: readonly number[];
  let ys: readonly number[];
  let centered: Centered;
  if (fast === undefined) {
    ({ xs, ys } = pairs(x, y));
    centered = centeredSums(xs, ys);
  } else {
    xs = x as readonly number[];
    ys = y as readonly number[];
    centered = fast;
  }
  const { sxx, sxy, meanX, meanY, kx, ky } = centered;
  if (sxx === 0) throw new InvalidArgumentError('linear regression is undefined when x is constant');
  const slope = assertRepresentable(((sxy / sxx) * ky) / kx, 'slope');
  const intercept = assertRepresentable(meanY - slope * meanX, 'intercept');
  return { xs, ys, centered, slope: noNegativeZero(slope), intercept: noNegativeZero(intercept) };
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

function assertLevel(level: number): number {
  assertFinite(level, 'level');
  if (level <= 0 || level >= 1) throw new InvalidArgumentError(`level must be within (0, 1), got ${level}`);
  return level;
}

function assertSpread(value: number, name: string): number {
  assertFinite(value, name);
  if (value < 0) throw new InvalidArgumentError(`${name} must be >= 0, got ${value}`);
  return value;
}

function assertCount(n: number, min: number): number {
  assertFinite(n, 'n');
  if (!Number.isInteger(n) || n < min) throw new InvalidArgumentError(`n must be an integer >= ${min}, got ${n}`);
  return n;
}

/** Two-sided critical value for `level`: z, or t with `n - 1` degrees of freedom. */
function criticalValue(level: number, method: IntervalMethod, n: number): number {
  if (method !== 'z' && method !== 't')
    throw new InvalidArgumentError(`method must be 'z' or 't', got ${String(method)}`);
  const upper = 1 - (1 - level) / 2;
  if (method === 'z') return normal().quantile(upper);
  if (n < 2) throw new InvalidArgumentError('a t interval needs n >= 2');
  return studentT(n - 1).quantile(upper);
}

/**
 * How many standard deviations `value` lies from `mean`: `(value - mean) / stddev`.
 * Throws `InvalidArgumentError` unless `stddev` is positive.
 */
export function zScore(value: number, mean: number, stddev: number): number {
  assertFinite(value, 'value');
  assertFinite(mean, 'mean');
  assertFinite(stddev, 'stddev');
  if (stddev <= 0) throw new InvalidArgumentError(`stddev must be positive, got ${stddev}`);
  return noNegativeZero(assertRepresentable((value - mean) / stddev, 'z-score'));
}

/**
 * Standard error of the mean, `stddev / sqrt(n)`. Pass the data (its `stddev`
 * uses `ddof`, sample by default) or a known `{ stddev, n }`.
 * Throws `EmptyDataError` when the data has too few values.
 */
export function standardError(
  values: Iterable<number> | { stddev: number; n: number },
  options?: VarianceOptions,
): number {
  if (Symbol.iterator in values) {
    const data = toNumbers(values, 'values');
    return noNegativeZero(stddev(data, options) / Math.sqrt(data.length));
  }
  return noNegativeZero(assertSpread(values.stddev, 'stddev') / Math.sqrt(assertCount(values.n, 1)));
}

/**
 * Half-width of a confidence interval for a mean: critical value times the
 * standard error. `method` is `'t'` by default (needs `n >= 2`), `level` 0.95.
 */
export function marginOfError({ stddev: spread, n, level = 0.95, method = 't' }: MarginOfErrorInput): number {
  assertLevel(level);
  const se = standardError({ stddev: spread, n });
  return noNegativeZero(criticalValue(level, method, n) * se);
}

/**
 * Confidence interval for the mean of `values`, from the exact critical value
 * of the normal (`'z'`) or Student t with `n - 1` degrees of freedom (`'t'`,
 * the default). The spread is the sample standard deviation (`ddof` 1) unless
 * you pass `ddof: 0`. Needs at least 2 values.
 */
export function confidenceInterval(
  values: Iterable<number>,
  options: ConfidenceIntervalOptions = {},
): ConfidenceInterval {
  const { level = 0.95, method = 't' } = options;
  assertLevel(level);
  const data = toNumbers(values, 'values');
  if (data.length < 2) throw new EmptyDataError(`confidence interval needs at least 2 values, got ${data.length}`);
  const center = noNegativeZero(meanOf(data));
  const margin = criticalValue(level, method, data.length) * standardError(data, options);
  assertRepresentable(margin, 'margin of error');
  return { mean: center, lower: center - margin, upper: center + margin, marginOfError: margin, level };
}

/**
 * Smallest sample size, rounded up, that keeps the margin of error at or below
 * `marginOfError` with the given `level` (default 0.95), using the normal
 * critical value `z`. For a mean pass `stddev`: `n = (z * stddev / E)^2`. For a
 * proportion pass `proportion` (default 0.5, the worst case):
 * `n = z^2 * p * (1 - p) / E^2`.
 */
export function sampleSize(input: MeanSampleSizeInput | ProportionSampleSizeInput): number {
  const { marginOfError: margin, level = 0.95 } = input;
  assertFinite(margin, 'marginOfError');
  if (margin <= 0) throw new InvalidArgumentError(`marginOfError must be positive, got ${margin}`);
  assertLevel(level);
  const z = normal().quantile(1 - (1 - level) / 2);
  let spread: number;
  if (input.stddev === undefined) {
    const p = input.proportion ?? 0.5;
    assertFinite(p, 'proportion');
    if (p < 0 || p > 1) throw new InvalidArgumentError(`proportion must be within [0, 1], got ${p}`);
    spread = p * (1 - p);
  } else {
    if (input.proportion !== undefined) throw new InvalidArgumentError('pass stddev or proportion, not both');
    spread = assertSpread(input.stddev, 'stddev') ** 2;
  }
  // Tiny rounding noise must not push an exact integer (e.g. 100) up to 101.
  const n = Math.ceil((z * z * spread) / (margin * margin) - 1e-9);
  return Math.max(1, assertRepresentable(n, 'sample size'));
}

// ---------------------------------------------------------------------------
// Curve fits
// ---------------------------------------------------------------------------

/** Residual and total sums of squares of a fit, on the original y. */
function sumsOfSquares(ys: readonly number[], predicted: readonly number[]): { residual: number; total: number } {
  const center = meanOf(ys);
  let residual = 0;
  let total = 0;
  for (const [i, y] of ys.entries()) {
    const miss = y - (predicted[i] ?? 0);
    residual += miss * miss;
    total += (y - center) * (y - center);
  }
  return { residual, total };
}

/** `r2` from the sums of squares; a constant y is explained perfectly only by a perfect fit. */
function r2Of({ residual, total }: { residual: number; total: number }): number {
  if (total === 0) return residual === 0 ? 1 : 0;
  return noNegativeZero(Math.min(1, 1 - residual / total));
}

/** `r2` plus the diagnostics of a least-squares fit with `predictors` terms besides the intercept. */
function diagnostics(
  ys: readonly number[],
  predicted: readonly number[],
  predictors: number,
): { r2: number } & FitDiagnostics {
  return diagnosticsOf(sumsOfSquares(ys, predicted), ys.length, predictors);
}

/** `r2` plus the diagnostics, from the sums of squares of `n` points. */
function diagnosticsOf(
  sums: { residual: number; total: number },
  n: number,
  predictors: number,
): { r2: number } & FitDiagnostics {
  const r2 = r2Of(sums);
  const freedom = n - predictors - 1;
  if (freedom <= 0) return { r2, adjustedR2: undefined, residualStandardError: undefined };
  return {
    r2,
    adjustedR2: noNegativeZero(1 - ((1 - r2) * (n - 1)) / freedom),
    residualStandardError: noNegativeZero(Math.sqrt(sums.residual / freedom)),
  };
}

/** `ln` of every value, which must all be positive (the first one that is not is reported). */
function logsOf(values: readonly number[], name: string): number[] {
  const logs: number[] = [];
  for (const value of values) {
    if (value <= 0) throw new InvalidArgumentError(`${name}[${logs.length}] must be positive, got ${value}`);
    logs.push(Math.log(value));
  }
  return logs;
}

/** `r2` on the original y of a curve `model`, with `sumsOfSquares`' arithmetic but no array of predictions. */
function curveR2(xs: readonly number[], ys: readonly number[], model: (x: number) => number): () => number {
  return () => {
    const center = meanOf(ys);
    let residual = 0;
    let total = 0;
    let i = 0;
    for (const y of ys) {
      const miss = y - model(xs[i++]!);
      residual += miss * miss;
      total += (y - center) * (y - center);
    }
    return r2Of({ residual, total });
  };
}

/**
 * Exponential fit `y = a * e^(b * x)`, by least squares on `ln y` against x
 * (so large y weigh less than in a direct fit). `r2` is measured on the original y.
 * Throws `InvalidArgumentError` unless every y is positive, plus `linearRegression`'s conditions.
 */
export function exponentialRegression(x: Iterable<number>, y: Iterable<number>): ExponentialFit {
  const { xs, ys } = pairs(x, y);
  const line = fitLine(xs, logsOf(ys, 'y'));
  const a = assertRepresentable(Math.exp(line.intercept), 'a');
  const b = line.slope;
  const predict = (at: number): number => a * Math.exp(b * at);
  const r2 = once(curveR2(owned(xs, x), owned(ys, y), predict));
  return {
    a,
    b,
    get r2() {
      return r2();
    },
    predict,
  };
}

/**
 * Logarithmic fit `y = a + b * ln(x)`, by least squares on `ln x`. `r2` is
 * measured on the original y. Throws `InvalidArgumentError` unless every x is
 * positive; `predict` does too.
 */
export function logarithmicRegression(x: Iterable<number>, y: Iterable<number>): LogarithmicFit {
  const { xs, ys } = pairs(x, y);
  const logXs = logsOf(xs, 'x');
  const { intercept: a, slope: b } = fitLine(logXs, ys);
  const predict = (at: number): number => {
    assertFinite(at, 'x');
    if (at <= 0) throw new InvalidArgumentError(`x must be positive, got ${at}`);
    return a + b * Math.log(at);
  };
  // The model on ln x: `logXs` already holds every Math.log(x), so the result is the same.
  const r2 = once(curveR2(logXs, owned(ys, y), logX => a + b * logX));
  return {
    a,
    b,
    get r2() {
      return r2();
    },
    predict,
  };
}

/**
 * Power fit `y = a * x^b`, by least squares on `ln y` against `ln x`. `r2` is
 * measured on the original y. Throws `InvalidArgumentError` unless every x and
 * y is positive; `predict` needs a positive x.
 */
export function powerRegression(x: Iterable<number>, y: Iterable<number>): PowerFit {
  const { xs, ys } = pairs(x, y);
  const logXs = logsOf(xs, 'x');
  const line = fitLine(logXs, logsOf(ys, 'y'));
  const a = assertRepresentable(Math.exp(line.intercept), 'a');
  const b = line.slope;
  const predict = (at: number): number => {
    assertFinite(at, 'x');
    if (at <= 0) throw new InvalidArgumentError(`x must be positive, got ${at}`);
    return a * Math.pow(at, b);
  };
  const r2 = once(curveR2(owned(xs, x), owned(ys, y), at => a * Math.pow(at, b)));
  return {
    a,
    b,
    get r2() {
      return r2();
    },
    predict,
  };
}

/**
 * Least-squares polynomial of the given `degree`, by Householder QR with
 * column pivoting on the Vandermonde matrix (never the normal equations, which
 * square its condition number; NumPy's `polyfit` uses an SVD to the same end).
 * Coefficients are lowest degree first (`[c0, c1, ...]`); `r2` is measured on
 * the original y.
 *
 * x is centered and scaled to `u = (x - center) / halfRange`, which spans
 * [-1, 1], before solving, so data far from zero (years 2015 to 2024, say) is
 * as well conditioned as data around zero. `predict` and the diagnostics
 * evaluate the fit in that centered basis, which is the accurate path.
 * `coefficients` are mapped back to powers of x for display and reuse; for x
 * far from zero relative to its spread they are inherently sensitive (each one
 * is a sum of large terms that nearly cancel), so evaluating them by hand can
 * lose digits that `predict` keeps.
 *
 * Throws `InvalidArgumentError` for a non-integer or negative degree, or fewer
 * distinct x values than `degree + 1`, and `NumericRangeError` when the
 * Vandermonde matrix is rank-deficient to working precision: some `|r_kk|` of
 * its column-normalized QR is at or below `n · Number.EPSILON · |r₀₀|` (`n`
 * points), the rank rule of NumPy's `polyfit`, where NumPy warns.
 */
export function polynomialRegression(x: Iterable<number>, y: Iterable<number>, degree: number): PolynomialFit {
  if (!Number.isInteger(degree) || degree < 0) {
    throw new InvalidArgumentError(`degree must be a non-negative integer, got ${degree}`);
  }
  const { xs, ys } = pairs(x, y);
  if (new Set(xs).size < degree + 1) {
    throw new InvalidArgumentError(`degree ${degree} needs at least ${degree + 1} distinct x values`);
  }
  let low = xs[0]!;
  let high = low;
  for (const value of xs) {
    if (value < low) low = value;
    if (value > high) high = value;
  }
  // Halving first keeps the midrange and half-range finite for any finite x.
  const center = low / 2 + high / 2;
  const halfRange = high / 2 - low / 2 || 1;
  const size = degree + 1;
  const count = xs.length;
  // The Vandermonde matrix in u = (x - center) / halfRange, by columns (u^0, u^1, ...),
  // each scaled to unit norm as NumPy's polyfit does, so the rank test below
  // compares columns on an equal footing. |u| <= 1 with u = ±1 at the ends, so
  // every column has norm >= 1 and no power overflows.
  const buffer = new Float64Array(count * size);
  const columns: Float64Array[] = [];
  for (let k = 0; k < size; k++) columns.push(buffer.subarray(k * count, k * count + count));
  const squares = new Float64Array(size);
  for (let i = 0; i < count; i++) {
    const u = (xs[i]! - center) / halfRange;
    let power = 1;
    for (let k = 0; k < size; k++) {
      columns[k]![i] = power;
      squares[k]! += power * power;
      power *= u;
    }
  }
  const norms: number[] = [];
  for (const [k, column] of columns.entries()) {
    const norm = Math.sqrt(squares[k]!);
    const inverse = 1 / norm;
    for (let i = 0; i < count; i++) column[i]! *= inverse;
    norms.push(norm);
  }
  // Least squares by Householder QR with column pivoting: the error grows with
  // cond(V), where the normal equations VᵀV·c = Vᵀy would square it.
  const { tau, permutation } = householderQr(columns, count, true);
  const threshold = count * Number.EPSILON * Math.abs(columns[0]![0]!);
  for (let k = 0; k < size; k++) {
    if (!(Math.abs(columns[k]![k]!) > threshold)) {
      throw new NumericRangeError('polynomial fit is ill-conditioned; lower the degree or rescale x');
    }
  }
  const solution = new Float64Array(ys);
  applyQTranspose(columns, tau, count, solution);
  backSubstitute(columns, size, solution);
  const centered: number[] = Array.from<number>({ length: size }).fill(0);
  for (let k = 0; k < size; k++) centered[permutation[k]!] = solution[k]! / norms[permutation[k]!]!;
  const predictCentered = (at: number): number => {
    const u = (at - center) / halfRange;
    let result = 0;
    for (let k = degree; k >= 0; k--) result = result * u + centered[k]!;
    return result;
  };
  // Back to powers of x: divide by halfRange^k (powers of t = x - center), then
  // Taylor-shift by the center (repeated synthetic division by t = x - center).
  const coefficients = [...centered];
  for (let k = 1; k <= degree; k++) for (let j = k; j <= degree; j++) coefficients[j]! /= halfRange;
  for (let i = 0; i < degree; i++)
    for (let j = degree - 1; j >= i; j--) coefficients[j]! -= center * coefficients[j + 1]!;
  const predict = (at: number): number => {
    assertFinite(at, 'x');
    return predictCentered(at);
  };
  const measured = once(polynomialDiagnostics(owned(xs, x), owned(ys, y), predictCentered, degree));
  return {
    coefficients: coefficients.map(c => assertRepresentable(noNegativeZero(c), 'coefficient')),
    get r2() {
      return measured().r2;
    },
    get adjustedR2() {
      return measured().adjustedR2;
    },
    get residualStandardError() {
      return measured().residualStandardError;
    },
    predict,
  };
}

/** `polynomialRegression`'s diagnostics, from the fit's predictions at every x. */
function polynomialDiagnostics(
  xs: readonly number[],
  ys: readonly number[],
  predictCentered: (x: number) => number,
  degree: number,
): () => { r2: number } & FitDiagnostics {
  return () =>
    diagnostics(
      ys,
      xs.map(v => predictCentered(v)),
      degree,
    );
}
