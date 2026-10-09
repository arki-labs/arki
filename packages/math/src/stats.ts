/**
 * Descriptive statistics over plain JS numbers.
 *
 * Every input must be finite; `NaN` and `±Infinity` throw rather than spread.
 * Inputs may be any iterable but are read once and never modified (no in-place
 * sort). Results never carry `-0`.
 */

import { EmptyDataError, InvalidArgumentError } from './errors.js';
import { assertFinite } from './number.js';

export type SpreadOptions = {
  /** Delta degrees of freedom: 1 = sample (default), 0 = population. */
  ddof?: 0 | 1;
};

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

/** Reads the iterable once into a fresh array and checks every element. */
function toNumbers(values: Iterable<number>, name: string): number[] {
  const out = [...values];
  for (const [i, value] of out.entries()) assertFinite(value, `${name}[${i}]`);
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

function sortedCopy(values: readonly number[]): number[] {
  return values.toSorted((a, b) => a - b);
}

function pairs(x: Iterable<number>, y: Iterable<number>): { xs: number[]; ys: number[] } {
  const xs = toNumbers(x, 'x');
  const ys = toNumbers(y, 'y');
  if (xs.length !== ys.length) {
    throw new InvalidArgumentError(`x and y must have the same length, got ${xs.length} and ${ys.length}`);
  }
  if (xs.length < 2) throw new InvalidArgumentError('at least 2 points are required');
  return { xs, ys };
}

/** Centered sums of squares and cross-products: `{ sxx, syy, sxy, meanX, meanY }`. */
function centeredSums(xs: readonly number[], ys: readonly number[]) {
  const meanX = sumOf(xs) / xs.length;
  const meanY = sumOf(ys) / ys.length;
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
  return { sxx, syy, sxy, meanX, meanY };
}

/** Total of the values using Neumaier compensated summation. An empty input gives `0`. */
export function sum(values: Iterable<number>): number {
  return noNegativeZero(sumOf(toNumbers(values, 'values')));
}

/** Arithmetic mean (compensated sum divided by the count). Throws `EmptyDataError` when empty. */
export function mean(values: Iterable<number>): number {
  const data = toNumbers(values, 'values');
  if (data.length === 0) throw new EmptyDataError('mean of an empty data set');
  return noNegativeZero(sumOf(data) / data.length);
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
 * closest ranks (R-7: Excel `PERCENTILE.INC`, NumPy default).
 * Throws `EmptyDataError` when empty and `InvalidArgumentError` when `p` is out of range.
 */
export function percentile(values: Iterable<number>, p: number): number {
  assertFinite(p, 'p');
  if (p < 0 || p > 100) throw new InvalidArgumentError(`p must be within [0, 100], got ${p}`);
  const sorted = sortedCopy(toNumbers(values, 'values'));
  const n = sorted.length;
  if (n === 0) throw new EmptyDataError('percentile of an empty data set');
  const rank = ((n - 1) * p) / 100;
  const lower = Math.floor(rank);
  const fraction = rank - lower;
  const low = sorted[lower]!;
  if (fraction === 0) return noNegativeZero(low);
  return noNegativeZero(low + fraction * (sorted[lower + 1]! - low));
}

/**
 * Variance by Welford's one-pass algorithm. Sample (`ddof: 1`, divide by n - 1)
 * by default; `ddof: 0` gives the population variance (divide by n).
 * Throws `EmptyDataError` unless there are more than `ddof` values.
 */
export function variance(values: Iterable<number>, options: SpreadOptions = {}): number {
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
  return noNegativeZero(m2 / (count - ddof));
}

/** Square root of `variance`, with the same `ddof` convention (sample by default). */
export function stddev(values: Iterable<number>, options: SpreadOptions = {}): number {
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
  const r = sxy / (Math.sqrt(sxx) * Math.sqrt(syy));
  return noNegativeZero(Math.min(1, Math.max(-1, r)));
}

/**
 * Ordinary least-squares line `y = slope * x + intercept`.
 * Throws `InvalidArgumentError` for different lengths, fewer than 2 points,
 * or when x is constant (the slope is undefined).
 */
export function linearRegression(x: Iterable<number>, y: Iterable<number>): LinearFit {
  const { xs, ys } = pairs(x, y);
  const { sxx, sxy, meanX, meanY } = centeredSums(xs, ys);
  if (sxx === 0) throw new InvalidArgumentError('linear regression is undefined when x is constant');
  const slope = sxy / sxx;
  return { slope: noNegativeZero(slope), intercept: noNegativeZero(meanY - slope * meanX) };
}
