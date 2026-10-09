import { describe, expect, it } from 'vitest';

import { EmptyDataError, InvalidArgumentError } from './errors.js';
import {
  correlation,
  linearRegression,
  mean,
  median,
  minMax,
  mode,
  percentile,
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
