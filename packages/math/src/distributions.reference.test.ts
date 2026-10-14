/**
 * Distributions and special functions against mpmath at 50 digits
 * (fixtures/distributions.json, built by test/reference/gen_distributions.py).
 *
 * Each function's guarantee is a maximum error over the reference points:
 * relative error |got − want| / |want| (absolute where `want` is 0, and for the
 * noncentral t, whose AS 243 series is accurate in absolute terms). These are
 * the bounds the README's accuracy table publishes; a change that loses
 * accuracy anywhere in the covered range, tails included, fails here.
 * Discrete quantiles are integers and must match exactly.
 */
import { describe, expect, it } from 'vitest';

import type { ContinuousDistribution, DiscreteDistribution } from './distributions.js';
import fixture from '../test/reference/fixtures/distributions.json' with { type: 'json' };
import {
  beta,
  betaLn,
  binomial,
  chiSquare,
  erf,
  erfc,
  erfInv,
  exponential,
  fisherF,
  gamma,
  gammaLn,
  noncentralT,
  normal,
  poisson,
  regularizedBeta,
  regularizedGammaP,
  studentT,
} from './distributions.js';

type Entry = (typeof fixture.entries)[number];
type Bound = { relative: number } | { absolute: number } | 'exact';

/** Published guarantees (README "Accuracy"), keyed by function or `distribution.method`. */
const BOUNDS: Record<string, Bound> = {
  erf: { relative: 4e-16 },
  erfc: { relative: 5e-16 },
  erfInv: { relative: 5e-16 },
  gamma: { relative: 3e-13 },
  gammaLn: { relative: 1e-13 },
  beta: { relative: 2e-12 },
  betaLn: { relative: 5e-13 },
  regularizedGammaP: { relative: 1e-12 },
  regularizedBeta: { relative: 2e-11 },
  'normal.cdf': { relative: 3e-13 },
  'normal.sf': { relative: 3e-13 },
  'normal.pdf': { relative: 2e-13 },
  'normal.quantile': { relative: 5e-16 },
  'studentT.cdf': { relative: 5e-12 },
  'studentT.sf': { relative: 5e-12 },
  'studentT.pdf': { relative: 1e-12 },
  'studentT.quantile': { relative: 3e-12 },
  'chiSquare.cdf': { relative: 2e-12 },
  'chiSquare.sf': { relative: 2e-12 },
  'chiSquare.pdf': { relative: 2e-12 },
  'chiSquare.quantile': { relative: 2e-12 },
  'fisherF.cdf': { relative: 3e-13 },
  'fisherF.sf': { relative: 3e-13 },
  'fisherF.pdf': { relative: 3e-13 },
  'fisherF.quantile': { relative: 3e-12 },
  'noncentralT.cdf': { absolute: 2e-14 },
  'exponential.cdf': { relative: 2.3e-16 },
  'exponential.sf': { relative: 2.3e-16 },
  'exponential.pdf': { relative: 2.3e-16 },
  'exponential.quantile': { relative: 2.3e-16 },
  'binomial.pmf': { relative: 2e-12 },
  'binomial.cdf': { relative: 2e-12 },
  'binomial.sf': { relative: 2e-12 },
  'binomial.quantile': 'exact',
  'poisson.pmf': { relative: 8e-12 },
  'poisson.cdf': { relative: 8e-12 },
  'poisson.sf': { relative: 8e-12 },
  'poisson.quantile': 'exact',
};

const SPECIAL: Record<string, (...args: number[]) => number> = {
  erf,
  erfc,
  erfInv,
  gamma,
  gammaLn,
  beta,
  betaLn,
  regularizedGammaP,
  regularizedBeta,
};

const DISTRIBUTIONS: Record<string, (...params: number[]) => ContinuousDistribution | DiscreteDistribution> = {
  normal: (mean = 0, sd = 1) => normal(mean, sd),
  studentT: df => studentT(df ?? Number.NaN),
  chiSquare: df => chiSquare(df ?? Number.NaN),
  fisherF: (d1, d2) => fisherF(d1 ?? Number.NaN, d2 ?? Number.NaN),
  noncentralT: (df, ncp) => noncentralT(df ?? Number.NaN, ncp ?? Number.NaN),
  exponential: rate => exponential(rate ?? Number.NaN),
  binomial: (n, p) => binomial(n ?? Number.NaN, p ?? Number.NaN),
  poisson: lambda => poisson(lambda ?? Number.NaN),
};

function evaluator(entry: Entry): (args: number[]) => number {
  const special = SPECIAL[entry.name];
  if (special) return args => special(...args);
  const make = DISTRIBUTIONS[entry.name];
  if (!make) throw new Error(`no distribution ${entry.name}`);
  const d = make(...entry.params);
  const method = entry.method;
  if (method === 'pmf') {
    if (!('pmf' in d)) throw new Error(`${entry.name} has no pmf`);
    return ([x]) => d.pmf(x ?? Number.NaN);
  }
  if (method === 'pdf') {
    if (!('pdf' in d)) throw new Error(`${entry.name} has no pdf`);
    return ([x]) => d.pdf(x ?? Number.NaN);
  }
  if (method === 'cdf' || method === 'sf' || method === 'quantile') return ([x]) => d[method](x ?? Number.NaN);
  throw new Error(`unknown method ${method}`);
}

const keyOf = (entry: Entry): string => (entry.name in SPECIAL ? entry.name : `${entry.name}.${entry.method}`);

/** The worst point of a group: its error, and a description that names the case. */
function worst(entries: readonly Entry[], bound: Bound): { error: number; at: string; points: number } {
  let error = 0;
  let at = '';
  let points = 0;
  for (const entry of entries) {
    const f = evaluator(entry);
    for (const point of entry.points) {
      const args = point.slice(0, -1);
      const want = point.at(-1) ?? Number.NaN;
      points++;
      let got: number;
      try {
        got = f(args);
      } catch (error_) {
        return {
          error: Infinity,
          at: `${entry.name}(${entry.params.join(', ')}) ${entry.method}(${args.join(', ')}) threw ${String(error_)}`,
          points,
        };
      }
      const difference = Math.abs(got - want);
      const e = bound === 'exact' || 'absolute' in bound || want === 0 ? difference : difference / Math.abs(want);
      if (!(e <= error)) {
        error = Number.isNaN(e) ? Infinity : e;
        at = `${entry.name}(${entry.params.join(', ')}) ${entry.method}(${args.join(', ')}): got ${got}, want ${want}`;
      }
    }
  }
  return { error, at, points };
}

const groups = new Map<string, Entry[]>();
for (const entry of fixture.entries) groups.set(keyOf(entry), [...(groups.get(keyOf(entry)) ?? []), entry]);

describe('distributions and special functions against mpmath', () => {
  it('has a published bound for every reference group, and a reference group for every bound', () => {
    expect([...groups.keys()].toSorted()).toEqual(Object.keys(BOUNDS).toSorted());
  });

  for (const [key, entries] of groups) {
    const bound = BOUNDS[key] ?? 'exact';
    const label =
      bound === 'exact'
        ? 'exact'
        : 'relative' in bound
          ? `≤ ${bound.relative} relative`
          : `≤ ${bound.absolute} absolute`;
    it(`${key}: ${label}`, () => {
      const { error, at, points } = worst(entries, bound);
      expect(points).toBeGreaterThan(0);
      const limit = bound === 'exact' ? 0 : 'relative' in bound ? bound.relative : bound.absolute;
      expect(error <= limit, `max error ${error.toExponential(2)} at ${at}`).toBe(true);
    });
  }
});
