import { describe, expect, it } from 'vitest';

import type { QuantileMethod, VarianceOptions } from './stats.js';
import { Decimal, decimal } from './decimal.js';
import { EmptyDataError, InvalidArgumentError, NumericRangeError, RoundingNecessaryError } from './errors.js';
import {
  confidenceInterval,
  correlation,
  exponentialRegression,
  linearRegression,
  logarithmicRegression,
  marginOfError,
  mean,
  median,
  minMax,
  mode,
  percentile,
  percentileRank,
  polynomialRegression,
  pooledStddev,
  pooledVariance,
  powerRegression,
  quantile,
  QUANTILE_METHODS,
  quartiles,
  sampleSize,
  standardError,
  stddev,
  sum,
  variance,
  zScore,
} from './stats.js';

describe('sum', () => {
  it('compensates rounding error that naive addition accumulates', () => {
    expect(0.1 + 0.2 + 0.3).not.toBe(0.6);
    expect(sum([0.1, 0.2, 0.3])).toBe(0.6);
    expect(sum(Array.from({ length: 10 }, () => 0.1))).toBe(1);
  });
  it('keeps small terms next to huge ones', () => {
    expect(sum([1e100, 1, -1e100])).toBe(1);
  });
  it('returns 0 for empty input and never -0', () => {
    expect(sum([])).toBe(0);
    expect(Object.is(sum([-0, -0]), 0)).toBe(true);
  });
  it('accepts any iterable', () => {
    expect(sum(new Set([1, 2, 3]))).toBe(6);
  });
  it('rejects Number.NaN, Infinity and non-numbers', () => {
    expect(() => sum([1, Number.NaN])).toThrow(InvalidArgumentError);
    expect(() => sum([Infinity])).toThrow(InvalidArgumentError);
    // @ts-expect-error deliberate wrong type
    expect(() => sum([1, '2'])).toThrow(TypeError);
  });
});

describe('mean', () => {
  it('averages values', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(mean([0.1, 0.2, 0.3])).toBeCloseTo(0.2, 12);
  });
  it('throws on empty', () => {
    expect(() => mean([])).toThrow(EmptyDataError);
  });
  it('throws on Number.NaN', () => {
    expect(() => mean([Number.NaN])).toThrow(InvalidArgumentError);
  });
});

describe('median', () => {
  it('takes the middle for odd counts and averages the two middles for even', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
  });
  it('sorts numerically, not as text', () => {
    expect(median([10, 9, 100])).toBe(10);
  });
  it('does not mutate the caller array', () => {
    const data = [3, 1, 2];
    median(data);
    expect(data).toEqual([3, 1, 2]);
  });
  it('throws on empty', () => {
    expect(() => median([])).toThrow(EmptyDataError);
  });
});

describe('mode', () => {
  it('returns the single most frequent value', () => {
    expect(mode([1, 2, 2, 3])).toEqual([2]);
  });
  it('returns every tied value, ascending', () => {
    expect(mode([3, 1, 3, 1, 2])).toEqual([1, 3]);
    expect(mode([1, 2, 3])).toEqual([1, 2, 3]);
  });
  it('returns [] for empty input', () => {
    expect(mode([])).toEqual([]);
  });
  it('treats -0 and 0 as one value and reports 0', () => {
    const result = mode([-0, 0]);
    expect(result).toHaveLength(1);
    expect(Object.is(result[0], 0)).toBe(true);
  });
  it('rejects non-finite values', () => {
    expect(() => mode([1, Infinity])).toThrow(InvalidArgumentError);
  });
});

describe('percentile', () => {
  it('matches R-7 (Excel PERCENTILE.INC / numpy default)', () => {
    const data = [1, 2, 3, 4];
    expect(percentile(data, 0)).toBe(1);
    expect(percentile(data, 25)).toBe(1.75);
    expect(percentile(data, 50)).toBe(2.5);
    expect(percentile(data, 75)).toBe(3.25);
    expect(percentile(data, 100)).toBe(4);
  });
  it('agrees with median at p=50 on odd counts', () => {
    expect(percentile([5, 1, 3], 50)).toBe(3);
  });
  it('returns a singleton for any p', () => {
    expect(percentile([9], 0)).toBe(9);
    expect(percentile([9], 37)).toBe(9);
    expect(percentile([9], 100)).toBe(9);
  });
  it('does not mutate the caller array', () => {
    const data = [4, 2, 3, 1];
    percentile(data, 50);
    expect(data).toEqual([4, 2, 3, 1]);
  });
  it('rejects p out of range or non-finite', () => {
    expect(() => percentile([1, 2], -1)).toThrow(InvalidArgumentError);
    expect(() => percentile([1, 2], 100.5)).toThrow(InvalidArgumentError);
    expect(() => percentile([1, 2], Number.NaN)).toThrow(InvalidArgumentError);
  });
  it('throws on empty', () => {
    expect(() => percentile([], 50)).toThrow(EmptyDataError);
  });
});

describe('variance and stddev', () => {
  const data = [2, 4, 4, 4, 5, 5, 7, 9]; // mean 5, sum of squares 32
  it('population (ddof 0) divides by n', () => {
    expect(variance(data, { ddof: 0 })).toBeCloseTo(4, 12);
    expect(stddev(data, { ddof: 0 })).toBeCloseTo(2, 12);
  });
  it('sample (default) divides by n - 1', () => {
    expect(variance(data)).toBeCloseTo(32 / 7, 12);
    expect(variance(data, { ddof: 1 })).toBeCloseTo(32 / 7, 12);
    expect(stddev(data)).toBeCloseTo(Math.sqrt(32 / 7), 12);
  });
  it('stays accurate with a large offset', () => {
    expect(variance([1e9 + 4, 1e9 + 7, 1e9 + 13, 1e9 + 16])).toBeCloseTo(30, 6);
  });
  it('a single value has population variance 0 but no sample variance', () => {
    expect(variance([5], { ddof: 0 })).toBe(0);
    expect(() => variance([5])).toThrow(EmptyDataError);
  });
  it('throws on empty, even for the population form', () => {
    expect(() => variance([], { ddof: 0 })).toThrow(EmptyDataError);
    expect(() => stddev([])).toThrow(EmptyDataError);
  });
  it('rejects non-finite values', () => {
    expect(() => variance([1, Number.NaN])).toThrow(InvalidArgumentError);
  });
});

describe('minMax', () => {
  it('finds both ends', () => {
    expect(minMax([3, -1, 7, 2])).toEqual({ min: -1, max: 7 });
    expect(minMax([5])).toEqual({ min: 5, max: 5 });
  });
  it('throws on empty and non-finite', () => {
    expect(() => minMax([])).toThrow(EmptyDataError);
    expect(() => minMax([1, -Infinity])).toThrow(InvalidArgumentError);
  });
});

