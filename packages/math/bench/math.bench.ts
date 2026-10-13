// Speed of @arki/math against the number libraries most projects use.
// Run: `bun run bench` (explore) or `bun run bench --profile publish --write-readme`.
//
// Every `compare` group states a contract and is checked before timing: each
// ranked library must return the same normalized value for every input,
// including the boundary inputs listed. Libraries that keep a different
// promise are marked `differs` and shown without a ratio.

// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- loads the local module declaration for an untyped competitor
/// <reference path="./jstat.d.ts" />

/* eslint-disable unicorn/require-number-to-fixed-digits-argument -- these are decimal.js / big.js / bignumber.js `toFixed()`: with no argument they print every digit in plain notation (unlike Number#toFixed), which the contracts rely on */
import Big from 'big.js';
import BigNumber from 'bignumber.js';
import { Decimal } from 'decimal.js';
import Fraction from 'fraction.js';
import jStat from 'jstat';
import * as ss from 'simple-statistics';

import { compare, defineSuite, scenario } from '@arki/bench';
import { decimal } from '@arki/math/decimal';
import { normal, studentT } from '@arki/math/distributions';
import { ratio } from '@arki/math/rational';
import { mean, percentile, stddev } from '@arki/math/stats';

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
  ],
});
