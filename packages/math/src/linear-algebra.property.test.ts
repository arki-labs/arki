import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { orThrow } from '@arki/failure';

import type { Matrix } from './linear-algebra.js';
import { Complex } from './complex.js';
import {
  determinant,
  eigenDecompose,
  identity,
  inverse,
  multiply,
  plus,
  solve,
  symmetricEigenDecompose,
  times,
  transpose,
} from './linear-algebra.js';

// Seeded, so every run checks the same cases and a failure prints a replayable seed and path.
// For a deep run raise the case count: MATH_PROPERTY_RUNS=20000 bun run test.
// The package compiles without Node types (it runs on every runtime); the test runner is Node.
declare const process: { readonly env: Readonly<Record<string, string | undefined>> };
const RUNS = Math.max(200, Number(process.env.MATH_PROPERTY_RUNS) || 0);
const config = { seed: 20_261_014, numRuns: RUNS };

function maxAbs(values: readonly number[]): number {
  let largest = 0;
  for (const value of values) largest = Math.max(largest, Math.abs(value));
  return largest;
}

/** Largest absolute entry. */
function size(a: Matrix): number {
  return maxAbs(a.flat());
}

function squareArb(n: number): fc.Arbitrary<number[][]> {
  const entry = fc.oneof(fc.integer({ min: -9, max: 9 }), fc.double({ min: -10, max: 10, noNaN: true }));
  return fc.array(fc.array(entry, { minLength: n, maxLength: n }), { minLength: n, maxLength: n });
}

const sizeArb = fc.integer({ min: 1, max: 6 });

/** Strictly diagonally dominant, so condition numbers stay small (entries ≤ 10, diagonal ≥ 10n + 1 larger). */
const wellConditionedArb = sizeArb.chain(squareArb).map(m => plus(m, times(identity(m.length), 10 * m.length + 1)));

const vectorFor = (n: number): fc.Arbitrary<number[]> =>
  fc.array(fc.double({ min: -100, max: 100, noNaN: true }), { minLength: n, maxLength: n });

