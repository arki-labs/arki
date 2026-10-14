/**
 * Statistics and regression against NIST StRD certified values
 * (fixtures/nist-strd.json, from https://www.itl.nist.gov/div898/strd/).
 *
 * Accuracy is measured as the log relative error, LRE = −log10(|x − c| / |c|)
 * (−log10|x| when the certified c is 0), capped at 15 because NIST certifies 15
 * significant digits: the number of digits that agree. The thresholds are the
 * guarantees published in the README's accuracy table.
 *
 * On Decimal input the statistics are exact (the mean) or correctly rounded
 * (the standard deviation), so they must reproduce every certified value
 * digit for digit. On number input the data itself is already rounded to
 * binary (10000000.2 is not a double), which caps the agreement with the
 * certified values for NumAcc3/4; against the exact statistics of the binary
 * inputs the float path keeps ≥ 14 digits on every set.
 *
 * Thresholds hold on V8 and JavaScriptCore alike (their Math.hypot/pow differ
 * in the last bit, which moves the ill-conditioned Wampler fits by a few
 * tenths of a digit).
 */
import { describe, expect, it } from 'vitest';

import fixture from '../test/reference/fixtures/nist-strd.json' with { type: 'json' };
import { Decimal } from './decimal.js';
import { leastSquares } from './linear-algebra.js';
import { linearRegression, mean, polynomialRegression, stddev } from './stats.js';

type Dataset = (typeof fixture.datasets)[number];
type Parameter = { estimate: string; standardDeviation: string };
type Univariate = { name: string; difficulty: string; values: string[]; mean: string; stddev: string };
type Linear = {
  name: string;
  difficulty: string;
  model: string;
  rows: string[][];
  parameters: Parameter[];
  residualStandardDeviation: string;
  rSquared: string;
};

const CERTIFIED_DIGITS = 15;

/** Digits of agreement between a computed value and a certified one, capped at 15. */
function lre(value: number, certified: number): number {
  const error = certified === 0 ? Math.abs(value) : Math.abs(value - certified) / Math.abs(certified);
  return error === 0 ? CERTIFIED_DIGITS : Math.min(CERTIFIED_DIGITS, -Math.log10(error));
}

function dataset(name: string): Dataset {
  const found = fixture.datasets.find(d => d.name === name);
  if (!found) throw new Error(`no NIST dataset ${name}`);
  return found;
}

function univariate(name: string): Univariate {
  const d = dataset(name);
  const { mean: m, stddev: s } = d.certified;
  if (d.kind !== 'univariate' || m === undefined || s === undefined) throw new Error(`${name} is not univariate`);
  return { name, difficulty: d.difficulty, values: d.data.map(String), mean: m, stddev: s };
}

function linear(name: string): Linear {
  const d = dataset(name);
  const { parameters, residualStandardDeviation, rSquared } = d.certified;
  if (d.kind !== 'linear' || !parameters || !residualStandardDeviation || !rSquared || !d.model) {
    throw new Error(`${name} is not a regression dataset`);
  }
  const rows = d.data.map(row => (Array.isArray(row) ? row : [row]));
  return { name, difficulty: d.difficulty, model: d.model, rows, parameters, residualStandardDeviation, rSquared };
}

/** Fraction digits of a certified value as NIST prints it (`-177.435000000000` → 12). */
function fractionDigits(text: string): number {
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/** The exact value of a double, as a Decimal (`0.1` → 0.1000000000000000055511151231257827…). */
function exactDecimal(x: number): Decimal {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 2047n);
  const fraction = bits & ((1n << 52n) - 1n);
  const mantissa = biased === 0 ? fraction : fraction | (1n << 52n);
  const exponent = biased === 0 ? -1074 : biased - 1075;
  const sign = bits >> 63n === 1n ? -1n : 1n;
  return exponent >= 0
    ? Decimal.fromParts({ coefficient: sign * (mantissa << BigInt(exponent)), scale: 0 })
    : Decimal.fromParts({ coefficient: sign * mantissa * 5n ** BigInt(-exponent), scale: -exponent });
}

/**
 * Minimum digits of agreement with the certified stddev on number input (the
 * mean agrees to all 15 everywhere). Published in the README.
 */
const STDDEV_LRE: Record<string, number> = {
  PiDigits: 15,
  Lottery: 15,
  Lew: 15,
  Mavro: 13,
  Michelso: 13.5,
  NumAcc1: 15,
  NumAcc2: 14.5,
  NumAcc3: 9,
  NumAcc4: 8,
};

