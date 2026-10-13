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
import { EmptyDataError, InvalidArgumentError, NumericRangeError, RoundingNecessaryError } from './errors.js';
import { divideRounded, pow10 } from './internal/bigint.js';
import { assertScale } from './internal/fraction.js';
import { assertFinite } from './number.js';

export type VarianceOptions = {
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
function peek(values: Iterable<number | Decimal>): { first: number | Decimal | undefined; all: Iterable<number | Decimal> } {
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
  const index = items.findIndex((item) => typeof item !== 'number');
  if (isDecimal(items[index])) throw mixedInputs();
  throw new TypeError(`${name}[${index}] must be a number`);
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
  return options.rounding === undefined ? { scale: options.scale } : { scale: options.scale, rounding: options.rounding };
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
  return [...values].sort((a, b) => a - b);
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

/** Welford's one-pass variance of validated numbers. */
function numberVariance(data: readonly number[], ddof: 0 | 1): number {
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

function decimalVariance(values: readonly Decimal[], ddof: number, options: ScaleOptions | undefined): Decimal {
  const n = values.length;
  if (n <= ddof) throw new EmptyDataError(`variance needs more than ${ddof} value(s), got ${n}`);
  const total = Decimal.sum(values);
  const squares = Decimal.sum(values.map((value) => value.times(value)));
  const numerator = squares.times(n).minus(total.times(total));
  try {
    return numerator.dividedBy(n * (n - ddof), options);
  } catch (error) {
    if (error instanceof RoundingNecessaryError && options === undefined) {
      throw new RoundingNecessaryError(
        'variance does not terminate in decimal; pass { scale, rounding } to round it',
      );
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
  return noNegativeZero(assertRepresentable(sumOf(numbersFrom(items, 'values')), 'sum'));
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
  const data = numbersFrom(materialize(all), 'values');
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
export function variance(values: Iterable<number>, options?: VarianceOptions): number;
/**
 * Exact variance of `Decimal` values, computed as
 * `(n * sum(x^2) - sum(x)^2) / (n * (n - ddof))` with a single division, so
 * nothing is rounded before the end. Like `Decimal.dividedBy`, it throws
 * `RoundingNecessaryError` when the result does not terminate unless you pass
 * `{ scale, rounding }`.
 */
export function variance(values: Iterable<Decimal>, options?: VarianceOptions & Partial<ScaleOptions>): Decimal;
export function variance(values: NumericValues, options: VarianceOptions & Partial<ScaleOptions> = {}): number | Decimal {
  const ddof = ddofOf(options);
  const items = materialize(values);
  if (isDecimal(items[0])) return decimalVariance(decimalsFrom(items), ddof, scaleOptionsOf(options));
  return numberVariance(numbersFrom(items, 'values'), ddof);
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
  return noNegativeZero(Math.sqrt(numberVariance(numbersFrom(items, 'values'), ddof)));
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
  const { xs, ys } = pairs(x, y);
  const { sxx, sxy, meanX, meanY, kx, ky } = centeredSums(xs, ys);
  if (sxx === 0) throw new InvalidArgumentError('linear regression is undefined when x is constant');
  const slope = assertRepresentable(((sxy / sxx) * ky) / kx, 'slope');
  const intercept = assertRepresentable(meanY - slope * meanX, 'intercept');
  return { slope: noNegativeZero(slope), intercept: noNegativeZero(intercept) };
}