describe('correlation', () => {
  it('is +1 and -1 for perfect lines', () => {
    expect(correlation([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 12);
    expect(correlation([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 12);
  });
  it('matches a known dataset', () => {
    // sxy = 8, sxx = 10, syy = 10 -> r = 8 / 10
    expect(correlation([1, 2, 3, 4, 5], [2, 1, 4, 3, 5])).toBeCloseTo(0.8, 12);
  });
  it('is 0 for uncorrelated data', () => {
    expect(correlation([1, 2, 3], [1, 0, 1])).toBe(0);
  });
  it('rejects mismatched lengths and too few points', () => {
    expect(() => correlation([1, 2, 3], [1, 2])).toThrow(InvalidArgumentError);
    expect(() => correlation([1], [1])).toThrow(InvalidArgumentError);
    expect(() => correlation([], [])).toThrow(InvalidArgumentError);
  });
  it('rejects constant input on either side', () => {
    expect(() => correlation([1, 1, 1], [1, 2, 3])).toThrow(InvalidArgumentError);
    expect(() => correlation([1, 2, 3], [4, 4, 4])).toThrow(InvalidArgumentError);
  });
  it('rejects non-finite values', () => {
    expect(() => correlation([1, Number.NaN], [1, 2])).toThrow(InvalidArgumentError);
  });
  it('does not mutate inputs', () => {
    const x = [3, 1, 2];
    const y = [6, 2, 4];
    correlation(x, y);
    expect(x).toEqual([3, 1, 2]);
    expect(y).toEqual([6, 2, 4]);
  });
});

describe('linearRegression', () => {
  it('recovers a known line', () => {
    const fit = linearRegression([0, 1, 2, 3], [1, 3, 5, 7]);
    expect(fit.slope).toBeCloseTo(2, 12);
    expect(fit.intercept).toBeCloseTo(1, 12);
  });
  it('fits least squares through noisy points', () => {
    // x mean 3, y mean 3; sxy = 8, sxx = 10 -> slope 0.8, intercept 3 - 0.8 * 3 = 0.6
    const fit = linearRegression([1, 2, 3, 4, 5], [2, 1, 4, 3, 5]);
    expect(fit.slope).toBeCloseTo(0.8, 12);
    expect(fit.intercept).toBeCloseTo(0.6, 12);
  });
  it('allows constant y (flat line)', () => {
    const fit = linearRegression([1, 2, 3], [4, 4, 4]);
    expect({ slope: fit.slope, intercept: fit.intercept, r2: fit.r2 }).toEqual({ slope: 0, intercept: 4, r2: 1 });
  });
  it('reports r2 and predicts like the other fits, so callers can swap fit kinds', () => {
    // Same noisy points: r = 0.8, so r2 = 0.64 (r2 of a straight-line fit is r squared)
    const fit = linearRegression([1, 2, 3, 4, 5], [2, 1, 4, 3, 5]);
    expect(fit.r2).toBeCloseTo(0.64, 12);
    expect(fit.predict(10)).toBeCloseTo(8.6, 12);
  });
  it('rejects constant x, mismatched lengths and too few points', () => {
    expect(() => linearRegression([2, 2, 2], [1, 2, 3])).toThrow(InvalidArgumentError);
    expect(() => linearRegression([1, 2], [1])).toThrow(InvalidArgumentError);
    expect(() => linearRegression([1], [1])).toThrow(InvalidArgumentError);
  });
  it('rejects non-finite values', () => {
    expect(() => linearRegression([1, 2], [1, Infinity])).toThrow(InvalidArgumentError);
  });
  it('gives arrays (fused fast path) and other iterables (general path) bit-identical fits', () => {
    // The array path is a speed-up only: the same data must never fit differently
    // because it arrived as an array instead of a Set or a generator.
    const x = Array.from({ length: 101 }, (_, i) => 0.5 + ((i * 37) % 101) / 10);
    const y = x.map((v, i) => 5 + 3 * v + Math.sin(i) * 2);
    const fromArrays = linearRegression(x, y);
    const fromIterables = linearRegression(new Set(x), y.values());
    const fields = [
      'slope',
      'intercept',
      'r2',
      'adjustedR2',
      'residualStandardError',
      'slopeStandardError',
      'interceptStandardError',
    ] as const;
    for (const field of fields) expect(fromArrays[field]).toBe(fromIterables[field]);
  });
  it('reports the same first bad element on the array path as on the general path', () => {
    // x is checked before y, and the first bad element wins, whatever comes later.
    expect(() => linearRegression([1, Number.NaN, 3], [1, 'a' as unknown as number, 3])).toThrow('x[1] must be finite');
    expect(() => linearRegression([1, 2, 3], [1, 2, 'a' as unknown as number])).toThrow('y[2] must be a number');
    expect(() => linearRegression([1, 2, Infinity], [1, 2])).toThrow('x[2] must be finite');
  });
});

describe('overflow safety', () => {
  it('mean of values whose sum overflows is still representable', () => {
    expect(mean([1e308, 1e308])).toBe(1e308);
    expect(mean([-1e308, -1e308, -1e308])).toBe(-1e308);
  });

  it('percentile interpolates across a span that overflows', () => {
    expect(percentile([-1e308, 1e308], 50)).toBe(0);
    expect(quantile([-1e308, 1e308], 0.5)).toBe(0);
  });

  it('variance of identical huge values is 0, not NaN', () => {
    expect(variance([1e308, 1e308])).toBe(0);
  });

  it('throws NumericRangeError when the result genuinely overflows', () => {
    expect(() => sum([1e308, 1e308])).toThrow(NumericRangeError);
    expect(() => variance([-1e308, 1e308])).toThrow(NumericRangeError);
  });

  it('correlation and regression survive squares that overflow', () => {
    const x = [1e154, 2e154, 3e154, 4e154];
    const y = [2e154, 4e154, 6e154, 8e154];
    expect(correlation(x, y)).toBeCloseTo(1, 12);
    const fit = linearRegression(x, y);
    expect(fit.slope).toBeCloseTo(2, 12);
    expect(fit.intercept).toBeCloseTo(0, 12);
  });

  it('regression keeps the true slope when x is tiny relative to y', () => {
    const fit = linearRegression([1e-3, 2e-3, 3e-3], [1e300, 2e300, 3e300]);
    expect(fit.slope / 1e303).toBeCloseTo(1, 12);
  });

  it('regression throws NumericRangeError when the slope is unrepresentable', () => {
    expect(() => linearRegression([0, 1e-300], [0, 1e300])).toThrow(NumericRangeError);
  });
});

describe('quantile', () => {
  it('interpolates like percentile', () => {
    expect(quantile([1, 2, 3, 4], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 1)).toBe(4);
    expect(quantile([15, 20, 35, 40, 50], 0.4)).toBeCloseTo(29, 12);
  });

  it('equals percentile(values, q * 100) exactly', () => {
    const data = [9, 1, 4, 7, 3, 12, 5];
    for (const p of [0, 1, 10, 25, 33.3, 50, 66.6, 90, 99, 100]) {
      expect(percentile(data, p)).toBe(quantile(data, p / 100));
    }
  });

  it('rejects an out-of-range q and empty data', () => {
    expect(() => quantile([1], -0.1)).toThrow(InvalidArgumentError);
    expect(() => quantile([1], 1.1)).toThrow(InvalidArgumentError);
    expect(() => quantile([], 0.5)).toThrow(EmptyDataError);
  });
});

describe('VarianceOptions (deprecated alias)', () => {
  it('is still assignable to and from VarianceOptions', () => {
    const o: VarianceOptions = { ddof: 0 };
    const v: VarianceOptions = o;
    expect(variance([1, 3], v)).toBe(1);
  });
});

const ds = (...values: string[]) => values.map(v => decimal(v));

function* oneShotDecimals(): Generator<Decimal> {
  yield decimal('0.1');
  yield decimal('0.25');
}

function* decimalThenNumber(): Generator<Decimal | number> {
  yield decimal('1');
  yield 2;
}

describe('Decimal overloads', () => {
  it('sum has no Decimal overload: an empty Decimal[] cannot say which zero to return', () => {
    // Reviewer repro: `const xs: Decimal[] = []; sum(xs)` returned the number 0 typed as a Decimal.
    const xs: Decimal[] = [];
    // @ts-expect-error sum is number-only; Decimal.sum is the exact total
    expect(sum(xs)).toBe(0);
    expect(Decimal.sum(xs).toString()).toBe('0');
    // @ts-expect-error sum is number-only
    expect(() => sum(ds('0.1', '0.2'))).toThrow(/Decimal\.sum/);
    expect(Decimal.sum(ds('0.1', '0.2')).toString()).toBe('0.3');
  });
  it('mean reads a one-shot iterable once, without a copy, and still rejects mixed input', () => {
    expect(mean(oneShotDecimals()).toString()).toBe('0.175');
    expect(() => mean(decimalThenNumber() as Iterable<Decimal>)).toThrow(/mixed number and Decimal/);
  });
  it('mean is exact when the result terminates', () => {
    expect(mean(ds('0.1', '0.2')).toString()).toBe('0.15');
    expect(mean(ds('1', '2')).toString()).toBe('1.5');
  });
  it('mean throws when it does not terminate, unless a scale is given', () => {
    expect(() => mean(ds('1', '1', '2'))).toThrow(RoundingNecessaryError);
    expect(mean(ds('1', '1', '2'), { scale: 3, rounding: 'halfEven' }).toString()).toBe('1.333');
  });
  it('median picks the middle, or the exact midpoint of two middles', () => {
    expect(median(ds('3', '1', '2')).toString()).toBe('2');
    expect(median(ds('4', '1', '3', '2')).toString()).toBe('2.5');
    expect(median(ds('0.1', '0.2', '0.4', '0.7')).toString()).toBe('0.3');
  });
  it('median does not mutate the input', () => {
    const input = ds('3', '1', '2');
    median(input);
    expect(input.map(String)).toEqual(['3', '1', '2']);
  });
  it('minMax finds both ends', () => {
    const { min, max } = minMax(ds('2.5', '-1', '10', '3'));
    expect(min.toString()).toBe('-1');
    expect(max.toString()).toBe('10');
  });
  it('variance is exact: population variance of 1..4 is 1.25', () => {
    expect(variance(ds('1', '2', '3', '4'), { ddof: 0 }).toString()).toBe('1.25');
  });
  it('variance defaults to the sample variance', () => {
    expect(variance(ds('1', '2', '3')).toString()).toBe('1');
  });
  it('variance throws when it does not terminate, and says how to fix it', () => {
    expect(() => variance(ds('1', '1', '2'))).toThrow(RoundingNecessaryError);
    expect(() => variance(ds('1', '1', '2'))).toThrow(/scale, rounding/);
    expect(variance(ds('1', '1', '2'), { scale: 4, rounding: 'halfEven' }).toString()).toBe('0.3333');
  });
  it('variance needs more than ddof values', () => {
    expect(() => variance(ds('1'))).toThrow(EmptyDataError);
    expect(variance(ds('5'), { ddof: 0 }).toString()).toBe('0');
  });
  it('stddev takes the square root at the requested scale', () => {
    const result = stddev(ds('1', '2', '3', '4'), { ddof: 0, scale: 10, rounding: 'halfEven' });
    expect(result.toString()).toBe('1.1180339887');
  });
  it('stddev is exact when the variance is a perfect square', () => {
    expect(stddev(ds('1', '3'), { scale: 5 }).toString()).toBe('1.41421');
    expect(stddev(ds('2', '4', '4', '4', '5', '5', '7', '9'), { ddof: 0, scale: 2 }).toString()).toBe('2.00');
  });
  it('stddev rounds a tiny variance correctly instead of to zero', () => {
    // Exact variance 1e-40; the old fixed 12 guard digits rounded it to 0 at scale 32.
    const result = stddev([decimal(0), decimal('2e-20')], { ddof: 0, scale: 20 });
    expect(result.toString()).toBe('0.00000000000000000001');
  });
  it('stddev never creates a false tie by rounding the variance first', () => {
    // Exact root is 0.50000000000001, just above the half, so halfEven must give 1, not the tie answer 0.
    expect(stddev([decimal(0), decimal('1.0000000000002')], { ddof: 0, scale: 0 }).toString()).toBe('1');
  });
  it('stddev rounds exact half roots by the mode, and irrational roots in every mode', () => {
    // population stddev of [0, 1] is exactly 0.5: a real tie
    expect(stddev(ds('0', '1'), { ddof: 0, scale: 0, rounding: 'halfEven' }).toString()).toBe('0');
    expect(stddev(ds('0', '1'), { ddof: 0, scale: 0, rounding: 'halfUp' }).toString()).toBe('1');
    expect(stddev(ds('0', '1'), { ddof: 0, scale: 0, rounding: 'halfDown' }).toString()).toBe('0');
    expect(() => stddev(ds('0', '1'), { ddof: 0, scale: 0, rounding: 'unnecessary' })).toThrow(RoundingNecessaryError);
    expect(stddev(ds('0', '1'), { ddof: 0, scale: 1, rounding: 'unnecessary' }).toString()).toBe('0.5');
    // sample stddev of [1, 3] is sqrt(2) = 1.41421356...
    expect(stddev(ds('1', '3'), { scale: 4, rounding: 'down' }).toString()).toBe('1.4142');
    expect(stddev(ds('1', '3'), { scale: 4, rounding: 'up' }).toString()).toBe('1.4143');
    expect(stddev(ds('1', '3'), { scale: 4, rounding: 'floor' }).toString()).toBe('1.4142');
    expect(stddev(ds('1', '3'), { scale: 4, rounding: 'ceiling' }).toString()).toBe('1.4143');
    expect(stddev(ds('1', '3'), { scale: 6, rounding: 'halfEven' }).toString()).toBe('1.414214');
    expect(() => stddev(ds('1', '3'), { scale: 4, rounding: 'unnecessary' })).toThrow(RoundingNecessaryError);
    expect(stddev(ds('7', '7', '7'), { scale: 2, rounding: 'unnecessary' }).toString()).toBe('0.00');
  });
  it('stddev validates ddof on the Decimal path like variance does', () => {
    const bad = { ddof: -1 } as unknown as VarianceOptions;
    expect(() => stddev(ds('1', '3'), { ...bad, scale: 4 })).toThrow(InvalidArgumentError);
    expect(() => variance(ds('1', '3'), bad)).toThrow(InvalidArgumentError);
    expect(() => stddev([1, 3], bad)).toThrow(InvalidArgumentError);
    expect(() => stddev(ds('1'), { scale: 4 })).toThrow(EmptyDataError);
  });
  it('rejects mixed number and Decimal input in either order', () => {
    expect(() => sum([1, decimal('2')] as never)).toThrow(/mixed number and Decimal/);
    expect(() => mean([decimal('2'), 1] as never)).toThrow(/mixed number and Decimal/);
    expect(() => median([1, decimal('2')] as never)).toThrow(/mixed number and Decimal/);
  });
  it('treats an empty input as empty data', () => {
    expect(() => mean([])).toThrow(EmptyDataError);
    expect(() => median([])).toThrow(EmptyDataError);
    expect(() => minMax([])).toThrow(EmptyDataError);
  });
  it('accepts any iterable of Decimals', () => {
    expect(mean(new Set(ds('1', '2', '3'))).toString()).toBe('2');
  });
});

describe('fast paths give the same answers as the plain definitions', () => {
  /** Deterministic data with many duplicates, negatives and zeros. */
  function sample(length: number, seed: number): number[] {
    let state = seed;
    return Array.from({ length }, () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return Math.round((state / 2_147_483_648 - 0.5) * 20) / 2;
    });
  }

  /** R-7 percentile from a full sort: the definition the quickselect path must match. */
  function sortedPercentile(values: readonly number[], p: number): number {
    const sorted = values.toSorted((a, b) => a - b);
    const rank = (sorted.length - 1) * (p / 100);
    const lower = Math.floor(rank);
    const fraction = rank - lower;
    const low = sorted[lower]!;
    const result = fraction === 0 ? low : low + (sorted[lower + 1]! - low) * fraction;
    return result === 0 ? 0 : result;
  }

  it('percentile selects the same ranks as a full sort, duplicates and all', () => {
    for (let length = 1; length <= 60; length++) {
      const data = sample(length, length * 7919);
      for (const p of [0, 1, 10, 25, 50, 73.5, 90, 99, 100]) {
        expect(percentile(data, p)).toBe(sortedPercentile(data, p));
      }
    }
    const constant = Array.from({ length: 1000 }, () => 42.5);
    expect(percentile(constant, 90)).toBe(42.5);
    const ascending = Array.from({ length: 1000 }, (_, index) => index);
    expect(percentile(ascending, 90)).toBe(sortedPercentile(ascending, 90));
    expect(percentile(ascending.toReversed(), 90)).toBe(sortedPercentile(ascending, 90));
  });

  it('percentile reports the first bad element, wherever it is', () => {
    expect(() => percentile([1, 2, Number.NaN, 'x' as unknown as number], 50)).toThrow('values[2] must be finite');
    expect(() => percentile([1, 'x' as unknown as number, Number.NaN], 50)).toThrow('values[1] must be a number');
  });

  it('mean and sum agree on odd and even lengths and stay compensated', () => {
    expect(sum([1e100, 1, -1e100, 1])).toBe(2);
    expect(sum([1, 1e100, 1, -1e100, 1])).toBe(3);
    expect(mean([0.1, 0.2, 0.3])).toBeCloseTo(0.2, 15);
    // Sequential Neumaier summation: the paired fast path must be as accurate, on odd and even lengths.
    const neumaier = (values: readonly number[]): number => {
      let total = 0;
      let compensation = 0;
      for (const value of values) {
        const next = total + value;
        compensation += Math.abs(total) >= Math.abs(value) ? total - next + value : value - next + total;
        total = next;
      }
      return total + compensation;
    };
    for (let length = 1; length <= 40; length++) {
      const data = sample(length, length * 31).map((value, index) => value * 10 ** (index % 7) + 0.1);
      const expected = neumaier(data);
      expect(Math.abs(sum(data) - expected)).toBeLessThanOrEqual(Number.EPSILON * Math.abs(expected));
      expect(Math.abs(mean(data) - expected / length)).toBeLessThanOrEqual(
        Number.EPSILON * Math.abs(expected / length),
      );
    }
  });

  it('mean, sum and variance name a non-number before an earlier non-finite value', () => {
    expect(() => mean([Number.NaN, decimal(1)] as unknown as number[])).toThrow(/mixed number and Decimal/);
    expect(() => sum([Number.POSITIVE_INFINITY, 'x' as unknown as number])).toThrow('values[1] must be a number');
    expect(() => variance([1, 2, Number.NEGATIVE_INFINITY])).toThrow('values[2] must be finite');
    expect(() => mean([1, Number.NaN, 3])).toThrow('values[1] must be finite');
  });

  it('mean and sum still handle sums that overflow', () => {
    expect(mean([1.5e308, 1.5e308, -1e308])).toBeCloseTo(6.666_666_666_666_667e307, -293);
    expect(() => sum([1.5e308, 1.5e308])).toThrow(NumericRangeError);
  });

  it('variance matches the textbook formula on shifted data', () => {
    const data = sample(1001, 3).map(value => 1e9 + value);
    const average = data.reduce((total, value) => total + (value - 1e9), 0) / data.length;
    const expected = data.reduce((total, value) => total + (value - 1e9 - average) ** 2, 0) / data.length;
    expect(variance(data, { ddof: 0 })).toBeCloseTo(expected, 9);
    expect(stddev(data, { ddof: 0 })).toBeCloseTo(Math.sqrt(expected), 9);
  });
});

describe('zScore', () => {
  it('counts standard deviations from the mean', () => {
    expect(zScore(130, 100, 15)).toBe(2);
    expect(zScore(85, 100, 15)).toBe(-1);
  });
  it('rejects a non-positive spread, where the score is undefined', () => {
    expect(() => zScore(1, 0, 0)).toThrow(InvalidArgumentError);
    expect(() => zScore(1, 0, -1)).toThrow(InvalidArgumentError);
  });
});

describe('standardError', () => {
  it('is stddev / sqrt(n) for data (sample stddev by default)', () => {
    // [2,4,4,4,5,5,7,9]: population sd = 2, sample sd = sqrt(32/7)
    const data = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(standardError(data, { ddof: 0 })).toBeCloseTo(2 / Math.sqrt(8), 12);
    expect(standardError(data)).toBeCloseTo(Math.sqrt(32 / 7) / Math.sqrt(8), 12);
  });
  it('accepts a known stddev and n', () => {
    expect(standardError({ stddev: 10, n: 25 })).toBe(2);
  });
  it('rejects a bad count or too little data', () => {
    expect(() => standardError({ stddev: 1, n: 0 })).toThrow(InvalidArgumentError);
    expect(() => standardError([1])).toThrow(EmptyDataError);
  });
});

describe('marginOfError and confidenceInterval', () => {
  // Reference: z(0.975) = 1.959_963_984_540_054; t(0.975, df = 9) = 2.262_157_162_740_992 (R: qt(0.975, 9)).
  it('uses the exact z critical value', () => {
    expect(marginOfError({ stddev: 10, n: 100, method: 'z' })).toBeCloseTo(1.959_963_984_540_054, 9);
  });
  it('uses the exact t critical value by default', () => {
    expect(marginOfError({ stddev: 10, n: 10 })).toBeCloseTo((2.262_157_162_740_992 * 10) / Math.sqrt(10), 9);
  });
  it('builds an interval around the mean (R: t.test(1:10)$conf.int is 3.334149 7.665851)', () => {
    const ci = confidenceInterval([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(ci.mean).toBe(5.5);
    expect(ci.level).toBe(0.95);
    expect(ci.lower).toBeCloseTo(3.334_149, 6);
    expect(ci.upper).toBeCloseTo(7.665_851, 6);
    expect(ci.marginOfError).toBeCloseTo(2.165_851, 6);
  });
  it('is narrower with z than with t, and wider at higher levels', () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(confidenceInterval(data, { method: 'z' }).marginOfError).toBeLessThan(
      confidenceInterval(data).marginOfError,
    );
    expect(confidenceInterval(data, { level: 0.99 }).marginOfError).toBeGreaterThan(
      confidenceInterval(data).marginOfError,
    );
  });
  it('rejects bad levels, too little data and a t interval from one observation', () => {
    expect(() => confidenceInterval([1, 2, 3], { level: 1 })).toThrow(InvalidArgumentError);
    expect(() => confidenceInterval([1])).toThrow(EmptyDataError);
    expect(() => marginOfError({ stddev: 1, n: 1 })).toThrow(InvalidArgumentError);
    expect(marginOfError({ stddev: 1, n: 1, method: 'z' })).toBeCloseTo(1.959_963_984_540_054, 9);
  });
});

describe('sampleSize', () => {
  it('sizes a poll for a +-3% margin at 95% (the classic 1068)', () => {
    expect(sampleSize({ marginOfError: 0.03 })).toBe(1068);
  });
  it('sizes a mean: (z * sd / E)^2 rounded up', () => {
    // (1.959_963_984_540_054 * 15 / 2)^2 = 216.09 -> 217
    expect(sampleSize({ marginOfError: 2, stddev: 15 })).toBe(217);
  });
  it('uses the given proportion', () => {
    // 1.959964^2 * 0.2 * 0.8 / 0.05^2 = 245.86 -> 246
    expect(sampleSize({ marginOfError: 0.05, proportion: 0.2 })).toBe(246);
  });
  it('does not round an exact integer up', () => {
    // z = 1 would need level 0.6826894921370859; use sd = E / z * 10 style: E = 1.959_963_984_540_054, sd = 1 -> n = 1
    expect(sampleSize({ marginOfError: 1.959_963_984_540_054, stddev: 1 })).toBe(1);
  });
  it('rejects a non-positive margin or both spreads', () => {
    expect(() => sampleSize({ marginOfError: 0 })).toThrow(InvalidArgumentError);
    expect(() => sampleSize({ marginOfError: 0.1, proportion: 2 })).toThrow(InvalidArgumentError);
  });
});

describe('exponentialRegression', () => {
  it('recovers y = 2 e^(0.5 x) exactly', () => {
    const xs = [0, 1, 2, 3, 4];
    const fit = exponentialRegression(
      xs,
      xs.map(v => 2 * Math.exp(0.5 * v)),
    );
    expect(fit.a).toBeCloseTo(2, 10);
    expect(fit.b).toBeCloseTo(0.5, 10);
    expect(fit.r2).toBeCloseTo(1, 10);
    expect(fit.predict(5)).toBeCloseTo(2 * Math.exp(2.5), 8);
  });
  it('matches the log-linear least squares on noisy data (NumPy polyfit(x, log(y), 1))', () => {
    // x = 1..4, y = 2, 5, 11, 30: ln y = .6931, 1.6094, 2.3979, 3.4012 -> slope 0.8913, intercept -0.2029 (hand-checked)
    const fit = exponentialRegression([1, 2, 3, 4], [2, 5, 11, 30]);
    expect(fit.b).toBeCloseTo(0.8913, 3);
    expect(Math.log(fit.a)).toBeCloseTo(-0.2029, 3);
    expect(fit.r2).toBeGreaterThan(0.95);
    expect(fit.r2).toBeLessThanOrEqual(1);
  });
  it('rejects non-positive y, where ln is undefined', () => {
    expect(() => exponentialRegression([1, 2, 3], [1, 0, 2])).toThrow(InvalidArgumentError);
  });
});

describe('logarithmicRegression', () => {
  it('recovers y = 1 + 2 ln x', () => {
    const xs = [1, 2, 4, 8];
    const fit = logarithmicRegression(
      xs,
      xs.map(v => 1 + 2 * Math.log(v)),
    );
    expect(fit.a).toBeCloseTo(1, 10);
    expect(fit.b).toBeCloseTo(2, 10);
    expect(fit.r2).toBeCloseTo(1, 10);
    expect(fit.predict(16)).toBeCloseTo(1 + 2 * Math.log(16), 10);
  });
  it('rejects non-positive x in the data and in predict', () => {
    expect(() => logarithmicRegression([0, 1, 2], [1, 2, 3])).toThrow(InvalidArgumentError);
    expect(() => logarithmicRegression([1, 2, 3], [1, 2, 3]).predict(0)).toThrow(InvalidArgumentError);
  });
});

describe('powerRegression', () => {
  it('recovers y = 3 x^2', () => {
    const xs = [1, 2, 3, 4, 5];
    const fit = powerRegression(
      xs,
      xs.map(v => 3 * v * v),
    );
    expect(fit.a).toBeCloseTo(3, 10);
    expect(fit.b).toBeCloseTo(2, 10);
    expect(fit.r2).toBeCloseTo(1, 10);
    expect(fit.predict(10)).toBeCloseTo(300, 7);
  });
  it('rejects non-positive x or y', () => {
    expect(() => powerRegression([1, 2, 3], [1, -2, 3])).toThrow(InvalidArgumentError);
    expect(() => powerRegression([0, 2, 3], [1, 2, 3])).toThrow(InvalidArgumentError);
  });
});

describe('polynomialRegression', () => {
  const relativeError = (actual: number, expected: number): number => Math.abs(actual - expected) / Math.abs(expected);
  it('recovers an exact quadratic, lowest degree first', () => {
    const xs = [-2, -1, 0, 1, 2, 3];
    const fit = polynomialRegression(
      xs,
      xs.map(v => 1 - 2 * v + 0.5 * v * v),
      2,
    );
    expect(fit.coefficients[0]).toBeCloseTo(1, 10);
    expect(fit.coefficients[1]).toBeCloseTo(-2, 10);
    expect(fit.coefficients[2]).toBeCloseTo(0.5, 10);
    expect(fit.r2).toBeCloseTo(1, 10);
    expect(fit.predict(4)).toBeCloseTo(1 - 8 + 8, 9);
  });
  it('degree 1 agrees with linearRegression', () => {
    const x = [1, 2, 3, 4, 5];
    const y = [2, 1, 4, 3, 5];
    const fit = polynomialRegression(x, y, 1);
    expect(fit.coefficients[0]).toBeCloseTo(0.6, 12);
    expect(fit.coefficients[1]).toBeCloseTo(0.8, 12);
    // r2 of the line = correlation^2: sxy^2 / (sxx * syy) = 64 / (10 * 10)
    expect(fit.r2).toBeCloseTo(0.64, 12);
  });
  it('fits a cubic on large x without losing the leading terms', () => {
    const xs = [100, 200, 300, 400, 500, 600];
    const fit = polynomialRegression(
      xs,
      xs.map(v => 5 + 0.1 * v - 1e-4 * v ** 3),
      3,
    );
    expect(fit.coefficients[3]).toBeCloseTo(-1e-4, 12);
    expect(fit.predict(350)).toBeCloseTo(5 + 35 - 1e-4 * 350 ** 3, 4);
  });
  it('rejects insufficient distinct x and bad degrees', () => {
    expect(() => polynomialRegression([1, 1, 2], [1, 2, 3], 2)).toThrow(InvalidArgumentError);
    expect(() => polynomialRegression([1, 2, 3], [1, 2, 3], 1.5)).toThrow(InvalidArgumentError);
    expect(() => polynomialRegression([1, 2, 3], [1, 2, 3], -1)).toThrow(InvalidArgumentError);
  });
  it('fits a cubic on calendar years, where uncentered x is ill-conditioned', () => {
    // y = 0.01 (x - 2015)(x - 2020)(x - 2024) + 100. Raw powers of x ~ 2000 make the
    // uncentered normal equations numerically singular; centered and scaled x does not.
    const years = Array.from({ length: 10 }, (_, i) => 2015 + i);
    const cubic = (v: number): number => 0.01 * (v - 2015) * (v - 2020) * (v - 2024) + 100;
    const fit = polynomialRegression(
      years,
      years.map(v => cubic(v)),
      3,
    );
    // Expanded: 0.01x³ - 60.59x² + 122_371.4x - 82_382_872 (+ 100).
    const expected = [-82_382_872 + 100, 122_371.4, -60.59, 0.01];
    for (const [k, c] of expected.entries()) expect(relativeError(fit.coefficients[k]!, c)).toBeLessThan(1e-11);
    for (const at of [2015, 2017.5, 2020, 2024, 2026, 2030]) {
      expect(relativeError(fit.predict(at), cubic(at))).toBeLessThan(1e-12);
    }
    expect(fit.r2).toBeCloseTo(1, 12);
  });
  it('predicts in the centered basis, even where the expanded coefficients are sensitive', () => {
    // A degree-5 fit of the same cubic: the zero x^4, x^5 terms make the expanded
    // coefficients sensitive, but predict never goes through them.
    const years = Array.from({ length: 10 }, (_, i) => 2015 + i);
    const cubic = (v: number): number => 0.01 * (v - 2015) * (v - 2020) * (v - 2024) + 100;
    const fit = polynomialRegression(
      years,
      years.map(v => cubic(v)),
      5,
    );
    for (const at of [2015, 2019.5, 2024, 2026]) {
      expect(relativeError(fit.predict(at), cubic(at))).toBeLessThan(1e-9);
    }
  });
  it('reports a numerically singular system as a typed error', () => {
    const xs = Array.from({ length: 30 }, (_, i) => i + 1);
    expect(() => polynomialRegression(xs, xs, 25)).toThrow(NumericRangeError);
  });
});

describe('quantile methods (Hyndman & Fan R-1 to R-9)', () => {
  // x = 1..10 makes the quantile equal its 1-based position. Expected values are
  // hand-derived from Hyndman & Fan's definitions (the same as R's
  // quantile(1:10, q, type = k)); e.g. q = 0.25: R-1 ceil(2.5) = 3, R-3 nearest
  // even order statistic to 2 = 2, R-6 (n + 1)q = 2.75 (Excel PERCENTILE.EXC),
  // R-7 1 + (n - 1)q = 3.25 (Excel PERCENTILE.INC), R-8 (n + 1/3)q + 1/3, R-9 (n + 1/4)q + 3/8.
  const data = [7, 3, 10, 1, 9, 2, 8, 6, 5, 4];
  const expected: Record<QuantileMethod, readonly [number, number, number, number]> = {
    //                       q = 0.05, 0.25, 0.5, 0.9
    inverseCdf: [1, 3, 5, 9],
    averagedInverseCdf: [1, 3, 5.5, 9.5],
    closestObservation: [1, 2, 5, 9],
    interpolatedInverseCdf: [1, 2.5, 5, 9],
    hazen: [1, 3, 5.5, 9.5],
    weibull: [1, 2.75, 5.5, 9.9],
    linear: [1.45, 3.25, 5.5, 9.1],
    medianUnbiased: [1, 2 + 11 / 12, 5.5, 9 + 19 / 30],
    normalUnbiased: [1, 2.9375, 5.5, 9.6],
  };
  it.each(QUANTILE_METHODS)('%s matches the definition at q = 0.05, 0.25, 0.5, 0.9', method => {
    const got = [0.05, 0.25, 0.5, 0.9].map(q => quantile(data, q, { method }));
    const want = expected[method];
    for (const [i, value] of got.entries()) expect(value).toBeCloseTo(want[i]!, 12);
  });
  it('every method returns the minimum at q = 0 and the maximum at q = 1', () => {
    for (const method of QUANTILE_METHODS) {
      expect(quantile(data, 0, { method })).toBe(1);
      expect(quantile(data, 1, { method })).toBe(10);
    }
  });
  it('R-3 breaks a tie toward the even order statistic', () => {
    // nq - 1/2 = 3 (odd) picks x_4; at q = 0.25 it is 2 (even) and picks x_2.
    expect(quantile(data, 0.35, { method: 'closestObservation' })).toBe(4);
    expect(quantile(data, 0.25, { method: 'closestObservation' })).toBe(2);
  });
  it('a position that is whole up to rounding counts as whole', () => {
    // 10 * 0.3 is 3.0000000000000004 in floats; the nearest-rank answer is still x_3.
    expect(quantile(data, 0.3, { method: 'inverseCdf' })).toBe(3);
    expect(quantile(data, 0.3, { method: 'averagedInverseCdf' })).toBe(3.5);
  });
  it('percentile takes the same methods', () => {
    for (const method of QUANTILE_METHODS) {
      expect(percentile(data, 37, { method })).toBe(quantile(data, 0.37, { method }));
    }
  });
  it('rejects an unknown method', () => {
    expect(() => quantile(data, 0.5, { method: 'excel' as QuantileMethod })).toThrow(InvalidArgumentError);
  });
});

describe('quartiles', () => {
  it('uses R-7 by default, like quantile', () => {
    expect(quartiles([7, 3, 10, 1, 9, 2, 8, 6, 5, 4])).toEqual({ q1: 3.25, q2: 5.5, q3: 7.75 });
  });
  it('weibull gives Excel QUARTILE.EXC', () => {
    expect(quartiles([7, 3, 10, 1, 9, 2, 8, 6, 5, 4], { method: 'weibull' })).toEqual({ q1: 2.75, q2: 5.5, q3: 8.25 });
  });
  it("'tukey' gives the box-plot hinges of R fivenum", () => {
    // fivenum(1:10) = 1, 3, 5.5, 8, 10; fivenum(1:9) = 1, 3, 5, 7, 9; fivenum(1:8) = 1, 2.5, 4.5, 6.5, 8;
    // fivenum(1:7) = 1, 2.5, 4, 5.5, 7 (odd n: the median belongs to both halves).
    expect(quartiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { method: 'tukey' })).toEqual({ q1: 3, q2: 5.5, q3: 8 });
    expect(quartiles([9, 1, 8, 2, 7, 3, 6, 4, 5], { method: 'tukey' })).toEqual({ q1: 3, q2: 5, q3: 7 });
    expect(quartiles([1, 2, 3, 4, 5, 6, 7, 8], { method: 'tukey' })).toEqual({ q1: 2.5, q2: 4.5, q3: 6.5 });
    expect(quartiles([1, 2, 3, 4, 5, 6, 7], { method: 'tukey' })).toEqual({ q1: 2.5, q2: 4, q3: 5.5 });
    expect(quartiles([4], { method: 'tukey' })).toEqual({ q1: 4, q2: 4, q3: 4 });
  });
  it("'medianExcluded' leaves the odd middle value out of both halves (TI-83, Wikipedia Method 1)", () => {
    // Wikipedia "Quartile", example 1: Method 1 gives Q1 = 15, Q3 = 43; Method 2 gives 25.5, 42.5.
    const data = [6, 7, 15, 36, 39, 40, 41, 42, 43, 47, 49];
    expect(quartiles(data, { method: 'medianExcluded' })).toEqual({ q1: 15, q2: 40, q3: 43 });
    expect(quartiles(data, { method: 'tukey' })).toEqual({ q1: 25.5, q2: 40, q3: 42.5 });
    // Example 2 has an even count, so both rules split it the same way: Q1 = 15, Q3 = 40.
    const even = [7, 15, 36, 39, 40, 41];
    expect(quartiles(even, { method: 'medianExcluded' })).toEqual({ q1: 15, q2: 37.5, q3: 40 });
    expect(quartiles(even, { method: 'tukey' })).toEqual({ q1: 15, q2: 37.5, q3: 40 });
    expect(quartiles([1, 2, 3, 4, 5, 6, 7], { method: 'medianExcluded' })).toEqual({ q1: 2, q2: 4, q3: 6 });
    expect(quartiles([3, 1, 2], { method: 'medianExcluded' })).toEqual({ q1: 1, q2: 2, q3: 3 });
    expect(quartiles([4], { method: 'medianExcluded' })).toEqual({ q1: 4, q2: 4, q3: 4 });
  });
  it('rejects empty data and unknown methods', () => {
    expect(() => quartiles([])).toThrow(EmptyDataError);
    expect(() => quartiles([], { method: 'medianExcluded' })).toThrow(EmptyDataError);
    expect(() => quartiles([1, 2], { method: 'hinge' as QuantileMethod })).toThrow(InvalidArgumentError);
  });
});

describe('percentileRank', () => {
  // SciPy docs: percentileofscore([1, 2, 3, 3, 4], 3, kind) = 70 (rank), 80 (weak), 40 (strict), 60 (mean).
  it('matches scipy percentileofscore for every kind', () => {
    const data = [1, 2, 3, 3, 4];
    expect(percentileRank(data, 3, { kind: 'rank' })).toBeCloseTo(70, 12);
    expect(percentileRank(data, 3, { kind: 'weak' })).toBeCloseTo(80, 12);
    expect(percentileRank(data, 3, { kind: 'strict' })).toBeCloseTo(40, 12);
    expect(percentileRank(data, 3, { kind: 'mean' })).toBeCloseTo(60, 12);
    // percentileofscore([1, 2, 3, 4], 3) = 75 (rank); 'mean' is 62.5.
    expect(percentileRank([1, 2, 3, 4], 3, { kind: 'rank' })).toBe(75);
    expect(percentileRank([1, 2, 3, 4], 3)).toBe(62.5);
  });
  it('defaults to mean: the median of distinct values ranks 50', () => {
    expect(percentileRank([5, 1, 3], 3)).toBe(50);
  });
  it('ranks scores between and beyond the values', () => {
    for (const kind of ['strict', 'weak', 'mean', 'rank'] as const) {
      expect(percentileRank([1, 2, 3, 4], 2.5, { kind })).toBe(50);
      expect(percentileRank([1, 2, 3, 4], 0, { kind })).toBe(0);
      expect(percentileRank([1, 2, 3, 4], 9, { kind })).toBe(100);
    }
  });
  it('rejects empty data, a bad score and an unknown kind', () => {
    expect(() => percentileRank([], 1)).toThrow(EmptyDataError);
    expect(() => percentileRank([1], Number.NaN)).toThrow(InvalidArgumentError);
    expect(() => percentileRank([1], 1, { kind: 'average' as 'mean' })).toThrow(InvalidArgumentError);
  });
});

describe('pooledVariance and pooledStddev', () => {
  // [2, 4, 6]: s^2 = 4 (SS 8); [1, 3]: s^2 = 2 (SS 2). Pooled: (2 * 4 + 1 * 2) / (2 + 1) = 10 / 3.
  const groups = [
    [2, 4, 6],
    [1, 3],
  ];
  it('weights each group variance by its degrees of freedom', () => {
    expect(pooledVariance(groups)).toBeCloseTo(10 / 3, 12);
    expect(pooledStddev(groups)).toBeCloseTo(Math.sqrt(10 / 3), 12);
  });
  it('ddof 0 divides the within-group sum of squares by N', () => {
    expect(pooledVariance(groups, { ddof: 0 })).toBeCloseTo(2, 12);
  });
  it('equals the plain variance for one group', () => {
    expect(pooledVariance([[2, 4, 4, 4, 5, 5, 7, 9]])).toBeCloseTo(32 / 7, 12);
  });
  it('lets a single-value group add nothing', () => {
    expect(pooledVariance([[2, 4, 6], [100]])).toBeCloseTo(4, 12);
  });
  it('accepts summaries ({ n, stddev } or { n, variance }) equal to the raw groups', () => {
    // [2, 4, 6]: n 3, s^2 4; [1, 3]: n 2, s^2 2 (sample variances, ddof 1).
    const summaries = [
      { n: 3, variance: 4 },
      { n: 2, stddev: Math.sqrt(2) },
    ];
    expect(pooledVariance(summaries)).toBeCloseTo(pooledVariance(groups), 12);
    expect(pooledVariance(summaries, { ddof: 0 })).toBeCloseTo(pooledVariance(groups, { ddof: 0 }), 12);
    expect(pooledStddev(summaries)).toBeCloseTo(pooledStddev(groups), 12);
    // Raw and summary groups mix; a summary of one value adds nothing.
    expect(pooledVariance([[2, 4, 6], { n: 2, variance: 2 }])).toBeCloseTo(10 / 3, 12);
    expect(
      pooledVariance([
        { n: 3, stddev: 2 },
        { n: 1, stddev: 0 },
      ]),
    ).toBeCloseTo(4, 12);
  });
  it('rejects malformed summaries', () => {
    expect(() => pooledVariance([{ n: 0, stddev: 1 }])).toThrow(InvalidArgumentError);
    expect(() => pooledVariance([{ n: 2.5, stddev: 1 }])).toThrow(InvalidArgumentError);
    expect(() => pooledVariance([{ n: 3, stddev: -1 }])).toThrow(InvalidArgumentError);
    expect(() => pooledVariance([{ n: 3, variance: Number.NaN }])).toThrow(InvalidArgumentError);
    expect(() => pooledVariance([{ n: 3 } as { n: number; stddev: number }])).toThrow(InvalidArgumentError);
    const both = { n: 3, stddev: 2, variance: 4 } as { n: number; stddev: number };
    expect(() => pooledVariance([both])).toThrow(InvalidArgumentError);
    expect(() =>
      pooledVariance([
        { n: 1, stddev: 1 },
        { n: 1, variance: 1 },
      ]),
    ).toThrow(EmptyDataError);
  });
  it('rejects no groups, empty groups and no degrees of freedom', () => {
    expect(() => pooledVariance([])).toThrow(EmptyDataError);
    expect(() => pooledVariance([[1, 2], []])).toThrow(EmptyDataError);
    expect(() => pooledVariance([[1], [2]])).toThrow(EmptyDataError);
    expect(() => pooledVariance([[1, Number.NaN]])).toThrow(InvalidArgumentError);
  });
});

describe('regression diagnostics', () => {
  // x = 1..5, y = 2, 4, 5, 4, 5: slope 0.6, intercept 2.2, SSres 2.4, SStot 6, Sxx 10, n - 2 = 3.
  // R summary(lm(y ~ x)): residual standard error sqrt(0.8) on 3 df, R^2 0.6, adjusted R^2 0.4667,
  // Std. Error slope sqrt(0.8 / 10), intercept sqrt(0.8 * (1/5 + 3^2/10)).
  it('linearRegression reports adjusted r2 and standard errors on n - 2 df', () => {
    const fit = linearRegression([1, 2, 3, 4, 5], [2, 4, 5, 4, 5]);
    expect(fit.r2).toBeCloseTo(0.6, 12);
    expect(fit.adjustedR2).toBeCloseTo(1 - (0.4 * 4) / 3, 12);
    expect(fit.residualStandardError).toBeCloseTo(Math.sqrt(0.8), 12);
    expect(fit.slopeStandardError).toBeCloseTo(Math.sqrt(0.08), 12);
    expect(fit.interceptStandardError).toBeCloseTo(Math.sqrt(0.88), 12);
  });
  it('leaves them undefined for two points, where no residual freedom is left', () => {
    const fit = linearRegression([1, 2], [3, 5]);
    expect([fit.adjustedR2, fit.residualStandardError, fit.slopeStandardError, fit.interceptStandardError]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
  it('a perfect line has zero standard errors', () => {
    const fit = linearRegression([0, 1, 2, 3], [1, 3, 5, 7]);
    expect(fit.residualStandardError).toBeCloseTo(0, 12);
    expect(fit.adjustedR2).toBeCloseTo(1, 12);
  });
  it('polynomialRegression uses n - degree - 1 df', () => {
    // x = -2..2 is symmetric, so 1, x and x^2 - 2 are orthogonal: b = sum(x y) / 10 = -0.05,
    // c = sum((x^2 - 2) y) / 14 = 13.9 / 14. SStot = 13.94; SSres = 13.94 - 10 b^2 - 14 c^2; df = 2.
    const fit = polynomialRegression([-2, -1, 0, 1, 2], [4.2, 0.8, 0.1, 1.1, 3.8], 2);
    const residual = 13.94 - 10 * 0.05 ** 2 - (13.9 * 13.9) / 14;
    expect(fit.r2).toBeCloseTo(1 - residual / 13.94, 12);
    expect(fit.adjustedR2).toBeCloseTo(1 - (residual / 13.94) * (4 / 2), 12);
    expect(fit.residualStandardError).toBeCloseTo(Math.sqrt(residual / 2), 12);
  });
  it('polynomialRegression of degree 1 has the same diagnostics as linearRegression', () => {
    const x = [1, 2, 3, 4, 5];
    const y = [2, 4, 5, 4, 5];
    const line = linearRegression(x, y);
    const poly = polynomialRegression(x, y, 1);
    expect(poly.adjustedR2).toBeCloseTo(line.adjustedR2!, 12);
    expect(poly.residualStandardError).toBeCloseTo(line.residualStandardError!, 12);
  });
  it('polynomialRegression through exactly degree + 1 points has no diagnostics', () => {
    const fit = polynomialRegression([0, 1, 2], [1, 2, 5], 2);
    expect(fit.adjustedR2).toBeUndefined();
    expect(fit.residualStandardError).toBeUndefined();
  });
  // The diagnostics are measured on first read, later than the call. A caller who
  // reuses or sorts its arrays in between must still get the fit of the data it passed.
  it('measures the diagnostics on the data as passed, even if the caller changes its arrays first', () => {
    const x = [1, 2, 3, 4, 5, 6];
    const y = [2.1, 3.9, 6.2, 7.8, 10.1, 12.2];
    const fits = () => ({
      line: linearRegression([...x], [...y]),
      poly: polynomialRegression([...x], [...y], 2),
      exp: exponentialRegression([...x], [...y]),
      log: logarithmicRegression([...x], [...y]),
      pow: powerRegression([...x], [...y]),
    });
    const expected = fits();
    const late = {
      line: linearRegression(x, y),
      poly: polynomialRegression(x, y, 2),
      exp: exponentialRegression(x, y),
      log: logarithmicRegression(x, y),
      pow: powerRegression(x, y),
    };
    x.reverse();
    y.fill(1);
    for (const kind of ['line', 'poly', 'exp', 'log', 'pow'] as const) expect(late[kind].r2).toBe(expected[kind].r2);
    for (const kind of ['line', 'poly'] as const) {
      expect(late[kind].adjustedR2).toBe(expected[kind].adjustedR2);
      expect(late[kind].residualStandardError).toBe(expected[kind].residualStandardError);
    }
    expect(late.line.slopeStandardError).toBe(expected.line.slopeStandardError);
    expect(late.line.interceptStandardError).toBe(expected.line.interceptStandardError);
  });
  // Lazy getters must not hide the numbers from code that serialises, logs or copies a fit.
  it('shows lazily measured diagnostics to JSON.stringify, spread and toEqual as plain values', () => {
    const fit = polynomialRegression([-2, -1, 0, 1, 2], [4.2, 0.8, 0.1, 1.1, 3.8], 2);
    expect(Object.keys(fit)).toEqual(['coefficients', 'r2', 'adjustedR2', 'residualStandardError', 'predict']);
    const values = {
      coefficients: fit.coefficients,
      r2: fit.r2,
      adjustedR2: fit.adjustedR2,
      residualStandardError: fit.residualStandardError,
    };
    expect(JSON.stringify(fit)).toBe(JSON.stringify(values));
    const copy = { ...fit };
    expect(copy).toEqual({ ...values, predict: expect.any(Function) });
    expect(Object.getOwnPropertyDescriptor(copy, 'r2')).toMatchObject({ value: fit.r2, writable: true });
    expect(copy.predict(3)).toBe(fit.predict(3));
    expect(fit).toEqual({ ...values, predict: expect.any(Function) });
    for (const curve of [
      exponentialRegression([1, 2, 3], [2, 5, 11]),
      logarithmicRegression([1, 2, 3], [1, 2.4, 3.1]),
      powerRegression([1, 2, 3], [3, 12, 27]),
    ]) {
      expect(JSON.stringify(curve)).toBe(JSON.stringify({ a: curve.a, b: curve.b, r2: curve.r2 }));
    }
  });
});
