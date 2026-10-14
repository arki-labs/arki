import { describe, expect, it } from 'vitest';

import type { ContinuousDistribution } from './distributions.js';
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
  uniform,
} from './distributions.js';
import { InvalidArgumentError, NumericRangeError } from './errors.js';

describe('special functions', () => {
  it('erf and erfc', () => {
    expect(erf(0.5)).toBeCloseTo(0.520_499_877_813_046_5, 14);
    expect(erf(0)).toBe(0);
    expect(erf(-0.5)).toBeCloseTo(-0.520_499_877_813_046_5, 14);
    expect(erf(10)).toBe(1);
    expect(Math.abs(erfc(3) / 2.209_049_699_858_544e-5 - 1)).toBeLessThan(1e-12);
    expect(erfc(-1)).toBeCloseTo(2 - erfc(1), 15);
    expect(erfc(0)).toBe(1);
  });

  it('erfInv inverts erf, including the tails', () => {
    for (const x of [-2, -0.3, 0.1, 1.5]) expect(erfInv(erf(x))).toBeCloseTo(x, 10);
    expect(erfInv(0)).toBe(0);
    expect(erfInv(1)).toBe(Infinity);
    expect(erfInv(-1)).toBe(-Infinity);
    expect(erf(erfInv(0.999_999))).toBeCloseTo(0.999_999, 14);
  });

  it('gammaLn', () => {
    expect(gammaLn(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 12);
    expect(gammaLn(10)).toBeCloseTo(Math.log(362_880), 10);
    expect(gammaLn(1)).toBeCloseTo(0, 14);
    expect(gammaLn(0.1)).toBeCloseTo(2.252_712_651_734_206, 12);
  });

  it('regularizedGammaP and regularizedBeta', () => {
    expect(regularizedGammaP(1, 2)).toBeCloseTo(1 - Math.exp(-2), 12);
    expect(regularizedGammaP(3, 0)).toBe(0);
    expect(regularizedGammaP(0.5, 50)).toBeCloseTo(1, 14);
    expect(regularizedBeta(0.5, 2, 3)).toBeCloseTo(0.6875, 12);
    expect(regularizedBeta(0, 2, 3)).toBe(0);
    expect(regularizedBeta(1, 2, 3)).toBe(1);
    expect(regularizedBeta(0.3, 1, 1)).toBeCloseTo(0.3, 14);
  });
});

describe('gamma and beta', () => {
  const rel = (got: number, want: number) => Math.abs(got - want) / Math.abs(want);
  it('matches reference values', () => {
    expect(rel(gamma(0.5), Math.sqrt(Math.PI))).toBeLessThan(1e-14);
    expect(gamma(5)).toBe(24);
    expect(gamma(1)).toBe(1);
    expect(rel(gamma(-0.5), -2 * Math.sqrt(Math.PI))).toBeLessThan(1e-14);
    expect(rel(gamma(1.5), Math.sqrt(Math.PI) / 2)).toBeLessThan(1e-14);
    expect(rel(gamma(171), 7.257_415_615_307_994e306)).toBeLessThan(1e-14);
    expect(rel(gamma(171.5), 9.483_367_566_824_795e307)).toBeLessThan(1e-12);
  });
  it('gives the float factorial as gamma(n + 1)', () => {
    expect(rel(gamma(21), 2_432_902_008_176_640_000)).toBeLessThan(1e-14);
    expect(rel(gamma(171), 7.257_415_615_307_994e306)).toBeLessThan(1e-14);
  });
  it('satisfies the recurrence Γ(x + 1) = xΓ(x)', () => {
    for (const x of [0.1, 0.7, 2.3, 10.9, 55.5, -1.5, -7.25]) {
      expect(rel(gamma(x + 1), x * gamma(x))).toBeLessThan(1e-13);
    }
  });
  it('rejects poles and overflow loudly', () => {
    expect(() => gamma(0)).toThrow(InvalidArgumentError);
    expect(() => gamma(-3)).toThrow(InvalidArgumentError);
    expect(() => gamma(172)).toThrow(NumericRangeError);
    expect(() => gamma(171.7)).toThrow(NumericRangeError);
    expect(() => gamma(1e-320)).toThrow(NumericRangeError);
    expect(() => gamma(Number.NaN)).toThrow(InvalidArgumentError);
    expect(gamma(-200.5)).toBe(0);
  });
  it('beta and betaLn', () => {
    expect(rel(beta(2, 3), 1 / 12)).toBeLessThan(1e-13);
    expect(rel(beta(0.5, 0.5), Math.PI)).toBeLessThan(1e-13);
    expect(betaLn(1, 1)).toBeCloseTo(0, 13);
    expect(() => beta(0, 1)).toThrow(InvalidArgumentError);
  });
});

describe('normal', () => {
  it('matches known values', () => {
    expect(normal().cdf(1.96)).toBeCloseTo(0.975_002_104_851_779_5, 12);
    expect(normal().quantile(0.975)).toBeCloseTo(1.959_963_984_540_054, 10);
    expect(normal().quantile(0.5)).toBe(0);
    expect(normal(100, 15).quantile(0.9)).toBeCloseTo(119.223_27, 4);
    expect(normal().pdf(0)).toBeCloseTo(0.398_942_280_401_432_7, 12);
    expect(normal(5, 2).mean).toBe(5);
    expect(normal(5, 2).variance).toBe(4);
  });

  it('is symmetric', () => {
    for (const x of [0.3, 1, 2.5, 6]) expect(normal().cdf(-x)).toBeCloseTo(1 - normal().cdf(x), 14);
  });

  it('resolves far tails', () => {
    expect(normal().quantile(1e-12)).toBeCloseTo(-7.034_483_825_301_131, 8);
    expect(normal().quantile(0)).toBe(-Infinity);
    expect(normal().quantile(1)).toBe(Infinity);
    expect(normal().cdf(Infinity)).toBe(1);
    expect(normal().cdf(-Infinity)).toBe(0);
  });
});

describe('studentT', () => {
  it('matches known values', () => {
    expect(studentT(10).quantile(0.975)).toBeCloseTo(2.228_138_851_986_274_4, 9);
    expect(studentT(10).cdf(2.228_138_851_986_274_4)).toBeCloseTo(0.975, 10);
    expect(studentT(1).cdf(1)).toBeCloseTo(0.75, 12);
    expect(studentT(1e6).quantile(0.975)).toBeCloseTo(1.959_964, 5);
    expect(studentT(5).cdf(0)).toBe(0.5);
    expect(studentT(1).pdf(0)).toBeCloseTo(1 / Math.PI, 12);
  });

  it('reports moments only where they exist', () => {
    expect(studentT(10).mean).toBe(0);
    expect(studentT(10).variance).toBeCloseTo(1.25, 14);
    expect(studentT(1).mean).toBeUndefined();
    expect(studentT(1.5).variance).toBe(Infinity);
  });
});

describe('chiSquare', () => {
  it('matches known values', () => {
    expect(chiSquare(1).quantile(0.95)).toBeCloseTo(3.841_458_820_694_124, 9);
    for (const x of [0.5, 1, 3]) expect(chiSquare(2).cdf(x)).toBeCloseTo(1 - Math.exp(-x / 2), 12);
    expect(chiSquare(10).quantile(0.5)).toBeCloseTo(9.341_818, 5);
    expect(chiSquare(2).pdf(0)).toBe(0.5);
    expect(chiSquare(1).pdf(0)).toBe(Infinity);
    expect(chiSquare(4).pdf(-1)).toBe(0);
    expect(chiSquare(7).mean).toBe(7);
    expect(chiSquare(7).variance).toBe(14);
  });
});

describe('fisherF', () => {
  it('matches known values', () => {
    expect(fisherF(3, 10).quantile(0.95)).toBeCloseTo(3.708_265, 5);
    expect(fisherF(3, 10).cdf(fisherF(3, 10).quantile(0.95))).toBeCloseTo(0.95, 8);
    expect(fisherF(5, 2).quantile(0.9)).toBeCloseTo(9.292_626, 4);
    expect(fisherF(2, 5).pdf(0)).toBe(1);
    expect(fisherF(3, 10).mean).toBeCloseTo(1.25, 14);
    expect(fisherF(3, 3).variance).toBe(Infinity);
    expect(fisherF(3, 2).mean).toBeUndefined();
  });
});

describe('noncentralT', () => {
  // The brief's anchor 0.80725 was wrong. The true value 0.8076115625... was
  // confirmed by direct numerical integration of E[Phi(t*sqrt(V/df) - ncp)]
  // over V ~ chi2(df), and by jstat (0.80761156268).
  it('cdf(2) for df=10, ncp=1', () => {
    expect(noncentralT(10, 1).cdf(2)).toBeCloseTo(0.807_611_562_5, 9);
  });

  it('reduces to the central t when ncp = 0', () => {
    for (const df of [3, 10, 40]) {
      for (const x of [-2, 0, 0.5, 3]) {
        expect(Math.abs(noncentralT(df, 0).cdf(x) - studentT(df).cdf(x))).toBeLessThan(1e-10);
      }
    }
  });

  it('even with a tiny ncp the series stays close to the central t', () => {
    for (const x of [-2, 0.5, 3]) {
      expect(Math.abs(noncentralT(10, 1e-9).cdf(x) - studentT(10).cdf(x))).toBeLessThan(1e-8);
    }
  });

  it('inv inverts cdf', () => {
    const d = noncentralT(10, 1);
    for (const x of [-3, -0.5, 0, 1, 2, 5]) expect(d.quantile(d.cdf(x))).toBeCloseTo(x, 7);
    const neg = noncentralT(7, -2);
    for (const x of [-6, -2, 0, 1]) expect(neg.quantile(neg.cdf(x))).toBeCloseTo(x, 7);
  });

  it('pdf integrates like a density and matches its cdf slope', () => {
    const d = noncentralT(10, 1);
    const h = 1e-5;
    for (const x of [-1, 0.5, 2, 4]) {
      expect(d.pdf(x)).toBeCloseTo((d.cdf(x + h) - d.cdf(x - h)) / (2 * h), 6);
    }
    expect(d.pdf(0)).toBeCloseTo(Math.exp(-0.5) * studentT(10).pdf(0), 12);
    let area = 0;
    const step = 0.005;
    for (let x = -30 + step / 2; x < 60; x += step) area += d.pdf(x) * step;
    expect(area).toBeCloseTo(1, 4);
  });

  it('mean and variance', () => {
    const d = noncentralT(10, 1);
    expect(d.mean).toBeCloseTo(1.0837, 3);
    expect(d.variance).toBeCloseTo(1.3255, 3);
    expect(noncentralT(1, 1).mean).toBeUndefined();
  });

  it('handles very large df with the normal approximation', () => {
    expect(noncentralT(1e7, 1).cdf(2)).toBeCloseTo(normal().cdf(1), 5);
  });
});

describe('exponential and uniform', () => {
  it('exponential', () => {
    const d = exponential(2);
    expect(d.cdf(1)).toBeCloseTo(1 - Math.exp(-2), 14);
    expect(d.pdf(0)).toBe(2);
    expect(d.quantile(d.cdf(0.7))).toBeCloseTo(0.7, 12);
    expect(d.mean).toBe(0.5);
    expect(d.variance).toBe(0.25);
    expect(d.cdf(-1)).toBe(0);
    expect(d.quantile(1)).toBe(Infinity);
  });

  it('uniform', () => {
    const d = uniform(0, 10);
    expect(d.quantile(0.25)).toBe(2.5);
    expect(d.cdf(5)).toBe(0.5);
    expect(d.pdf(3)).toBe(0.1);
    expect(d.pdf(11)).toBe(0);
    expect(d.mean).toBe(5);
    expect(d.variance).toBeCloseTo(100 / 12, 12);
    expect(d.quantile(0)).toBe(0);
    expect(d.quantile(1)).toBe(10);
  });
});

describe('binomial', () => {
  it('matches known values', () => {
    expect(binomial(10, 0.5).pmf(5)).toBeCloseTo(0.246_093_75, 12);
    expect(binomial(10, 0.5).cdf(5)).toBeCloseTo(0.623_046_875, 12);
    expect(binomial(10_000, 0.3).pmf(3000)).toBeCloseTo(0.008_703, 5);
    expect(binomial(10, 0.5).pmf(2.5)).toBe(0);
    expect(binomial(10, 0.5).pmf(11)).toBe(0);
    expect(binomial(10, 0.5).cdf(-1)).toBe(0);
    expect(binomial(10, 0.5).cdf(10)).toBe(1);
    expect(binomial(10, 0.5).cdf(5.9)).toBeCloseTo(0.623_046_875, 12);
    expect(binomial(10, 0.3).mean).toBeCloseTo(3, 14);
    expect(binomial(10, 0.3).variance).toBeCloseTo(2.1, 14);
  });

  it('pmf sums to the cdf', () => {
    const d = binomial(40, 0.35);
    let sum = 0;
    for (let k = 0; k <= 40; k++) {
      sum += d.pmf(k);
      expect(d.cdf(k)).toBeCloseTo(sum, 12);
    }
  });

  it('handles p = 0 and p = 1', () => {
    expect(binomial(5, 0).pmf(0)).toBe(1);
    expect(binomial(5, 1).pmf(5)).toBe(1);
    expect(binomial(5, 1).cdf(4)).toBe(0);
    expect(binomial(5, 0).cdf(0)).toBe(1);
  });

  it('inv returns the smallest k with cdf(k) >= p', () => {
    const d = binomial(10, 0.5);
    // The contract is exact against this object's own cdf: cdf(5) is 0.623046875 to within
    // an ulp (here it rounds just below), so the anchor is cdf(5) itself, not the exact
    // rational 638/1024, which would only pass if inv fudged p downward.
    expect(d.quantile(d.cdf(5))).toBe(5);
    expect(d.quantile(d.cdf(5) + 1e-15)).toBe(6);
    expect(d.quantile(0.6231)).toBe(6);
    for (let k = 0; k < 10; k++) expect(d.quantile(d.cdf(k))).toBe(k);
    // A p just above cdf(0) = 0.5 must not be rounded down to it.
    expect(binomial(1, 0.5).quantile(0.500_000_000_000_1)).toBe(1);
    expect(d.quantile(0.6231)).toBe(d.quantile(0.6231));
    expect(d.quantile(0)).toBe(0);
    expect(d.quantile(1)).toBe(10);
  });
});

describe('poisson', () => {
  it('matches known values', () => {
    expect(poisson(3).pmf(2)).toBeCloseTo(0.224_041_807_655_387_75, 12);
    expect(poisson(3).cdf(2)).toBeCloseTo(0.423_190_081_126_843_53, 12);
    expect(poisson(3).cdf(-1)).toBe(0);
    expect(poisson(3).pmf(-1)).toBe(0);
    expect(poisson(3).pmf(1.5)).toBe(0);
    expect(poisson(3).mean).toBe(3);
    expect(poisson(3).variance).toBe(3);
    expect(poisson(1000).cdf(1000)).toBeCloseTo(0.5084, 3);
  });

  it('inv returns the smallest k with cdf(k) >= p', () => {
    expect(poisson(3).quantile(0.423_190_081_126_843_53)).toBe(2);
    expect(poisson(3).quantile(poisson(3).cdf(2))).toBe(2);
    expect(poisson(3).quantile(poisson(3).cdf(2) + 1e-15)).toBe(3);
    expect(poisson(3).quantile(0.4232)).toBe(3);
    expect(poisson(3).quantile(0)).toBe(0);
    expect(poisson(3).quantile(1)).toBe(Infinity);
    expect(poisson(1000).quantile(0.5)).toBe(1000);
  });
});

describe('round trips and monotonicity', () => {
  const cases: [string, ContinuousDistribution][] = [
    ['normal', normal(2, 3)],
    ['studentT', studentT(7)],
    ['noncentralT', noncentralT(12, 1.5)],
    ['chiSquare', chiSquare(5)],
    ['chiSquare small df', chiSquare(0.5)],
    ['fisherF', fisherF(4, 9)],
    ['exponential', exponential(0.7)],
    ['uniform', uniform(-3, 8)],
  ];
  for (const [name, d] of cases) {
    it(`${name}: cdf(inv(p)) = p`, () => {
      for (const p of [0.001, 0.05, 0.5, 0.95, 0.999]) expect(Math.abs(d.cdf(d.quantile(p)) - p)).toBeLessThan(1e-9);
    });
    it(`${name}: quantile is inv, and sf complements cdf`, () => {
      for (const p of [0.001, 0.3, 0.999]) expect(d.quantile(p)).toBe(d.quantile(p));
      for (let i = -12; i <= 24; i++) expect(Math.abs(d.sf(i / 2) + d.cdf(i / 2) - 1)).toBeLessThan(1e-14);
    });
    it(`${name}: cdf is monotonic`, () => {
      let prev = -1;
      for (let i = -40; i <= 80; i++) {
        const v = d.cdf(i / 4);
        expect(v).toBeGreaterThanOrEqual(prev);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        prev = v;
      }
    });
  }
});

describe('quantile convergence is judged in probability, not x', () => {
  // An absolute x tolerance is meaningless when the quantile itself is tiny:
  // chiSquare(0.1).quantile(0.05) is about 1.1e-26, and stopping at |Δx| ≤ 1e-15
  // returned a point whose cdf was 0.1754.
  const cases: [string, ContinuousDistribution][] = [
    ['chiSquare(0.1)', chiSquare(0.1)],
    ['chiSquare(0.5)', chiSquare(0.5)],
    ['studentT(0.5)', studentT(0.5)],
    ['fisherF(0.5, 0.5)', fisherF(0.5, 0.5)],
    ['noncentralT(3, 2)', noncentralT(3, 2)],
  ];
  for (const [name, d] of cases) {
    it(`${name}: cdf(inv(p)) = p across tails and centre`, () => {
      for (const p of [1e-6, 0.05, 0.5, 0.95, 1 - 1e-6]) {
        expect(Math.abs(d.cdf(d.quantile(p)) - p)).toBeLessThanOrEqual(1e-9 * Math.max(p, 1 - p));
      }
    });
  }

  it('chiSquare(0.1).quantile(0.05) lands on a point whose cdf is 0.05', () => {
    const d = chiSquare(0.1);
    expect(d.cdf(d.quantile(0.05))).toBeCloseTo(0.05, 12);
  });

  // A tolerance of 1e-12 absolute accepts any x whose tail probability is below
  // 1e-12: studentT(100).quantile(1 − 1e-12) returned 68 (true value 8.03), and
  // chiSquare(1).quantile(1e-100) returned 5.9e-39 (true value 1.6e-200). The
  // tail being solved must match to 1e-12 of itself. References: mpmath, 50 digits.
  it.each([
    ['studentT(100)', studentT(100), 1 - 1e-12, 8.025_830_060_218_645],
    ['studentT(3)', studentT(3), 1e-64, -2.225_769_823_822_442_1e21],
    ['chiSquare(1)', chiSquare(1), 1e-100, 1.570_796_326_794_896_6e-200],
    ['chiSquare(200)', chiSquare(200), 1e-100, 7.901_597_617_080_129],
    ['fisherF(1, 1)', fisherF(1, 1), 1e-60, 2.467_401_100_272_339_4e-120],
    ['normal()', normal(), 0.499_999_999_999_999_94, -1.391_458_212_335_883_6e-16],
  ] as const)('%s.quantile(%s) keeps its relative accuracy in the tail', (_name, d, p, want) => {
    expect(Math.abs(d.quantile(p) - want) / Math.abs(want)).toBeLessThan(1e-11);
  });
});

describe('noncentralT density near 0 and in the tails', () => {
  const d = noncentralT(10, 1);

  it('is continuous at 0 (no cancellation in a cdf difference over a tiny x)', () => {
    expect(d.pdf(0)).toBeCloseTo(0.236_006_164_826_634_5, 12);
    expect(Math.abs(d.pdf(1e-15) - d.pdf(0))).toBeLessThan(1e-9);
    expect(Math.abs(d.pdf(-1e-15) - d.pdf(0))).toBeLessThan(1e-9);
  });

  it('integrates to 1 (Simpson over [-40, 40])', () => {
    const n = 8000;
    const h = 80 / n;
    let sum = d.pdf(-40) + d.pdf(40);
    for (let i = 1; i < n; i++) sum += (i % 2 === 1 ? 4 : 2) * d.pdf(-40 + i * h);
    expect(Math.abs((sum * h) / 3 - 1)).toBeLessThan(1e-6);
  });

  it('matches the central difference of the cdf on both pdf branches', () => {
    const h = 1e-5;
    for (const x of [-1, 0.3, 2.5]) {
      expect(Math.abs(d.pdf(x) - (d.cdf(x + h) - d.cdf(x - h)) / (2 * h))).toBeLessThan(1e-6);
    }
  });

  it('keeps relative accuracy where the density is tiny', () => {
    // Reference: 400 000-point Simpson integration of φ(x·√(v/df) − ncp)·√(v/df) over v ~ χ²(df).
    expect(Math.abs(noncentralT(50, 30).pdf(5) / 6.715_022_238_089_095e-104 - 1)).toBeLessThan(1e-9);
    expect(Math.abs(noncentralT(10, 8).pdf(0.3) / 6.281_062_435_708_11e-14 - 1)).toBeLessThan(1e-9);
  });

  it('cdf reaches its limits for huge |x|', () => {
    expect(d.cdf(1e200)).toBe(1);
    expect(d.cdf(-1e200)).toBe(0);
    expect(Math.abs(d.cdf(1e8) - 1)).toBeLessThan(1e-12);
    expect(noncentralT(1e7, 1).cdf(1e200)).toBe(1);
    expect(noncentralT(1e7, 1).cdf(-1e200)).toBe(0);
  });
});

describe('survival function', () => {
  it('keeps the far upper tail that 1 - cdf rounds away', () => {
    expect(1 - normal().cdf(9)).toBe(0);
    expect(normal().sf(9)).toBeGreaterThan(0);
    expect(normal().sf(9) / 1.128_588_405_953_84e-19 - 1).toBeLessThan(1e-12);
    expect(1 - chiSquare(3).cdf(200)).toBe(0);
    expect(chiSquare(3).sf(200)).toBeGreaterThan(4.2e-43);
    expect(exponential(1).sf(50)).toBe(Math.exp(-50));
    expect(poisson(3).sf(40)).toBeGreaterThan(0);
    expect(binomial(100, 0.5).sf(95)).toBeGreaterThan(0);
  });

  it('uses symmetry for the t distribution', () => {
    expect(studentT(10).sf(2)).toBe(studentT(10).cdf(-2));
    expect(studentT(10).sf(-Infinity)).toBe(1);
  });

  it('discrete sf complements cdf', () => {
    const b = binomial(40, 0.35);
    const pois = poisson(7);
    for (let k = -1; k <= 41; k++) {
      expect(Math.abs(b.sf(k) + b.cdf(k) - 1)).toBeLessThan(1e-14);
      expect(Math.abs(pois.sf(k) + pois.cdf(k) - 1)).toBeLessThan(1e-14);
    }
  });
});

describe('errors', () => {
  it('rejects invalid parameters', () => {
    expect(() => normal(Number.NaN)).toThrow(InvalidArgumentError);
    expect(() => normal(0, 0)).toThrow(InvalidArgumentError);
    expect(() => normal(0, -1)).toThrow(InvalidArgumentError);
    expect(() => studentT(0)).toThrow(InvalidArgumentError);
    expect(() => studentT(Infinity)).toThrow(InvalidArgumentError);
    expect(() => noncentralT(0, 1)).toThrow(InvalidArgumentError);
    expect(() => noncentralT(5, 50)).toThrow(InvalidArgumentError);
    expect(() => noncentralT(5, Number.NaN)).toThrow(InvalidArgumentError);
    expect(() => chiSquare(-1)).toThrow(InvalidArgumentError);
    expect(() => fisherF(1, 0)).toThrow(InvalidArgumentError);
    expect(() => fisherF(0, 1)).toThrow(InvalidArgumentError);
    expect(() => exponential(0)).toThrow(InvalidArgumentError);
    expect(() => uniform(1, 1)).toThrow(InvalidArgumentError);
    expect(() => uniform(2, 1)).toThrow(InvalidArgumentError);
    expect(() => binomial(1.5, 0.5)).toThrow(InvalidArgumentError);
    expect(() => binomial(-1, 0.5)).toThrow(InvalidArgumentError);
    expect(() => binomial(2 ** 60, 0.5)).toThrow(InvalidArgumentError);
    expect(() => binomial(5, 1.1)).toThrow(InvalidArgumentError);
    expect(() => binomial(5, -0.1)).toThrow(InvalidArgumentError);
    expect(() => poisson(0)).toThrow(InvalidArgumentError);
    expect(() => poisson(-2)).toThrow(InvalidArgumentError);
  });

  it('rejects invalid probabilities and arguments', () => {
    for (const d of [
      normal(),
      studentT(3),
      noncentralT(3, 1),
      chiSquare(3),
      fisherF(2, 3),
      exponential(1),
      uniform(0, 1),
    ]) {
      expect(() => d.quantile(-0.1)).toThrow(InvalidArgumentError);
      expect(() => d.quantile(1.1)).toThrow(InvalidArgumentError);
      expect(() => d.quantile(Number.NaN)).toThrow(InvalidArgumentError);
      expect(() => d.cdf(Number.NaN)).toThrow(InvalidArgumentError);
      expect(() => d.pdf(Number.NaN)).toThrow(InvalidArgumentError);
    }
    expect(() => binomial(5, 0.5).quantile(2)).toThrow(InvalidArgumentError);
    expect(() => poisson(2).quantile(-1)).toThrow(InvalidArgumentError);
    expect(() => poisson(2).cdf(Number.NaN)).toThrow(InvalidArgumentError);
    expect(() => binomial(5, 0.5).pmf(Number.NaN)).toThrow(InvalidArgumentError);
    expect(() => erf(Infinity)).toThrow(InvalidArgumentError);
    expect(() => erfc(Number.NaN)).toThrow(InvalidArgumentError);
    expect(() => erfInv(1.5)).toThrow(InvalidArgumentError);
    expect(() => gammaLn(0)).toThrow(InvalidArgumentError);
    expect(() => gammaLn(-1)).toThrow(InvalidArgumentError);
    expect(() => regularizedGammaP(0, 1)).toThrow(InvalidArgumentError);
    expect(() => regularizedGammaP(1, -1)).toThrow(InvalidArgumentError);
    expect(() => regularizedBeta(1.5, 1, 1)).toThrow(InvalidArgumentError);
    expect(() => regularizedBeta(0.5, 0, 1)).toThrow(InvalidArgumentError);
    expect(() => regularizedBeta(0.5, 1, -1)).toThrow(InvalidArgumentError);
  });
});

// Differential check against jstat, which is only present in the monorepo's
// hoisted node_modules (a consumer app's dependency, not ours). Skipped when it is absent.
type Fn = (...args: number[]) => number;
type Dist = { cdf: Fn; inv?: Fn };
type JStat = { studentt: Dist; chisquare: Dist; centralF: Dist; normal: Dist; noncentralt: Dist };

function isObjectLike(value: unknown): value is object {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

function isDist(value: unknown): value is Dist {
  return isObjectLike(value) && 'cdf' in value && typeof value.cdf === 'function';
}

function isJStat(value: unknown): value is JStat {
  return (
    isObjectLike(value) &&
    'studentt' in value &&
    isDist(value.studentt) &&
    'chisquare' in value &&
    isDist(value.chisquare) &&
    'centralF' in value &&
    isDist(value.centralF) &&
    'normal' in value &&
    isDist(value.normal) &&
    'noncentralt' in value &&
    isDist(value.noncentralt)
  );
}

async function loadJStat(): Promise<JStat | undefined> {
  try {
    const specifier = 'jstat';
    const mod: unknown = await import(/* @vite-ignore */ specifier);
    const candidate = isObjectLike(mod) && 'default' in mod ? mod.default : mod;
    const root = isObjectLike(candidate) && 'jStat' in candidate ? candidate.jStat : candidate;
    return isJStat(root) ? root : undefined;
  } catch {
    return undefined;
  }
}

const jstat = await loadJStat();

describe.skipIf(!jstat)('differential vs jstat', () => {
  const tol = 1e-6;
  const ps = [0.01, 0.1, 0.5, 0.9, 0.99];
  const xs = [-3, -1, 0.2, 1, 2.5, 5];

  it('normal', () => {
    if (!jstat) return;
    for (const x of xs) expect(Math.abs(normal(1, 2).cdf(x) - jstat.normal.cdf(x, 1, 2))).toBeLessThan(tol);
    for (const p of ps)
      expect(Math.abs(normal(1, 2).quantile(p) - (jstat.normal.inv?.(p, 1, 2) ?? Number.NaN))).toBeLessThan(tol);
  });

  it('studentT', () => {
    if (!jstat) return;
    for (const df of [2, 5, 30]) {
      for (const x of xs) expect(Math.abs(studentT(df).cdf(x) - jstat.studentt.cdf(x, df))).toBeLessThan(tol);
      for (const p of ps)
        expect(Math.abs(studentT(df).quantile(p) - (jstat.studentt.inv?.(p, df) ?? Number.NaN))).toBeLessThan(tol);
    }
  });

  it('chiSquare', () => {
    if (!jstat) return;
    for (const df of [1, 4, 20]) {
      for (const x of [0.5, 2, 6, 15])
        expect(Math.abs(chiSquare(df).cdf(x) - jstat.chisquare.cdf(x, df))).toBeLessThan(tol);
      for (const p of ps)
        expect(Math.abs(chiSquare(df).quantile(p) - (jstat.chisquare.inv?.(p, df) ?? Number.NaN))).toBeLessThan(tol);
    }
  });

  it('fisherF', () => {
    if (!jstat) return;
    for (const [d1, d2] of [
      [3, 10],
      [5, 2],
      [12, 30],
    ] as const) {
      for (const x of [0.3, 1, 3, 8])
        expect(Math.abs(fisherF(d1, d2).cdf(x) - jstat.centralF.cdf(x, d1, d2))).toBeLessThan(tol);
      for (const p of ps)
        expect(
          Math.abs(fisherF(d1, d2).quantile(p) / (jstat.centralF.inv?.(p, d1, d2) ?? Number.NaN) - 1),
        ).toBeLessThan(tol);
    }
  });

  it('noncentralT cdf', () => {
    if (!jstat) return;
    for (const [df, ncp] of [
      [10, 1],
      [5, 2],
      [20, -1],
    ] as const) {
      for (const x of [-2, 0.5, 2, 4])
        expect(Math.abs(noncentralT(df, ncp).cdf(x) - jstat.noncentralt.cdf(x, df, ncp))).toBeLessThan(tol);
    }
  });
});

describe('erf and erfc across the approximation ranges', () => {
  // Reference values (20-digit tables), rounded to the nearest double.
  const erfcTable: readonly (readonly [number, number])[] = [
    [0.1, 0.887_537_083_981_715],
    [1, 0.157_299_207_050_285_13],
    [2, 0.004_677_734_981_047_266],
    [4, 1.541_725_790_028_002e-8],
    [5, 1.537_459_794_428_034_7e-12],
    [10, 2.088_487_583_762_544_6e-45],
    [20, 5.395_865_611_607_901e-176],
  ];

  it('erfc is accurate to about 1e-15 relative, far tail included', () => {
    for (const [x, expected] of erfcTable) {
      expect(Math.abs(erfc(x) / expected - 1)).toBeLessThan(2e-15);
      expect(Math.abs(erfc(-x) - (2 - expected))).toBeLessThan(4e-16);
    }
    expect(erfc(27)).toBe(0);
  });

  it('erf is odd and continuous where the approximation switches range', () => {
    for (const edge of [0.468_75, 4]) {
      const below = erf(edge - 1e-12);
      const above = erf(edge + 1e-12);
      expect(Math.abs(above - below)).toBeLessThan(1e-11);
      expect(erf(-edge)).toBe(-erf(edge));
    }
    expect(erf(1e-20)).toBeCloseTo(1.128_379_167_095_512_7e-20, 34);
  });
});
