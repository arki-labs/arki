// Speed of @arki/math against the number libraries most projects use.
// Run: `bun run bench` (explore) or `bun run bench --profile publish --write-readme`.
//
// Every `compare` group states a contract and is checked before timing: each
// ranked library must return the same normalized value for every input,
// including the boundary inputs listed. Libraries that keep a different
// promise are marked `differs` and shown without a ratio.

// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- loads the local module declaration for an untyped competitor
/// <reference path="./jstat.d.ts" />
// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- loads the local module declaration for an untyped competitor
/// <reference path="./regression.d.ts" />

/* eslint-disable unicorn/require-number-to-fixed-digits-argument -- these are decimal.js / big.js / bignumber.js `toFixed()`: with no argument they print every digit in plain notation (unlike Number#toFixed), which the contracts rely on */
import Big from 'big.js';
import BigNumber from 'bignumber.js';
import { Complex as ComplexJs } from 'complex.js';
import { Decimal } from 'decimal.js';
import Fraction from 'fraction.js';
import jStat from 'jstat';
import {
  det,
  eigs,
  inv,
  lusolve,
  complex as mathComplex,
  divide as mathDivide,
  multiply as mathMultiply,
  pow as mathPow,
  sqrt as mathSqrt,
  polynomialRoot,
} from 'mathjs';
import {
  EigenvalueDecomposition,
  Matrix,
  determinant as mlDeterminant,
  inverse as mlInverse,
  solve as mlSolve,
} from 'ml-matrix';
import regression from 'regression';
import * as ss from 'simple-statistics';

import { compare, defineSuite, scenario } from '@arki/bench';
import { complex } from '@arki/math/complex';
import { decimal } from '@arki/math/decimal';
import { normal, studentT } from '@arki/math/distributions';
import {
  determinant,
  eigenDecompose,
  inverse,
  multiply,
  solve,
  symmetricEigenDecompose,
} from '@arki/math/linear-algebra';
import { cubicRoots } from '@arki/math/polynomial';
import { createRandom } from '@arki/math/random';
import { ratio } from '@arki/math/rational';
import {
  exponentialRegression,
  linearRegression,
  mean,
  percentile,
  polynomialRegression,
  powerRegression,
  stddev,
} from '@arki/math/stats';

const SCALE = 10;
const SCALE_OPTIONS = { scale: SCALE, rounding: 'halfEven' } as const;

// Configured so every competitor keeps the same promise as @arki/math:
// decimal.js gets 100 significant digits (exact for every add/multiply below) and
// half-even rounding; big.js and bignumber.js round divisions once, at 10 places, half-even.
const Dec = Decimal.clone({ precision: 100, rounding: Decimal.ROUND_HALF_EVEN });
const Big10 = Big();
Big10.DP = SCALE;
Big10.RM = Big.roundHalfEven;
const BN10 = BigNumber.clone({ DECIMAL_PLACES: SCALE, ROUNDING_MODE: BigNumber.ROUND_HALF_EVEN });

/** Plain decimal text without trailing fraction zeros, and `0` for any zero. */
function plain(text: string): string {
  const trimmed = text.includes('.') ? text.replace(/0+$/u, '').replace(/\.$/u, '') : text;
  return /^-?0$/u.test(trimmed) ? '0' : trimmed;
}

/** Rounds to `digits` significant digits; magnitudes below 1e-12 count as 0. */
const significant =
  (digits: number) =>
  (value: number): string =>
    Math.abs(value) < 1e-12 ? '0' : value.toPrecision(digits);
const sig12 = significant(12);
const sig9 = significant(9);

type Pair = { a: string; b: string };
type Fractions = { a: readonly [bigint, bigint]; b: readonly [bigint, bigint] };

const LONG = '123456789012345678901234567890.123456789';

const sumPairs: readonly Pair[] = [
  { a: '1234.5678', b: '98.76' },
  { a: '0.1', b: '0.2' },
  { a: '-0.001', b: '0.001' },
  { a: '-98.76', b: '12.5' },
  { a: '99999999999999999999', b: '1' },
  { a: LONG, b: '0.000000001' },
  { a: '0', b: '0' },
];

const productPairs: readonly Pair[] = [
  { a: '1234.5678', b: '98.76' },
  { a: '0.1', b: '0.2' },
  { a: '-12.5', b: '0.08' },
  { a: LONG, b: '7.25' },
  { a: '0.000001', b: '-0.000001' },
  { a: '0', b: '98.76' },
];

const divisionPairs: readonly Pair[] = [
  { a: '1234.5678', b: '98.76' },
  { a: '1', b: '3' },
  { a: '-2', b: '3' },
  // Exact ties at the 11th place: half-even gives ...2 and ...4, half-up would give ...3 and ...4.
  { a: '0.00000000025', b: '1' },
  { a: '0.0000000007', b: '2' },
  { a: '-0.00000000025', b: '1' },
  { a: LONG, b: '7' },
  { a: '0', b: '5' },
];

const fractionPairs: readonly Fractions[] = [
  { a: [355n, 113n], b: [22n, 7n] },
  { a: [1n, 3n], b: [1n, 6n] },
  { a: [-1n, 2n], b: [1n, 2n] },
  { a: [-7n, 4n], b: [2n, 3n] },
  { a: [9_007_199_254_740_993n, 3n], b: [1n, 9_007_199_254_740_997n] },
  { a: [0n, 1n], b: [5n, 9n] },
];

