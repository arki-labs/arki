import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { mean, percentileRank, quantile, QUANTILE_METHODS, variance } from './stats.js';

// Seeded, so every run checks the same cases and a failure prints a replayable seed and path.
// For a deep run raise the case count: MATH_PROPERTY_RUNS=20000 bun run test.
// The package compiles without Node types (it runs on every runtime); the test runner is Node.
declare const process: { readonly env: Readonly<Record<string, string | undefined>> };
const RUNS = Math.max(300, Number(process.env.MATH_PROPERTY_RUNS) || 0);
const config = { seed: 20_261_014, numRuns: RUNS };

const valueArb = fc.oneof(fc.integer({ min: -20, max: 20 }), fc.double({ min: -1e6, max: 1e6, noNaN: true }));
const sampleArb = fc.array(valueArb, { minLength: 2, maxLength: 50 });
const factorArb = fc.oneof(fc.integer({ min: -10, max: 10 }), fc.double({ min: -1e3, max: 1e3, noNaN: true }));

const largest = (values: readonly number[]): number => values.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

describe('stats properties', () => {
  it('mean is shift and scale equivariant: mean(a·x + b) ≈ a·mean(x) + b', () => {
    fc.assert(
      fc.property(sampleArb, factorArb, factorArb, (values, a, b) => {
        const actual = mean(values.map(v => a * v + b));
        const expected = a * mean(values) + b;
        const scale = Math.abs(a) * largest(values) + Math.abs(b);
        expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-12 * Math.max(1, scale));
      }),
      config,
    );
  });

  it('variance is ≥ 0, shift invariant and scales by a²', () => {
    fc.assert(
      fc.property(sampleArb, factorArb, factorArb, (values, a, b) => {
        const base = variance(values);
        expect(base).toBeGreaterThanOrEqual(0);
        expect(variance(values, { ddof: 0 })).toBeGreaterThanOrEqual(0);
        const moved = variance(values.map(v => a * v + b));
        // Shifting by b costs |b|·ε of absolute precision per value; that error is squared in the variance.
        const spread = (Math.abs(a) * largest(values) + Math.abs(b)) ** 2;
        expect(Math.abs(moved - a * a * base)).toBeLessThanOrEqual(1e-9 * Math.max(1, spread));
      }),
      config,
    );
  });

  it('a constant sample has variance exactly 0', () => {
    fc.assert(
      fc.property(valueArb, fc.integer({ min: 2, max: 40 }), (value, n) => {
        expect(variance(Array.from({ length: n }, () => value))).toBe(0);
      }),
      config,
    );
  });

  it('quantile is monotonic in q for every method, and stays within [min, max]', () => {
    fc.assert(
      fc.property(
        sampleArb,
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.constantFrom(...QUANTILE_METHODS),
        (values, p, q, method) => {
          const [low, high] = p <= q ? [p, q] : [q, p];
          const a = quantile(values, low, { method });
          const b = quantile(values, high, { method });
          expect(a).toBeLessThanOrEqual(b);
          expect(a).toBeGreaterThanOrEqual(Math.min(...values));
          expect(b).toBeLessThanOrEqual(Math.max(...values));
        },
      ),
      config,
    );
  });

  it("percentileRank 'weak' and quantile 'inverseCdf' are inverse step functions", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -10, max: 10 }), { minLength: 1, maxLength: 40 }),
        fc.integer({ min: -12, max: 12 }),
        (values, score) => {
          // weak rank = share of values ≤ score: the empirical CDF F(score).
          const rank = percentileRank(values, score, { kind: 'weak' });
          const share = values.filter(v => v <= score).length / values.length;
          expect(rank / 100).toBeCloseTo(share, 12);
          // Galois connection: inverseCdf(q) ≤ score ⇔ q ≤ F(score). Steps are ≥ 1/40 wide.
          if (rank > 0)
            expect(quantile(values, rank / 100 - 1e-9, { method: 'inverseCdf' })).toBeLessThanOrEqual(score);
          if (rank < 100) expect(quantile(values, rank / 100 + 1e-9, { method: 'inverseCdf' })).toBeGreaterThan(score);
        },
      ),
      config,
    );
  });

  it('percentileRank is in [0, 100], non-decreasing in the score, and strict ≤ mean ≤ weak', () => {
    fc.assert(
      fc.property(sampleArb, valueArb, valueArb, (values, s, t) => {
        const [low, high] = s <= t ? [s, t] : [t, s];
        for (const kind of ['strict', 'weak', 'mean', 'rank'] as const) {
          const a = percentileRank(values, low, { kind });
          expect(a).toBeGreaterThanOrEqual(0);
          expect(a).toBeLessThanOrEqual(100);
          expect(a).toBeLessThanOrEqual(percentileRank(values, high, { kind }));
        }
        const strict = percentileRank(values, s, { kind: 'strict' });
        const middle = percentileRank(values, s, { kind: 'mean' });
        expect(strict).toBeLessThanOrEqual(middle);
        expect(middle).toBeLessThanOrEqual(percentileRank(values, s, { kind: 'weak' }));
      }),
      config,
    );
  });
});