describe('NIST StRD univariate summary statistics', () => {
  for (const [name, minimum] of Object.entries(STDDEV_LRE)) {
    const d = univariate(name);
    const values = d.values.map(Number);
    const decimals = d.values.map(text => Decimal.from(text));

    it(`${name} (${d.difficulty} difficulty): on numbers, mean to 15 digits and stddev to ≥ ${minimum}`, () => {
      expect(lre(mean(values), Number(d.mean))).toBe(CERTIFIED_DIGITS);
      expect(lre(stddev(values), Number(d.stddev))).toBeGreaterThanOrEqual(minimum);
    });

    it(`${name}: on numbers, stddev keeps ≥ 14 digits of the exact stddev of its binary inputs`, () => {
      const exact = stddev(
        values.map(value => exactDecimal(value)),
        { scale: 40, rounding: 'halfEven' },
      );
      expect(lre(stddev(values), Number(exact.toString()))).toBeGreaterThanOrEqual(14);
    });

    it(`${name}: Decimal mean and stddev equal the certified values digit for digit`, () => {
      const options = (text: string) => ({ scale: fractionDigits(text), rounding: 'halfEven' as const });
      expect(mean(decimals, options(d.mean)).toString()).toBe(d.mean);
      expect(stddev(decimals, options(d.stddev)).toString()).toBe(d.stddev);
    });
  }
});

/** Minimum digits of agreement for each regression dataset (published in the README). */
const REGRESSION_LRE: Record<string, number> = {
  Norris: 12.5,
  Pontius: 11.5,
  Filip: 13.5,
  Wampler1: 9,
  Wampler2: 12,
  Wampler3: 9,
  Wampler4: 9,
  Wampler5: 7.5,
};

/** leastSquares on the raw design matrix, for the models the stats functions do not fit. */
const LEAST_SQUARES_LRE: Record<string, number> = { Longley: 10.5, NoInt1: 14, NoInt2: 14 };

/** Every certified value of a fit, with its computed counterpart. */
function compare(d: Linear): { what: string; digits: number }[] {
  const x = d.rows.map(row => Number(row[1]));
  const y = d.rows.map(row => Number(row[0]));
  const certified = d;
  const pairs: { what: string; value: number; certified: string }[] = [];
  if (d.name === 'Norris') {
    const fit = linearRegression(x, y);
    const [b0, b1] = certified.parameters;
    pairs.push(
      { what: 'intercept', value: fit.intercept, certified: b0?.estimate ?? '' },
      { what: 'slope', value: fit.slope, certified: b1?.estimate ?? '' },
      {
        what: 'interceptStandardError',
        value: fit.interceptStandardError ?? Number.NaN,
        certified: b0?.standardDeviation ?? '',
      },
      {
        what: 'slopeStandardError',
        value: fit.slopeStandardError ?? Number.NaN,
        certified: b1?.standardDeviation ?? '',
      },
      {
        what: 'residualStandardError',
        value: fit.residualStandardError ?? Number.NaN,
        certified: certified.residualStandardDeviation,
      },
      { what: 'r2', value: fit.r2, certified: certified.rSquared },
    );
  } else {
    const fit = polynomialRegression(x, y, certified.parameters.length - 1);
    for (const [k, parameter] of certified.parameters.entries()) {
      pairs.push({ what: `B${k}`, value: fit.coefficients[k] ?? Number.NaN, certified: parameter.estimate });
    }
    pairs.push(
      {
        what: 'residualStandardError',
        value: fit.residualStandardError ?? Number.NaN,
        certified: certified.residualStandardDeviation,
      },
      { what: 'r2', value: fit.r2, certified: certified.rSquared },
    );
  }
  return pairs.map(p => ({ what: p.what, digits: lre(p.value, Number(p.certified)) }));
}

describe('NIST StRD linear least squares', () => {
  it('covers every linear dataset', () => {
    const covered = [...Object.keys(REGRESSION_LRE), ...Object.keys(LEAST_SQUARES_LRE)];
    const all = fixture.datasets.filter(d => d.kind === 'linear').map(d => d.name);
    expect(covered.toSorted()).toEqual(all.toSorted());
  });

  for (const [name, minimum] of Object.entries(LEAST_SQUARES_LRE)) {
    const d = linear(name);
    it(`${name} (${d.difficulty} difficulty): leastSquares estimates to ≥ ${minimum} digits`, () => {
      // Longley: y on an intercept and six predictors; NoInt1/2: y = B1·x, no intercept.
      const design = d.rows.map(row => (name === 'Longley' ? [1, ...row.slice(1).map(Number)] : [Number(row[1])]));
      const estimates = leastSquares(
        design,
        d.rows.map(row => Number(row[0])),
      );
      const digits = d.parameters.map((p, k) => lre(estimates[k] ?? Number.NaN, Number(p.estimate)));
      expect(Math.min(...digits), `${name}: ${digits.map(v => v.toFixed(1)).join(', ')}`).toBeGreaterThanOrEqual(
        minimum,
      );
    });
  }

  for (const [name, minimum] of Object.entries(REGRESSION_LRE)) {
    const d = linear(name);
    it(`${name} (${d.difficulty} difficulty, ${d.model.split(' ')[0]}): every certified value to ≥ ${minimum} digits`, () => {
      const results = compare(d);
      const worst = results.reduce((a, b) => (b.digits < a.digits ? b : a));
      expect(
        worst.digits,
        `${name}: ${results.map(r => `${r.what} ${r.digits.toFixed(1)}`).join(', ')}`,
      ).toBeGreaterThanOrEqual(minimum);
    });
  }
});
