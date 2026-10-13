import { describe, expect, it } from 'vitest';

import type { VarianceOptions } from './stats.js';
import { Decimal, decimal } from './decimal.js';
import { EmptyDataError, InvalidArgumentError, NumericRangeError, RoundingNecessaryError } from './errors.js';
import {
  correlation,
  linearRegression,
  mean,
  median,
  minMax,
  mode,
  percentile,
  quantile,
  stddev,
  sum,
  variance,
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
    expect(linearRegression([1, 2, 3], [4, 4, 4])).toEqual({ slope: 0, intercept: 4 });
  });
  it('rejects constant x, mismatched lengths and too few points', () => {
    expect(() => linearRegression([2, 2, 2], [1, 2, 3])).toThrow(InvalidArgumentError);
    expect(() => linearRegression([1, 2], [1])).toThrow(InvalidArgumentError);
    expect(() => linearRegression([1], [1])).toThrow(InvalidArgumentError);
  });
  it('rejects non-finite values', () => {
    expect(() => linearRegression([1, 2], [1, Infinity])).toThrow(InvalidArgumentError);
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