/** Deterministic pseudo-random sequence (LCG), so the data is the same in every process. */
function seeded(count: number, seed: number): number[] {
  let state = seed;
  return Array.from({ length: count }, () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  });
}

// Five data sets of 1,000 numbers each, so every row in a statistics table does the same amount of work.
const datasets: readonly (readonly number[])[] = [
  Array.from({ length: 1000 }, (_, index) => Math.sin(index) * 1000),
  seeded(1000, 7).map(value => 1e9 + (value - 0.5) * 1e6),
  Array.from({ length: 1000 }, (_, index) => -(index % 97) - 0.5),
  Array.from({ length: 1000 }, () => 42.5),
  seeded(1000, 99).map(value => Math.round(value * 1e6) / 100),
];

const fraction = ([numerator, denominator]: readonly [bigint, bigint]): Fraction =>
  new Fraction(numerator, denominator);
const fractionText = (value: Fraction): string => `${value.s * value.n}/${value.d}`;
const ratioText = (value: { numerator: bigint; denominator: bigint }): string =>
  `${value.numerator}/${value.denominator}`;

// ---- Regression, linear algebra, complex numbers and polynomials ----

type Series = { x: number[]; y: number[] };

/** Two data sets of 1,000 points: x uniform in [0.5, 10), y = `curve(x, standard normal noise)`. Seeded, so identical for every library. */
function series(seed: number, curve: (x: number, noise: number) => number): Series[] {
  return [seed * 100, seed * 100 + 1].map(state => {
    const random = createRandom(state);
    const x = Array.from({ length: 1000 }, () => random.float(0.5, 10));
    return { x, y: x.map(value => curve(value, random.gaussian())) };
  });
}

const points = (x: readonly number[], y: readonly number[]): [number, number][] =>
  x.map((value, index): [number, number] => [value, y[index] ?? 0]);

// regression-js rounds its output to 2 decimals unless told otherwise.
const REGRESSION_OPTIONS = { precision: 15 } as const;

type MatrixPair = { a: number[][]; b: number[][] };

/** Three seeded pairs of n×n matrices with entries in [-1, 1); `a` also gets +n on its diagonal, which keeps it well-conditioned for solve, determinant and inverse. */
function matrixPairs(n: number): MatrixPair[] {
  return [11, 22, 33].map(seed => {
    const random = createRandom(seed + n);
    const fill = (): number[][] =>
      Array.from({ length: n }, () => Array.from({ length: n }, () => random.float(-1, 1)));
    const a = fill().map((row, index) => row.map((value, column) => (index === column ? value + n : value)));
    return { a, b: fill() };
  });
}

/** Numbers to 9 significant digits, comma-separated. */
const list = (values: readonly number[]): string => values.map(value => sig9(value)).join(',');

/** Every number inside nested arrays, in row order. */
function flatNumbers(value: unknown): number[] {
  if (typeof value === 'number') return [value];
  if (Array.isArray(value)) return value.flatMap(item => flatNumbers(item));
  throw new TypeError('expected numbers or arrays of numbers');
}

const matrixText = (matrix: readonly (readonly number[])[]): string => matrix.map(row => list(row)).join(';');

type Square = { a: number[][] };

/** The three diagonally dominant 20×20 matrices of `matrixPairs(20)`, for the general eigen group. */
const generalSquares: Square[] = matrixPairs(20).map(({ a }) => ({ a }));

/** Their symmetric parts (A + Aᵀ)/2, exactly symmetric, for the symmetric eigen group. */
const symmetricSquares: Square[] = generalSquares.map(({ a }) => ({
  a: a.map((row, i) => row.map((value, j) => (value + (a[j]?.[i] ?? 0)) / 2)),
}));

/** Real eigenvalues sorted ascending, each to 9 significant digits. */
const sortedText = (values: readonly number[]): string => list(values.toSorted((p, q) => p - q));

type ComplexPair = { a: readonly [number, number]; b: readonly [number, number] };

const complexPairs: readonly ComplexPair[] = [
  { a: [3, 4], b: [1, -2] },
  { a: [-2.5, 0.5], b: [0.75, 3] },
  { a: [0.1, -7], b: [2, 0.001] },
  { a: [5, 0], b: [0, 1] },
  { a: [-4, 0], b: [1.5, -0.5] },
  { a: [1000, -2000], b: [3, 4] },
];

/** Real and imaginary part of a complex number from any of the three libraries, to 9 significant digits. */
function parts(value: unknown): string {
  if (typeof value === 'object' && value !== null && 're' in value && 'im' in value) {
    const { re, im } = value;
    if (typeof re === 'number' && typeof im === 'number') return `${sig9(re)},${sig9(im)}`;
  }
  throw new TypeError('not a complex number');
}

/** Roots sorted by real part, then imaginary part, each to 9 significant digits. */
const rootsText = (roots: readonly { re: number; im: number }[]): string =>
  roots
    .map(({ re, im }) => ({ re: sig9(re), im: sig9(im) }))
    .toSorted((p, q) => Number(p.re) - Number(q.re) || Number(p.im) - Number(q.im))
    .map(({ re, im }) => `${re},${im}`)
    .join(';');