describe('linear-algebra properties', () => {
  it('solve(A, A·x) ≈ x for well-conditioned A', () => {
    fc.assert(
      fc.property(
        wellConditionedArb.chain(a => fc.tuple(fc.constant(a), vectorFor(a.length))),
        ([a, x]) => {
          const solved = solve(a, multiply(a, x));
          const error = maxAbs(solved.map((value, i) => value - (x[i] ?? 0)));
          expect(error).toBeLessThanOrEqual(1e-12 * Math.max(1, maxAbs(x)));
        },
      ),
      config,
    );
  });

  it('det(A·B) ≈ det(A) · det(B)', () => {
    fc.assert(
      fc.property(
        sizeArb.chain(n => fc.tuple(squareArb(n), squareArb(n))),
        ([a, b]) => {
          const expected = determinant(a) * determinant(b);
          const actual = determinant(multiply(a, b));
          // Error grows like ‖A‖ⁿ‖B‖ⁿ · ε: compare against that scale, not against the product, which can cancel to 0.
          const n = a.length;
          const scale = (Math.max(1, size(a)) * Math.max(1, size(b)) * n) ** n;
          expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-12 * scale);
        },
      ),
      config,
    );
  });

  it('inverse(inverse(A)) ≈ A and A · A⁻¹ ≈ I for well-conditioned A', () => {
    fc.assert(
      fc.property(wellConditionedArb, a => {
        const back = inverse(inverse(a));
        expect(maxAbs(back.flat().map((value, k) => value - (a.flat()[k] ?? 0)))).toBeLessThanOrEqual(1e-12 * size(a));
        const product = multiply(a, inverse(a));
        const id = identity(a.length);
        expect(maxAbs(product.flat().map((value, k) => value - (id.flat()[k] ?? 0)))).toBeLessThanOrEqual(1e-12);
      }),
      config,
    );
  });

  it('symmetric eigenpairs: A·v ≈ λv, with orthonormal vectors', () => {
    fc.assert(
      fc.property(
        sizeArb.chain(squareArb).map(m => plus(m, transpose(m))),
        a => {
          const { values, vectors } = orThrow(symmetricEigenDecompose(a));
          const scale = Math.max(1, size(a)) * a.length;
          for (const [k, v] of vectors.entries()) {
            const lambda = values[k] ?? Number.NaN;
            const av = multiply(a, v);
            expect(maxAbs(av.map((value, i) => value - lambda * (v[i] ?? 0)))).toBeLessThanOrEqual(1e-12 * scale);
            for (const [j, w] of vectors.entries()) {
              const dot = v.reduce((sum, value, i) => sum + value * (w[i] ?? 0), 0);
              expect(Math.abs(dot - (j === k ? 1 : 0))).toBeLessThanOrEqual(1e-12 * a.length);
            }
          }
          for (let k = 1; k < values.length; k++) expect(values[k - 1] ?? 0).toBeLessThanOrEqual(values[k] ?? 0);
        },
      ),
      config,
    );
  });

  /** The largest `‖A·v − λ·v‖` over all returned eigenpairs, in complex arithmetic. */
  function worstResidual(a: Matrix): number {
    const { values, vectors } = orThrow(eigenDecompose(a));
    expect(values).toHaveLength(a.length);
    let worst = 0;
    for (const [k, v] of vectors.entries()) {
      const lambda = values[k] ?? Complex.from(Number.NaN);
      let norm = 0;
      for (const [i, row] of a.entries()) {
        let av = Complex.from(0);
        for (const [j, entry] of row.entries()) av = av.plus((v[j] ?? Complex.from(Number.NaN)).times(entry));
        worst = Math.max(worst, av.minus(lambda.times(v[i] ?? Complex.from(Number.NaN))).abs());
        norm += (v[i]?.abs() ?? Number.NaN) ** 2;
      }
      expect(Math.abs(Math.sqrt(norm) - 1)).toBeLessThanOrEqual(1e-12);
    }
    return worst;
  }

  /**
   * A = P·D·P⁻¹ with P well conditioned and D block diagonal: real eigenvalues and
   * 2×2 rotation blocks [[a, b], [−b, a]] (eigenvalues a ± bi), all at least 1 apart.
   * Separated eigenvalues keep the eigenvectors well conditioned, so a backward-stable
   * solver must return small residuals.
   */
  const diagonalizableArb = fc
    .uniqueArray(fc.integer({ min: -12, max: 12 }), { minLength: 1, maxLength: 6, selector: x => x })
    .chain(centers =>
      fc.tuple(
        fc.constant(centers),
        fc.array(fc.boolean(), { minLength: centers.length, maxLength: centers.length }),
        fc.array(fc.integer({ min: 1, max: 5 }), { minLength: centers.length, maxLength: centers.length }),
      ),
    )
    .chain(([centers, pairs, spins]) => {
      const blocks: number[][][] = centers.map((c, k) =>
        pairs[k] === true
          ? [
              [c * 3, spins[k] ?? 1],
              [-(spins[k] ?? 1), c * 3],
            ]
          : [[c * 3]],
      );
      const n = blocks.reduce((total, block) => total + block.length, 0);
      const d = identity(n).map(row => row.map(() => 0));
      let offset = 0;
      for (const block of blocks) {
        for (const [i, row] of block.entries())
          for (const [j, x] of row.entries()) (d[offset + i] ?? [])[offset + j] = x;
        offset += block.length;
      }
      // Entries below 1e-12 become 0. An entry far below ε·‖A‖ can make balancing rescale its whole
      // row or column by 2^±70 or more, and then eigenvectors are poor in LAPACK (numpy) too: about 1 draw
      // in 600 without this cutoff, every one of them as bad in numpy. The module docs say so.
      return squareArb(n).map(m => {
        const p = plus(
          m.map(row => row.map(x => (Math.abs(x) < 1e-12 ? 0 : x))),
          times(identity(n), 10 * n + 1),
        );
        // Round-off leaves entries like 1e-29 where P·D·P⁻¹ cancels: such entries, for the same reason.
        const a = multiply(multiply(p, d), inverse(p));
        const cutoff = 1e-12 * size(a);
        return a.map(row => row.map(x => (Math.abs(x) < cutoff ? 0 : x)));
      });
    });

  /**
   * A backward-stable bound: `c · n · ε · ‖A‖` with ‖A‖ the largest entry and c = 16. Over 20,000
   * seeded draws of the property below the worst case reached c ≈ 5.9.
   */
  const bound = (a: Matrix): number => 16 * a.length * Number.EPSILON * Math.max(1, size(a));

  it('general eigenpairs: A·v ≈ λv (complex), unit vectors, for separated eigenvalues', () => {
    fc.assert(
      fc.property(diagonalizableArb, a => {
        expect(worstResidual(a)).toBeLessThanOrEqual(bound(a));
      }),
      config,
    );
  });

  // Found by an earlier version of the property above that drew any random matrix. EISPACK-style
  // balancing left the diagonal out of its row and column norms, so one tiny entry drove the scaling
  // to 1e56 (here) and `x = D·y` blew the round-off in `y` up into eigenvectors with residual ≈ ‖A‖.
  it('regression: a tiny off-diagonal entry must not break eigenDecompose vectors', () => {
    const a = [
      [2, 5, 1],
      [0, 3, 4],
      [1e-100, 0, 7],
    ];
    expect(worstResidual(a)).toBeLessThanOrEqual(bound(a));
  });

  it('regression: subnormal entries must not break eigenDecompose vectors', () => {
    const a = [
      [6, 5e-324, 9e-323],
      [0, -9, 0],
      [0, -0.677_419_354_838_709_6, -30],
    ];
    expect(worstResidual(a)).toBeLessThanOrEqual(bound(a));
  });

  it('regression: a small entry costs eigenDecompose no accuracy', () => {
    const a = [
      [-3, 0, 0, 0, 0, 0],
      [-3.600_000_000_000_396e-11, 9, 0, 0, 0, 0],
      [0.196_721_311_475_409_86, 0, -15, 0, 0, 0],
      [0, 0, 0, 3, 0, 0],
      [0, 0, 0, 0, 0, 0],
      [0, 1.327_868_852_459_016_3, 0, 0, 0, 36],
    ];
    expect(worstResidual(a)).toBeLessThanOrEqual(bound(a));
  });

  // A nearly defective matrix (eigenvalues ≈ ±1e-6·i from a perturbed Jordan block). Balancing rescales
  // by up to 2²⁶ here, which buys about 9 more digits in the eigenvalues (unbalanced, Im λ is off by
  // 1e-11) and costs residual: 2.2e-13, about 250 · n · ε · ‖A‖. LAPACK's dgeev (numpy) gets 2.6e-13.
  it('regression: nearly defective eigenpairs keep a small residual and accurate eigenvalues', () => {
    const a = [
      [0, 1, 0, 0],
      [0, 0, -1, 0],
      [-1e-12, 0, 1, 0],
      [-1, 0, 0, 0],
    ];
    expect(worstResidual(a)).toBeLessThanOrEqual(32 * bound(a));
    // The roots of λ³ − λ² − 1e-12 (mpmath, 50 digits), plus the 0 that column 4 isolates.
    const { values } = orThrow(eigenDecompose(a));
    const exact = [
      Complex.fromParts(-4.999_999_999_99e-13, -9.999_999_999_993_75e-7),
      Complex.fromParts(-4.999_999_999_99e-13, 9.999_999_999_993_75e-7),
      Complex.from(0),
      Complex.from(1.000_000_000_001),
    ];
    for (const [k, value] of values.entries()) {
      expect(value.minus(exact[k]!).abs()).toBeLessThanOrEqual(1e-18 + Number.EPSILON * exact[k]!.abs());
    }
  });

  // Exposed once balancing stopped rescaling these: EISPACK's Hessenberg accumulation divided by the
  // square of a subnormal column scale (0), and its back-substitution divided by a subnormal pivot.
  it('regression: subnormal columns and pivots give finite eigenvectors', () => {
    for (const a of [
      [
        [30, 0.387_096_774_193_548_4, 1.636_363_636_363_635_8],
        [0, 21, 4.227_272_727_272_727_5],
        [9e-323, -2.129_032_258_064_516, 21],
      ],
      [
        [4e-323, 0],
        [6, -2e-323],
      ],
    ]) {
      expect(worstResidual(a)).toBeLessThanOrEqual(bound(a));
    }
  });
});
