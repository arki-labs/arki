/**
 * Descriptive statistics over plain JS numbers.
 *
 * Every input must be finite; `NaN` and `±Infinity` throw rather than spread.
 * Inputs may be any iterable but are read once and never modified (no in-place
 * sort). Results never carry `-0`.
 */

import { EmptyDataError, InvalidArgumentError, NumericRangeError } from './errors.js';
import { assertFinite } from './number.js';

export type VarianceOptions = {
  /** Delta degrees of freedom: 1 = sample (default), 0 = population. */
  ddof?: 0 | 1;
};

/** @deprecated Renamed to `VarianceOptions`. */
export type SpreadOptions = VarianceOptions;

export type MinMax = {
  min: number;
  max: number;
};

export type LinearFit = {
  slope: number;
  intercept: number;
};

function noNegativeZero(value: number): number {
  return value === 0 ? 0 : value;
}

/**
 * Validates every element and returns them as an array. An array input is
 * returned as-is (never mutated by this module — sorting goes through
 * `toSorted`), so the common case allocates nothing.
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

function sumOf(values: readonly number[]): number {
  let total = 0;
  let compensation = 0;
  for (const value of values) {
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
function meanOf(values: readonly number[]): number {
  const n = values.length;
  const total = sumOf(values);
  if (Number.isFinite(total)) return total / n;
  let scaled = 0;
  let compensation = 0;
  for (const value of values) {
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
  return values.toSorted((a, b) => a - b);
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
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [i, x] of xs.entries()) {
    const dx = x - meanX;
    const dy = (ys[i] ?? 0) - meanY;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  if (Number.isFinite(sxx) && Number.isFinite(syy) && Number.isFinite(sxy)) {
    return { sxx, syy, sxy, meanX, meanY, kx: 1, ky: 1 };
  }
  const kx = xs.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  const ky = ys.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  sxx = 0;
  syy = 0;
  sxy = 0;
  for (const [i, x] of xs.entries()) {
    const dx = x / kx - meanX / kx;
    const dy = (ys[i] ?? 0) / ky - meanY / ky;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  return { sxx, syy, sxy, meanX, meanY, kx, ky };
}

/** Total of the values using Neumaier compensated summation. An empty input gives `0`. */
export function sum(values: Iterable<number>): number {
  return noNegativeZero(assertRepresentable(sumOf(toNumbers(values, 'values')), 'sum'));
}

/** Arithmetic mean (compensated sum divided by the count). Throws `EmptyDataError` when empty. */
export function mean(values: Iterable<number>): number {
  const data = toNumbers(values, 'values');
  if (data.length === 0) throw new EmptyDataError('mean of an empty data set');
  return noNegativeZero(meanOf(data));
}

/** Middle value; for an even count, the average of the two middle values. Throws `EmptyDataError` when empty. */
export function median(values: Iterable<number>): number {
  const sorted = sortedCopy(toNumbers(values, 'values'));
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
  return result.toSorted((a, b) => a - b);
}

/**
 * The `p`-th percentile, `p` in `[0, 100]`, by linear interpolation between
 * closest ranks (R-7: Excel `PERCENTILE.INC`, NumPy default). Equal to
 * `quantile(values, p / 100)`.
 * Throws `EmptyDataError` when empty and `InvalidArgumentError` when `p` is out of range.
 */
export function percentile(values: Iterable<number>, p: number): number {
  assertFinite(p, 'p');
  if (p < 0 || p > 100) throw new InvalidArgumentError(`p must be within [0, 100], got ${p}`);
  return quantileOf(values, p / 100, 'percentile');
}

/**
 * The `q`-th quantile, `q` in `[0, 1]`, with the same R-7 interpolation as
 * `percentile`: `quantile(values, 0.9)` equals `percentile(values, 90)`.
 * Throws `EmptyDataError` when empty and `InvalidArgumentError` when `q` is out of range.
 */
export function quantile(values: Iterable<number>, q: number): number {
  assertFinite(q, 'q');
  if (q < 0 || q > 1) throw new InvalidArgumentError(`q must be within [0, 1], got ${q}`);
  return quantileOf(values, q, 'quantile');
}

function quantileOf(values: Iterable<number>, q: number, label: string): number {
  const sorted = sortedCopy(toNumbers(values, 'values'));
  const n = sorted.length;
  if (n === 0) throw new EmptyDataError(`${label} of an empty data set`);
  const rank = (n - 1) * q;
  const lower = Math.floor(rank);
  const fraction = rank - lower;
  const low = sorted[lower]!;
  if (fraction === 0) return noNegativeZero(low);
  return noNegativeZero(interpolate(low, sorted[lower + 1]!, fraction));
}

/**
 * Variance by Welford's one-pass algorithm. Sample (`ddof: 1`, divide by n - 1)
 * by default; `ddof: 0` gives the population variance (divide by n).
 * Throws `EmptyDataError` unless there are more than `ddof` values.
 */
export function variance(values: Iterable<number>, options: VarianceOptions = {}): number {
  const ddof: number = options.ddof ?? 1;
  if (ddof !== 0 && ddof !== 1) throw new InvalidArgumentError(`ddof must be 0 or 1, got ${String(ddof)}`);
  const data = toNumbers(values, 'values');
  if (data.length <= ddof) {
    throw new EmptyDataError(`variance needs more than ${ddof} value(s), got ${data.length}`);
  }
  let count = 0;
  let runningMean = 0;
  let m2 = 0;
  for (const value of data) {
    count++;
    const delta = value - runningMean;
    runningMean += delta / count;
    m2 += delta * (value - runningMean);
  }
  return noNegativeZero(assertRepresentable(m2 / (count - ddof), 'variance'));
}

/** Square root of `variance`, with the same `ddof` convention (sample by default). */
export function stddev(values: Iterable<number>, options: VarianceOptions = {}): number {
  return noNegativeZero(Math.sqrt(variance(values, options)));
}

/** Smallest and largest value in a single pass. Throws `EmptyDataError` when empty. */
export function minMax(values: Iterable<number>): MinMax {
  const data = toNumbers(values, 'values');
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
  const { xs, ys } = pairs(x, y);
  const { sxx, sxy, meanX, meanY, kx, ky } = centeredSums(xs, ys);
  if (sxx === 0) throw new InvalidArgumentError('linear regression is undefined when x is constant');
  const slope = assertRepresentable(((sxy / sxx) * ky) / kx, 'slope');
  const intercept = assertRepresentable(meanY - slope * meanX, 'intercept');
  return { slope: noNegativeZero(slope), intercept: noNegativeZero(intercept) };
}