export default defineSuite({
  id: '@arki/math',
  intro:
    'Speed of `@arki/math` against the libraries most people reach for: decimal.js, big.js and bignumber.js for decimal arithmetic, fraction.js for exact fractions, simple-statistics and jstat for descriptive statistics, and jstat for probability distributions. Each table only ranks libraries that returned the same result on every checked input.',
  notes: [
    '`@arki/math` Decimal is exact: it stores a bigint plus a scale and never rounds unless you ask. Division throws when the result does not terminate, so every divide case passes `{ scale: 10, rounding: "halfEven" }`.',
    'The other decimal libraries are configured to keep the same promise: decimal.js works at 100 significant digits (enough to be exact on every add and multiply input here; its default is 20) with half-even rounding, and big.js and bignumber.js round each division once, at 10 places, half-even.',
    '`@arki/math` Decimal keeps the scale it was given (`1.50` stays `1.50`); the other libraries drop trailing zeros. Results are compared after dropping trailing zeros.',
    'Rational and fraction.js are exact and reduce to lowest terms; results are compared as `numerator/denominator`.',
    'Statistics run on five data sets of 1,000 numbers (a sine wave, values near 1e9, negatives, a constant, random cents) and are compared to 12 significant digits, because compensated and plain summation can differ in the last bits.',
    'Statistics in `@arki/math` check that every element is a finite number, never modify the input, use compensated summation, and select percentiles with quickselect on a checked copy (falling back to a sort when selection stalls). simple-statistics also uses compensated summation and quickselect on a copy; jstat sorts a full copy.',
    'Regression runs on two seeded data sets of 1,000 points, linear algebra on three seeded sets of matrices (50×50, or 20×20 for inverse; the matrix to solve, invert or take the determinant of is diagonally dominant so every library is well-conditioned), eigendecompositions on three seeded 20×20 matrices (the diagonally dominant ones, and their symmetric parts for the symmetric group; every library also computes eigenvectors, which ml-matrix and mathjs do by default), complex numbers on six pairs that include a real, an imaginary and a negative-real input. All are compared to 9 significant digits, with values below 1e-12 counted as 0. Matrices are converted to ml-matrix `Matrix` objects before timing, as that library expects; mathjs and `@arki/math` take plain `number[][]`.',
    '`@arki/math` linearRegression also computes r², which simple-statistics `linearRegression` does not; regression-js is run with `precision: 15` (its default of 2 decimals would round the result). regression-js exponential fits a different curve, so it is shown without a rank.',
    'Distribution values are compared to 9 significant digits, with values below 1e-12 counted as 0.',
  ],
  groups: [
    compare<Pair>({
      id: 'decimal-plus',
      title: 'Decimal plus',
      contract: { id: 'math-decimal-plus/v1', description: 'the exact sum of two decimal strings, as plain text' },
      inputs: sumPairs,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/math',
          package: '@arki/math',
          setup: ({ a, b }) => ({ x: decimal(a), y: decimal(b) }),
          run: ({ x, y }) => x.plus(y),
          normalize: result => plain(result.toString()),
        }),
        decimal: c({
          label: 'decimal.js',
          package: 'decimal.js',
          setup: ({ a, b }) => ({ x: new Dec(a), y: new Dec(b) }),
          run: ({ x, y }) => x.plus(y),
          normalize: result => plain(result.toFixed()),
        }),
        big: c({
          label: 'big.js',
          package: 'big.js',
          setup: ({ a, b }) => ({ x: new Big(a), y: new Big(b) }),
          run: ({ x, y }) => x.plus(y),
          normalize: result => plain(result.toFixed()),
        }),
        bignumber: c({
          label: 'bignumber.js',
          package: 'bignumber.js',
          setup: ({ a, b }) => ({ x: new BigNumber(a), y: new BigNumber(b) }),
          run: ({ x, y }) => x.plus(y),
          normalize: result => plain(result.toFixed()),
        }),
      }),
    }),
    compare<Pair>({
      id: 'decimal-times',
      title: 'Decimal times',
      contract: { id: 'math-decimal-times/v1', description: 'the exact product of two decimal strings, as plain text' },
      inputs: productPairs,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/math',
          package: '@arki/math',
          setup: ({ a, b }) => ({ x: decimal(a), y: decimal(b) }),
          run: ({ x, y }) => x.times(y),
          normalize: result => plain(result.toString()),
        }),
        decimal: c({
          label: 'decimal.js',
          package: 'decimal.js',
          setup: ({ a, b }) => ({ x: new Dec(a), y: new Dec(b) }),
          run: ({ x, y }) => x.times(y),
          normalize: result => plain(result.toFixed()),
        }),
        big: c({
          label: 'big.js',
          package: 'big.js',
          setup: ({ a, b }) => ({ x: new Big(a), y: new Big(b) }),
          run: ({ x, y }) => x.times(y),
          normalize: result => plain(result.toFixed()),
        }),
        bignumber: c({
          label: 'bignumber.js',
          package: 'bignumber.js',
          setup: ({ a, b }) => ({ x: new BigNumber(a), y: new BigNumber(b) }),
          run: ({ x, y }) => x.times(y),
          normalize: result => plain(result.toFixed()),
        }),
      }),
    }),
    compare<Pair>({
      id: 'decimal-divide',
      title: 'Decimal divide, 10 places, half-even',
      contract: {
        id: 'math-decimal-divide-10-half-even/v1',
        description: 'the quotient rounded once to 10 decimal places, half-even (0.00000000025 / 1 → 0.0000000002)',
      },
      inputs: divisionPairs,
      baseline: 'arki',
      note: 'decimal.js rounds to significant digits, not decimal places, so it divides at 100 digits and then rounds to 10 places.',
      cases: c => ({
        arki: c({
          label: '@arki/math dividedBy({ scale, rounding })',
          package: '@arki/math',
          setup: ({ a, b }) => ({ x: decimal(a), y: decimal(b) }),
          run: ({ x, y }) => x.dividedBy(y, SCALE_OPTIONS),
          normalize: result => result.toFixed(SCALE),
        }),
        decimal: c({
          label: 'decimal.js div + toDecimalPlaces',
          package: 'decimal.js',
          setup: ({ a, b }) => ({ x: new Dec(a), y: new Dec(b) }),
          run: ({ x, y }) => x.div(y).toDecimalPlaces(SCALE, Decimal.ROUND_HALF_EVEN),
          normalize: result => result.toFixed(SCALE),
        }),
        big: c({
          label: 'big.js div (DP 10, half-even)',
          package: 'big.js',
          setup: ({ a, b }) => ({ x: new Big10(a), y: new Big10(b) }),
          run: ({ x, y }) => x.div(y),
          normalize: result => result.toFixed(SCALE),
        }),
        bignumber: c({
          label: 'bignumber.js dividedBy (10 places, half-even)',
          package: 'bignumber.js',
          setup: ({ a, b }) => ({ x: new BN10(a), y: new BN10(b) }),
          run: ({ x, y }) => x.dividedBy(y),
          normalize: result => result.toFixed(SCALE),
        }),
      }),
    }),
    compare<string>({
      id: 'decimal-parse',
      title: 'Decimal parse a string',
      contract: { id: 'math-decimal-parse/v1', description: 'the value of a plain decimal string' },
      inputs: ['1234.5678', '-0.001', '0', LONG, '007.50', '0.1', '-98765.4321'],
      expected: text => plain(text.replace(/^(-?)0+(?=\d)/u, '$1')),
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/math decimal()',
          package: '@arki/math',
          run: (text: string) => decimal(text),
          normalize: result => plain(result.toString()),
        }),
        decimal: c({
          label: 'decimal.js',
          package: 'decimal.js',
          run: (text: string) => new Dec(text),
          normalize: result => plain(result.toFixed()),
        }),
        big: c({
          label: 'big.js',
          package: 'big.js',
          run: (text: string) => new Big(text),
          normalize: result => plain(result.toFixed()),
        }),
        bignumber: c({
          label: 'bignumber.js',
          package: 'bignumber.js',
          run: (text: string) => new BigNumber(text),
          normalize: result => plain(result.toFixed()),
        }),
      }),
    }),
    compare<string>({
      id: 'decimal-to-string',
      title: 'Decimal to plain text',
      contract: {
        id: 'math-decimal-plain-text/v1',
        description: 'plain notation, never exponent form, for values with no trailing zeros',
      },
      inputs: [LONG, '0.00000000000000000001', '-12.3', '0', '1000000000000000000000', '-0.000123'],
      expected: text => text,
      baseline: 'arki',
      note: 'The other libraries print large and tiny values in exponent form from `toString()`, so their rows call `toFixed()`.',
      cases: c => ({
        arki: c({
          label: '@arki/math toString',
          package: '@arki/math',
          setup: (text: string) => decimal(text),
          run: value => value.toString(),
        }),
        decimal: c({
          label: 'decimal.js toFixed()',
          package: 'decimal.js',
          setup: (text: string) => new Dec(text),
          run: value => value.toFixed(),
        }),
        big: c({
          label: 'big.js toFixed()',
          package: 'big.js',
          setup: (text: string) => new Big(text),
          run: value => value.toFixed(),
        }),
        bignumber: c({
          label: 'bignumber.js toFixed()',
          package: 'bignumber.js',
          setup: (text: string) => new BigNumber(text),
          run: value => value.toFixed(),
        }),
      }),
    }),
    compare<Fractions>({
      id: 'rational-plus',
      title: 'Rational plus',
      contract: { id: 'math-rational-plus/v1', description: 'the exact sum in lowest terms, as numerator/denominator' },
      inputs: fractionPairs,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/math ratio',
          package: '@arki/math',
          setup: ({ a, b }) => ({ x: ratio(a[0], a[1]), y: ratio(b[0], b[1]) }),
          run: ({ x, y }) => x.plus(y),
          normalize: ratioText,
        }),
        fraction: c({
          label: 'fraction.js',
          package: 'fraction.js',
          setup: ({ a, b }) => ({ x: fraction(a), y: fraction(b) }),
          run: ({ x, y }) => x.add(y),
          normalize: fractionText,
        }),
      }),
    }),
    compare<Fractions>({
      id: 'rational-times',
      title: 'Rational times',
      contract: {
        id: 'math-rational-times/v1',
        description: 'the exact product in lowest terms, as numerator/denominator',
      },
      inputs: fractionPairs,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/math ratio',
          package: '@arki/math',
          setup: ({ a, b }) => ({ x: ratio(a[0], a[1]), y: ratio(b[0], b[1]) }),
          run: ({ x, y }) => x.times(y),
          normalize: ratioText,
        }),
        fraction: c({
          label: 'fraction.js',
          package: 'fraction.js',
          setup: ({ a, b }) => ({ x: fraction(a), y: fraction(b) }),
          run: ({ x, y }) => x.mul(y),
          normalize: fractionText,
        }),
      }),
    }),
    compare<readonly number[]>({
      id: 'mean',
      title: 'Mean of 1,000 numbers',
      contract: { id: 'math-mean-1000/v1', description: 'the arithmetic mean, to 12 significant digits' },
      inputs: datasets,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/math mean',
          package: '@arki/math',
          run: (xs: readonly number[]) => mean(xs),
          normalize: sig12,
        }),
        ss: c({
          label: 'simple-statistics mean',
          package: 'simple-statistics',
          setup: (xs: readonly number[]) => [...xs],
          run: xs => ss.mean(xs),
          normalize: sig12,
        }),
        jstat: c({
          label: 'jstat mean',
          package: 'jstat',
          run: (xs: readonly number[]) => jStat.mean(xs),
          normalize: sig12,
        }),
      }),
    }),
    compare<readonly number[]>({
      id: 'stddev',
      title: 'Population standard deviation of 1,000 numbers',
      contract: {
        id: 'math-stddev-population-1000/v1',
        description: 'the population standard deviation (divide by n), to 12 significant digits',
      },
      inputs: datasets,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/math stddev({ ddof: 0 })',
          package: '@arki/math',
          run: (xs: readonly number[]) => stddev(xs, { ddof: 0 }),
          normalize: sig12,
        }),
        ss: c({
          label: 'simple-statistics standardDeviation',
          package: 'simple-statistics',
          setup: (xs: readonly number[]) => [...xs],
          run: xs => ss.standardDeviation(xs),
          normalize: sig12,
        }),
        jstat: c({
          label: 'jstat stdev',
          package: 'jstat',
          run: (xs: readonly number[]) => jStat.stdev(xs),
          normalize: sig12,
        }),
      }),
    }),
    compare<readonly number[]>({
      id: 'percentile',
      title: '90th percentile of 1,000 numbers',
      contract: {
        id: 'math-percentile-90-r7-1000/v1',
        description:
          'the 90th percentile by linear interpolation between closest ranks (R-7), to 12 significant digits',
      },
      inputs: datasets,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/math percentile',
          package: '@arki/math',
          run: (xs: readonly number[]) => percentile(xs, 90),
          normalize: sig12,
        }),
        ss: c({
          label: 'simple-statistics quantile',
          package: 'simple-statistics',
          setup: (xs: readonly number[]) => [...xs],
          run: xs => ss.quantile(xs, 0.9),
          normalize: sig12,
        }),
        jstat: c({
          label: 'jstat percentile',
          package: 'jstat',
          run: (xs: readonly number[]) => jStat.percentile(xs, 0.9),
          normalize: sig12,
        }),
      }),
    }),
    compare<number>({
      id: 'normal-cdf',
      title: 'Standard normal cdf',
      contract: { id: 'math-normal-cdf/v1', description: 'P(Z ≤ x) for the standard normal, to 9 significant digits' },
      inputs: [-5, -1.96, 0, 0.5, 1.96, 3, 8],
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/math normal().cdf',
          package: '@arki/math',
          setup: (x: number) => ({ distribution: normal(), x }),
          run: ({ distribution, x }) => distribution.cdf(x),
          normalize: sig9,
        }),
        jstat: c({
          label: 'jstat normal.cdf',
          package: 'jstat',
          run: (x: number) => jStat.normal.cdf(x, 0, 1),
          normalize: sig9,
        }),
      }),
    }),
    compare<number>({
      id: 'normal-quantile',
      title: 'Standard normal quantile',
      contract: {
        id: 'math-normal-quantile/v1',
        description: 'the x with P(Z ≤ x) = p for the standard normal, to 9 significant digits',
      },
      inputs: [1e-10, 0.001, 0.025, 0.5, 0.975, 0.999],
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/math normal().quantile',
          package: '@arki/math',
          setup: (p: number) => ({ distribution: normal(), p }),
          run: ({ distribution, p }) => distribution.quantile(p),
          normalize: sig9,
        }),
        jstat: c({
          label: 'jstat normal.inv',
          package: 'jstat',
          run: (p: number) => jStat.normal.inv(p, 0, 1),
          normalize: sig9,
        }),
      }),
    }),
    scenario<{ p: number; df: number }>({
      id: 'student-t-quantile',
      title: 'Student t quantile',
      inputs: [
        { p: 0.975, df: 10 },
        { p: 0.95, df: 1 },
        { p: 0.5, df: 5 },
        { p: 0.01, df: 3 },
        { p: 0.999, df: 30 },
        { p: 0.9, df: 2.5 },
      ],
      note: 'Not ranked: the two rows keep different accuracy. `@arki/math` solves the quantile until |cdf(x) − p| ≤ 1e-12 and rejects bad input; jstat `studentt.inv` is accurate to about 8 significant digits (df 10, p 0.975: 2.22813884 against the true 2.22813885).',
      cases: c => ({
        arki: c({
          label: '@arki/math studentT(df).quantile',
          package: '@arki/math',
          setup: ({ p, df }) => ({ distribution: studentT(df), p }),
          run: ({ distribution, p }) => distribution.quantile(p),
        }),
        jstat: c({
          label: 'jstat studentt.inv',
          package: 'jstat',
          run: ({ p, df }: { p: number; df: number }) => jStat.studentt.inv(p, df),
        }),
      }),
    }),
    compare<Series>({
      id: 'linear-regression',
      title: 'Linear regression (1,000 points)',
      contract: {
        id: 'math-linear-regression/v1',
        description: 'least-squares slope and intercept of y on x, to 9 significant digits',
      },
      inputs: series(1, (x, noise) => 5 + 3 * x + noise * 2),
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/math linearRegression',
          package: '@arki/math',
          run: ({ x, y }: Series) => linearRegression(x, y),
          normalize: fit => list([fit.slope, fit.intercept]),
        }),
        ss: c({
          label: 'simple-statistics linearRegression',
          package: 'simple-statistics',
          setup: ({ x, y }: Series) => points(x, y),
          run: data => ss.linearRegression(data),
          normalize: fit => list([fit.m, fit.b]),
        }),
        regression: c({
          label: 'regression linear',
          package: 'regression',
          setup: ({ x, y }: Series) => points(x, y),
          run: data => regression.linear(data, REGRESSION_OPTIONS),
          normalize: fit => list(fit.equation),
        }),
      }),
    }),
    compare<Series>({
      id: 'power-regression',
      title: 'Power regression (1,000 points)',
      contract: {
        id: 'math-power-regression/v1',
        description: 'y = a·x^b fitted by least squares on ln y against ln x; a and b to 9 significant digits',
      },
      inputs: series(2, (x, noise) => 2 * x ** 1.5 * (1 + noise * 0.05)),
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/math powerRegression',
          package: '@arki/math',
          run: ({ x, y }: Series) => powerRegression(x, y),
          normalize: fit => list([fit.a, fit.b]),
        }),
        regression: c({
          label: 'regression power',
          package: 'regression',
          setup: ({ x, y }: Series) => points(x, y),
          run: data => regression.power(data, REGRESSION_OPTIONS),
          normalize: fit => list(fit.equation),
        }),
      }),
    }),
    scenario<Series>({
      id: 'exponential-regression',
      title: 'Exponential regression (1,000 points)',
      inputs: series(3, (x, noise) => 1.5 * Math.exp(0.25 * x) * (1 + noise * 0.05)),
      note: 'Not ranked: the rows fit different curves. `@arki/math` fits ln y against x by least squares (the standard log-linear fit). regression-js minimizes a y-weighted error instead, so its a and b differ in the 3rd digit on noisy data.',
      cases: c => ({
        arki: c({
          label: '@arki/math exponentialRegression',
          package: '@arki/math',
          run: ({ x, y }: Series) => exponentialRegression(x, y),
        }),
        regression: c({
          label: 'regression exponential',
          package: 'regression',
          setup: ({ x, y }: Series) => points(x, y),
          run: data => regression.exponential(data, REGRESSION_OPTIONS),
        }),
      }),
    }),
    compare<Series>({
      id: 'polynomial-regression',
      title: 'Polynomial regression, degree 2 (1,000 points)',
      contract: {
        id: 'math-polynomial-regression/v1',
        description: 'least-squares quadratic y = c0 + c1·x + c2·x²; the three coefficients to 9 significant digits',
      },
      inputs: series(4, (x, noise) => 1 + 2 * x - 0.3 * x * x + noise),
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/math polynomialRegression',
          package: '@arki/math',
          run: ({ x, y }: Series) => polynomialRegression(x, y, 2),
          normalize: fit => list(fit.coefficients),
        }),
        regression: c({
          label: 'regression polynomial',
          package: 'regression',
          setup: ({ x, y }: Series) => points(x, y),
          run: data => regression.polynomial(data, { ...REGRESSION_OPTIONS, order: 2 }),
          // regression-js lists the highest power first.
          normalize: fit => list(fit.equation.toReversed()),
        }),
      }),
    }),
    compare<MatrixPair>({
      id: 'matrix-multiply',
      title: 'Matrix multiply (50×50)',
      contract: { id: 'math-matrix-multiply/v1', description: 'the product A·B, every entry to 9 significant digits' },
      inputs: matrixPairs(50),
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/math multiply',
          package: '@arki/math',
          run: ({ a, b }: MatrixPair) => multiply(a, b),
          normalize: matrixText,
        }),
        mlMatrix: c({
          label: 'ml-matrix mmul',
          package: 'ml-matrix',
          setup: ({ a, b }) => ({ x: new Matrix(a), y: new Matrix(b) }),
          run: ({ x, y }) => x.mmul(y),
          normalize: result => matrixText(result.to2DArray()),
        }),
        mathjs: c({
          label: 'mathjs multiply',
          package: 'mathjs',
          run: ({ a, b }: MatrixPair) => mathMultiply(a, b),
          normalize: matrixText,
        }),
      }),
    }),
    compare<MatrixPair>({
      id: 'matrix-solve',
      title: 'Solve A·x = b (50×50)',
      contract: {
        id: 'math-matrix-solve/v1',
        description: 'the vector x with A·x = b for a well-conditioned square A, every entry to 9 significant digits',
      },
      inputs: matrixPairs(50),
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/math solve',
          package: '@arki/math',
          setup: ({ a, b }) => ({ a, v: b.map(row => row[0] ?? 0) }),
          run: ({ a, v }) => solve(a, v),
          normalize: result => list(result),
        }),
        mlMatrix: c({
          label: 'ml-matrix solve',
          package: 'ml-matrix',
          setup: ({ a, b }) => ({ x: new Matrix(a), v: Matrix.columnVector(b.map(row => row[0] ?? 0)) }),
          run: ({ x, v }) => mlSolve(x, v),
          normalize: result => list(result.to1DArray()),
        }),
        mathjs: c({
          label: 'mathjs lusolve',
          package: 'mathjs',
          setup: ({ a, b }) => ({ a, v: b.map(row => row[0] ?? 0) }),
          run: ({ a, v }) => lusolve(a, v),
          normalize: result => list(flatNumbers(result.valueOf())),
        }),
      }),
    }),
    compare<MatrixPair>({
      id: 'matrix-determinant',
      title: 'Determinant (50×50)',
      contract: {
        id: 'math-matrix-determinant/v1',
        description: 'det(A) of a well-conditioned square matrix, to 9 significant digits',
      },
      inputs: matrixPairs(50),
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/math determinant',
          package: '@arki/math',
          run: ({ a }: MatrixPair) => determinant(a),
          normalize: sig9,
        }),
        mlMatrix: c({
          label: 'ml-matrix determinant',
          package: 'ml-matrix',
          setup: ({ a }) => new Matrix(a),
          run: x => mlDeterminant(x),
          normalize: sig9,
        }),
        mathjs: c({
          label: 'mathjs det',
          package: 'mathjs',
          run: ({ a }: MatrixPair) => det(a),
          normalize: sig9,
        }),
      }),
    }),
    compare<MatrixPair>({
      id: 'matrix-inverse',
      title: 'Inverse (20×20)',
      contract: {
        id: 'math-matrix-inverse/v1',
        description: 'A⁻¹ of a well-conditioned square matrix, every entry to 9 significant digits',
      },
      inputs: matrixPairs(20),
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/math inverse',
          package: '@arki/math',
          run: ({ a }: MatrixPair) => inverse(a),
          normalize: matrixText,
        }),
        mlMatrix: c({
          label: 'ml-matrix inverse',
          package: 'ml-matrix',
          setup: ({ a }) => new Matrix(a),
          run: x => mlInverse(x),
          normalize: result => matrixText(result.to2DArray()),
        }),
        mathjs: c({
          label: 'mathjs inv',
          package: 'mathjs',
          run: ({ a }: MatrixPair) => inv(a),
          normalize: matrixText,
        }),
      }),
    }),
    compare<Square>({
      id: 'symmetric-eigen',
      title: 'Symmetric eigendecomposition (20×20)',
      contract: {
        id: 'math-symmetric-eigen/v1',
        description:
          'eigenvalues and eigenvectors of a symmetric matrix; the eigenvalues, sorted, are compared to 9 significant digits',
      },
      inputs: symmetricSquares,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/math symmetricEigenDecompose',
          package: '@arki/math',
          run: ({ a }: Square) => symmetricEigenDecompose(a),
          normalize: result => sortedText(result.values),
        }),
        mlMatrix: c({
          label: 'ml-matrix EigenvalueDecomposition',
          package: 'ml-matrix',
          setup: ({ a }) => new Matrix(a),
          run: x => new EigenvalueDecomposition(x, { assumeSymmetric: true }),
          normalize: result => sortedText(result.realEigenvalues),
        }),
        mathjs: c({
          label: 'mathjs eigs',
          package: 'mathjs',
          run: ({ a }: Square) => eigs(a),
          normalize: result => sortedText(flatNumbers(result.values.valueOf())),
        }),
      }),
    }),
    compare<Square>({
      id: 'general-eigen',
      title: 'General eigendecomposition (20×20)',
      contract: {
        id: 'math-general-eigen/v1',
        description:
          'eigenvalues (real or complex) and eigenvectors of a non-symmetric real matrix; the eigenvalues, sorted by real then imaginary part, are compared to 9 significant digits',
      },
      inputs: generalSquares,
      baseline: 'arki',
      note: 'mathjs `eigs` is not shown: on all three inputs it throws "The eigenvalues failed to converge" (with its default precision of 1e-15, and still on two of the three with `precision: 1e-8`).',
      cases: c => ({
        arki: c({
          label: '@arki/math eigenDecompose',
          package: '@arki/math',
          run: ({ a }: Square) => eigenDecompose(a),
          normalize: result => rootsText(result.values),
        }),
        mlMatrix: c({
          label: 'ml-matrix EigenvalueDecomposition',
          package: 'ml-matrix',
          setup: ({ a }) => new Matrix(a),
          run: x => new EigenvalueDecomposition(x),
          normalize: result =>
            rootsText(result.realEigenvalues.map((re, index) => ({ re, im: result.imaginaryEigenvalues[index] ?? 0 }))),
        }),
      }),
    }),
    compare<ComplexPair>({
      id: 'complex-times',
      title: 'Complex times',
      contract: {
        id: 'math-complex-times/v1',
        description: 'the product of two complex numbers; real and imaginary part to 9 significant digits',
      },
      inputs: complexPairs,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/math Complex.times',
          package: '@arki/math',
          setup: ({ a, b }) => ({ x: complex(a[0], a[1]), y: complex(b[0], b[1]) }),
          run: ({ x, y }) => x.times(y),
          normalize: parts,
        }),
        complexJs: c({
          label: 'complex.js mul',
          package: 'complex.js',
          setup: ({ a, b }) => ({ x: new ComplexJs(a[0], a[1]), y: new ComplexJs(b[0], b[1]) }),
          run: ({ x, y }) => x.mul(y),
          normalize: parts,
        }),
        mathjs: c({
          label: 'mathjs multiply',
          package: 'mathjs',
          setup: ({ a, b }) => ({ x: mathComplex(a[0], a[1]), y: mathComplex(b[0], b[1]) }),
          run: ({ x, y }) => mathMultiply(x, y),
          normalize: parts,
        }),
      }),
    }),
    compare<ComplexPair>({
      id: 'complex-divided-by',
      title: 'Complex dividedBy',
      contract: {
        id: 'math-complex-divide/v1',
        description: 'the quotient of two complex numbers; real and imaginary part to 9 significant digits',
      },
      inputs: complexPairs,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/math Complex.dividedBy',
          package: '@arki/math',
          setup: ({ a, b }) => ({ x: complex(a[0], a[1]), y: complex(b[0], b[1]) }),
          run: ({ x, y }) => x.dividedBy(y),
          normalize: parts,
        }),
        complexJs: c({
          label: 'complex.js div',
          package: 'complex.js',
          setup: ({ a, b }) => ({ x: new ComplexJs(a[0], a[1]), y: new ComplexJs(b[0], b[1]) }),
          run: ({ x, y }) => x.div(y),
          normalize: parts,
        }),
        mathjs: c({
          label: 'mathjs divide',
          package: 'mathjs',
          setup: ({ a, b }) => ({ x: mathComplex(a[0], a[1]), y: mathComplex(b[0], b[1]) }),
          run: ({ x, y }) => mathDivide(x, y),
          normalize: parts,
        }),
      }),
    }),
    compare<ComplexPair>({
      id: 'complex-pow',
      title: 'Complex pow',
      contract: {
        id: 'math-complex-pow/v1',
        description: 'the principal value of z^w for complex z and w; real and imaginary part to 9 significant digits',
      },
      inputs: complexPairs,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/math Complex.pow',
          package: '@arki/math',
          setup: ({ a, b }) => ({ x: complex(a[0], a[1]), y: complex(b[0], b[1]) }),
          run: ({ x, y }) => x.pow(y),
          normalize: parts,
        }),
        complexJs: c({
          label: 'complex.js pow',
          package: 'complex.js',
          setup: ({ a, b }) => ({ x: new ComplexJs(a[0], a[1]), y: new ComplexJs(b[0], b[1]) }),
          run: ({ x, y }) => x.pow(y),
          normalize: parts,
        }),
        mathjs: c({
          label: 'mathjs pow',
          package: 'mathjs',
          setup: ({ a, b }) => ({ x: mathComplex(a[0], a[1]), y: mathComplex(b[0], b[1]) }),
          run: ({ x, y }) => mathPow(x, y),
          normalize: parts,
        }),
      }),
    }),
    compare<ComplexPair>({
      id: 'complex-sqrt',
      title: 'Complex sqrt',
      contract: {
        id: 'math-complex-sqrt/v1',
        description: 'the principal square root; real and imaginary part to 9 significant digits',
      },
      inputs: complexPairs,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/math Complex.sqrt',
          package: '@arki/math',
          setup: ({ a }) => complex(a[0], a[1]),
          run: x => x.sqrt(),
          normalize: parts,
        }),
        complexJs: c({
          label: 'complex.js sqrt',
          package: 'complex.js',
          setup: ({ a }) => new ComplexJs(a[0], a[1]),
          run: x => x.sqrt(),
          normalize: parts,
        }),
        mathjs: c({
          label: 'mathjs sqrt',
          package: 'mathjs',
          setup: ({ a }) => mathComplex(a[0], a[1]),
          run: x => mathSqrt(x),
          normalize: parts,
        }),
      }),
    }),
    compare<string>({
      id: 'complex-parse',
      title: 'Complex parse',
      contract: {
        id: 'math-complex-parse/v1',
        description: 'the number a text like "3+4i" stands for; real and imaginary part to 9 significant digits',
      },
      inputs: ['3+4i', '-2.5-0.5i', '7', '2i', '-i', '1.5e3+2e-3i', '0.125 - 8i'],
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/math complex(text)',
          package: '@arki/math',
          run: (text: string) => complex(text),
          normalize: parts,
        }),
        complexJs: c({
          label: 'complex.js new Complex(text)',
          package: 'complex.js',
          run: (text: string) => new ComplexJs(text),
          normalize: parts,
        }),
        mathjs: c({
          label: 'mathjs complex(text)',
          package: 'mathjs',
          run: (text: string) => mathComplex(text),
          normalize: parts,
        }),
      }),
    }),
    compare<readonly [number, number, number, number]>({
      id: 'cubic-roots',
      title: 'Cubic roots',
      contract: {
        id: 'math-cubic-roots/v1',
        description:
          'all three roots of ax³+bx²+cx+d, as real/imaginary parts sorted by real part then imaginary part, to 9 significant digits',
      },
      inputs: [
        [1, -6, 11, -6],
        [2, -4, -22, 24],
        [1, 0, 0, -8],
        [1, 2, 3, 4],
        [-3, 0.5, 7, 1.25],
      ],
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/math cubicRoots',
          package: '@arki/math',
          run: ([a, b, c0, d]: readonly [number, number, number, number]) => cubicRoots(a, b, c0, d),
          normalize: result =>
            rootsText(
              result.kind === 'real'
                ? result.roots.map(re => ({ re, im: 0 }))
                : [{ re: result.real, im: 0 }, ...result.complex],
            ),
        }),
        mathjs: c({
          label: 'mathjs polynomialRoot',
          package: 'mathjs',
          run: ([a, b, c0, d]: readonly [number, number, number, number]) => polynomialRoot(d, c0, b, a),
          normalize: result => rootsText(result.map(root => (typeof root === 'number' ? { re: root, im: 0 } : root))),
        }),
      }),
    }),
  ],
});
