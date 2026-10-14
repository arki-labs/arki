import { describe, expect, it } from 'vitest';

import type { Matrix, Vector } from './linear-algebra.js';
import { Complex, complex } from './complex.js';
import {
  DivisionByZeroError,
  InvalidArgumentError,
  MathError,
  NotPositiveDefiniteError,
  NumericRangeError,
  ResourceLimitError,
  SingularMatrixError,
} from './errors.js';
import {
  angleBetween,
  choleskyDecompose,
  choleskySolve,
  conditionNumber,
  cross,
  determinant,
  dot,
  eigenDecompose,
  eigenvalues,
  identity,
  inverse,
  leastSquares,
  luDecompose,
  matrix,
  minus,
  multiply,
  norm,
  normalize,
  plus,
  projection,
  pseudoInverse,
  qrDecompose,
  rank,
  singularValueDecompose,
  singularValues,
  solve,
  symmetricEigenDecompose,
  symmetricEigenvalues,
  times,
  trace,
  transpose,
} from './linear-algebra.js';
import { polynomialRoots } from './polynomial.js';
import { createRandom } from './random.js';

/** Hilbert matrix H[i][j] = 1/(i+j+1): the textbook ill-conditioned matrix (cond∞(H₁₀) ≈ 3.5e13). */
function hilbert(n: number): number[][] {
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => 1 / (i + j + 1)));
}

/** Strang, Introduction to Linear Algebra §2.2: A·[1, 1, 2] = [5, −2, 9], pivots 2, −8, 1 → det −16. */
const STRANG: Matrix = [
  [2, 1, 1],
  [4, -6, 0],
  [-2, 7, 2],
];

/** Rows in arithmetic progression: row 3 = 2·row 2 − row 1, so rank 2 and det 0. */
const SINGULAR: Matrix = [
  [1, 2, 3],
  [4, 5, 6],
  [7, 8, 9],
];

function expectClose(actual: readonly number[], expected: readonly number[], tolerance: number): void {
  expect(actual).toHaveLength(expected.length);
  for (const [i, x] of actual.entries())
    expect(Math.abs(x - (expected[i] ?? Number.NaN))).toBeLessThanOrEqual(tolerance);
}

function expectMatrixClose(actual: Matrix, expected: Matrix, tolerance: number): void {
  expect(actual).toHaveLength(expected.length);
  for (const [i, row] of actual.entries()) expectClose(row, expected[i] ?? [], tolerance);
}

describe('vectors', () => {
  it('dot multiplies pairwise and sums', () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
    // Perpendicular vectors have a zero dot product, and never -0.
    expect(Object.is(dot([1, 0], [-0, 1]), 0)).toBe(true);
  });

  it('dot rejects different lengths instead of reading undefined as NaN', () => {
    expect(() => dot([1, 2], [1, 2, 3])).toThrow(InvalidArgumentError);
  });

  it('dot reports overflow rather than returning NaN from Infinity − Infinity', () => {
    expect(() => dot([1e300, 1e300], [1e300, -1e300])).toThrow(NumericRangeError);
  });

  it('cross follows the right-hand rule and is perpendicular to both inputs', () => {
    expect(cross([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1]);
    expect(cross([0, 1, 0], [1, 0, 0])).toEqual([0, 0, -1]);
    const c = cross([1, 2, 3], [4, 5, 6]);
    expect(c).toEqual([-3, 6, -3]);
    expect(dot(c, [1, 2, 3])).toBe(0);
    expect(dot(c, [4, 5, 6])).toBe(0);
  });

  it('cross is only defined in three dimensions', () => {
    expect(() => cross([1, 0], [0, 1])).toThrow(InvalidArgumentError);
  });

  it('norm defaults to Euclidean length and supports p = 1, Infinity and general p', () => {
    expect(norm([3, 4])).toBe(5);
    expect(norm([3, -4], 1)).toBe(7);
    expect(norm([3, -4], Infinity)).toBe(4);
    // (1³ + 2³)^(1/3) = 9^(1/3)
    expect(norm([1, 2], 3)).toBeCloseTo(Math.cbrt(9), 14);
    expect(norm([0, 0])).toBe(0);
  });

  it('norm scales first, so huge and tiny components neither overflow nor underflow', () => {
    // Naively, 3e200² overflows to Infinity and 3e-200² underflows to 0.
    expect(norm([3e200, 4e200]) / 5e200).toBeCloseTo(1, 14);
    expect(norm([3e-200, 4e-200]) / 5e-200).toBeCloseTo(1, 14);
  });

  it('norm rejects p below 1, where the triangle inequality fails', () => {
    expect(() => norm([1, 1], 0.5)).toThrow(InvalidArgumentError);
    expect(() => norm([1, 1], Number.NaN)).toThrow(InvalidArgumentError);
  });

  it('normalize gives a unit vector and refuses the zero vector', () => {
    expect(normalize([3, 4])).toEqual([0.6, 0.8]);
    expect(() => normalize([0, 0, 0])).toThrow(DivisionByZeroError);
  });

  it('angleBetween covers right, parallel and opposite angles', () => {
    expect(angleBetween([1, 0], [0, 1])).toBe(Math.PI / 2);
    expect(angleBetween([2, 0], [5, 0])).toBe(0);
    expect(angleBetween([1, 0], [-1, 0])).toBe(Math.PI);
    expect(() => angleBetween([0, 0], [1, 0])).toThrow(DivisionByZeroError);
  });

  it('angleBetween stays accurate for nearly parallel vectors, where acos(cos θ) returns 0', () => {
    // cos(1e-10) rounds to exactly 1 in float64, so the naive formula loses the angle entirely.
    expect(Math.acos(dot(normalize([1, 0]), normalize([1, 1e-10])))).toBe(0);
    expect(angleBetween([1, 0], [1, 1e-10])).toBeCloseTo(1e-10, 22);
  });

  it('projection keeps the component of v along onto', () => {
    expect(projection([2, 3], [1, 0])).toEqual([2, 0]);
    expect(projection([1, 1], [2, 2])).toEqual([1, 1]);
    // v − proj is perpendicular to onto.
    const v = [3, 1, 2];
    const onto = [1, 2, 2];
    expect(dot(minus(v, projection(v, onto)), onto)).toBeCloseTo(0, 14);
    expect(() => projection([1, 2], [0, 0])).toThrow(DivisionByZeroError);
  });

  it('plus, minus and times work element-wise on vectors', () => {
    expect(plus([1, 2], [3, 4])).toEqual([4, 6]);
    expect(minus([1, 2], [3, 4])).toEqual([-2, -2]);
    expect(times([1, -2], 3)).toEqual([3, -6]);
    expect(Object.is(times([0], -1)[0], 0)).toBe(true);
    expect(() => plus([1], [1, 2])).toThrow(InvalidArgumentError);
  });
});

describe('validation', () => {
  it('rejects empty, ragged and non-finite input with a typed error', () => {
    expect(() => dot([], [])).toThrow(InvalidArgumentError);
    expect(() => matrix([])).toThrow(InvalidArgumentError);
    expect(() => matrix([[]])).toThrow(InvalidArgumentError);
    expect(() => matrix([[1, 2], [3]])).toThrow(InvalidArgumentError);
    expect(() => matrix([[1, Number.NaN]])).toThrow(InvalidArgumentError);
    expect(() => dot([1, Infinity], [1, 1])).toThrow(InvalidArgumentError);
  });

  it('rejects mixing a vector with a matrix', () => {
    const v: Vector = [1, 2];
    const m: Matrix = [[1, 2]];
    // Plain-JS callers bypass the overloads; they get a clear error, not garbage.
    // @ts-expect-error a matrix plus a vector matches no overload
    expect(() => plus(m, v)).toThrow(InvalidArgumentError);
    // @ts-expect-error a vector plus a matrix matches no overload
    expect(() => plus(v, m)).toThrow(InvalidArgumentError);
  });

  it('every error is a MathError, so one catch covers the family', () => {
    expect(() => solve(SINGULAR, [1, 2, 3])).toThrow(MathError);
    expect(() => trace([[1, 2]])).toThrow(MathError);
  });
});

describe('results never alias inputs', () => {
  it('returns fresh arrays the caller can mutate safely', () => {
    const a = [
      [1, 2],
      [3, 4],
    ];
    const copy = matrix(a);
    copy[0]![0] = 99;
    expect(a[0]![0]).toBe(1);
    expect(copy[0]).not.toBe(a[0]);

    const lu = luDecompose(a);
    lu.upper[0]![0] = 99;
    solve(a, [1, 1]);
    inverse(a);
    rank(a);
    determinant(a);
    expect(a).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });
});

describe('matrix basics', () => {
  it('identity, transpose and trace', () => {
    expect(identity(3)).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    expect(transpose([[1, 2, 3]])).toEqual([[1], [2], [3]]);
    expect(trace(STRANG)).toBe(-2);
    expect(() => identity(0)).toThrow(InvalidArgumentError);
    expect(() => identity(1.5)).toThrow(InvalidArgumentError);
    expect(() => identity(1e5)).toThrow(ResourceLimitError);
  });

  it('plus, minus and times work element-wise on matrices of the same shape', () => {
    expect(plus([[1, 2]], [[3, 4]])).toEqual([[4, 6]]);
    expect(minus([[1, 2]], [[3, 4]])).toEqual([[-2, -2]]);
    expect(times([[1, 2]], 2)).toEqual([[2, 4]]);
    expect(() => plus([[1, 2]], [[1], [2]])).toThrow(InvalidArgumentError);
  });

  it('multiply follows (m×n)·(n×p) = m×p and does not commute', () => {
    const a = [
      [1, 2],
      [3, 4],
    ];
    const b = [
      [0, 1],
      [1, 0],
    ];
    expect(multiply(a, b)).toEqual([
      [2, 1],
      [4, 3],
    ]);
    expect(multiply(b, a)).toEqual([
      [3, 4],
      [1, 2],
    ]);
    expect(multiply([[1, 2, 3]], [[1], [2], [3]])).toEqual([[14]]);
    expect(multiply(STRANG, identity(3))).toEqual(STRANG);
    expect(() => multiply([[1, 2]], [[1, 2]])).toThrow(InvalidArgumentError);
  });

  it('multiply adds every term for any inner size, not only multiples of four', () => {
    // The product loop takes four rows of b per sweep; the remainder must still count.
    for (const size of [1, 3, 4, 5, 7, 8, 9]) {
      const row = Array.from({ length: size }, (_, k) => k + 1);
      const column = row.map(value => [value, -value]);
      const sumOfSquares = (size * (size + 1) * (2 * size + 1)) / 6;
      expect(multiply([row], column)).toEqual([[sumOfSquares, -sumOfSquares]]);
    }
  });

  it('multiply gives the same product however the input arrays were built', () => {
    // b is copied into typed storage; holey, spread and mapped arrays must all read the same.
    const a = [
      [1.5, -2, 0, 4, 0.25],
      [3, 1, -1, 2, 8],
    ];
    const b = [
      [1, 2],
      [0.5, -1],
      [2, 2],
      [-3, 0],
      [4, 0.125],
    ];
    const expected = multiply(a, b);
    const holey = b.map(row => {
      const copy: number[] = [];
      copy[1] = row[1]!;
      copy[0] = row[0]!;
      return copy;
    });
    expect(multiply(a, holey)).toEqual(expected);
    expect(
      multiply(
        a.map(row => [...row]),
        b.map(row => row.map(value => value)),
      ),
    ).toEqual(expected);
  });

  it('multiply by a vector gives the matrix-vector product', () => {
    expect(multiply(STRANG, [1, 1, 2])).toEqual([5, -2, 9]);
    expect(() => multiply(STRANG, [1, 2])).toThrow(InvalidArgumentError);
  });
});

describe('luDecompose', () => {
  it('reconstructs P·A = L·U with |multipliers| ≤ 1 from partial pivoting', () => {
    const { lower, upper, permutation, sign } = luDecompose(STRANG);
    // Partial pivoting picks 4 (the largest |entry| in column 0) over Strang's 2.
    expect(permutation).toEqual([1, 0, 2]);
    expect(sign).toBe(-1);
    const permuted = permutation.map(i => STRANG[i] ?? []);
    expectMatrixClose(multiply(lower, upper), permuted, 1e-15);
    for (const [i, row] of lower.entries()) {
      expect(row[i]).toBe(1);
      for (const x of row) expect(Math.abs(x)).toBeLessThanOrEqual(1);
    }
  });

  it('does not throw for a singular matrix', () => {
    expect(() => luDecompose(SINGULAR)).not.toThrow();
  });
});

describe('determinant', () => {
  it('matches the product of Strang’s pivots', () => {
    expect(determinant(STRANG)).toBe(-16);
    expect(determinant([[5]])).toBe(5);
    expect(determinant(identity(4))).toBe(1);
  });

  it('flips sign under a single row swap, the bookkeeping partial pivoting must track', () => {
    const swapped = [STRANG[1] ?? [], STRANG[0] ?? [], STRANG[2] ?? []];
    expect(determinant(swapped)).toBe(16);
  });

  it('is exactly 0 when a column is zero, and tiny (not thrown) for a numerically singular matrix', () => {
    expect(
      determinant([
        [0, 1],
        [0, 2],
      ]),
    ).toBe(0);
    // NumPy/LAPACK np.linalg.det([[1,2,3],[4,5,6],[7,8,9]]) = 6.661338147750939e-16, the same LU rounding.
    expect(determinant(SINGULAR)).toBe(6.661_338_147_750_939e-16);
  });

  it('matches the exact Hilbert determinants to the precision their conditioning allows', () => {
    // det(H₃) = 1/2160, det(H₆) = 1/186313420339200000 (closed form via Cauchy determinants).
    expect(determinant(hilbert(3)) * 2160).toBeCloseTo(1, 13);
    expect(determinant(hilbert(6)) * 186_313_420_339_200_000).toBeCloseTo(1, 8);
  });

  it('reports overflow instead of returning Infinity', () => {
    expect(() => determinant(times(identity(3), 1e200))).toThrow(NumericRangeError);
  });
});

describe('solve', () => {
  it('solves Strang’s system exactly', () => {
    expect(solve(STRANG, [5, -2, 9])).toEqual([1, 1, 2]);
  });

  it('solves several right-hand sides given as matrix columns', () => {
    // Columns: b₁ = A·[1,1,2], b₂ = A·[1,0,0] (the first column of A).
    const b = [
      [5, 2],
      [-2, 4],
      [9, -2],
    ];
    expectMatrixClose(
      solve(STRANG, b),
      [
        [1, 1],
        [1, 0],
        [2, 0],
      ],
      1e-15,
    );
  });

  it('needs pivoting: a zero in the top-left corner does not stop it', () => {
    expect(
      solve(
        [
          [0, 1],
          [1, 0],
        ],
        [2, 3],
      ),
    ).toEqual([3, 2]);
  });

  it('rejects an exactly singular matrix with SingularMatrixError', () => {
    expect(() => solve(SINGULAR, [1, 2, 3])).toThrow(SingularMatrixError);
    expect(() =>
      solve(
        [
          [0, 0],
          [0, 0],
        ],
        [1, 1],
      ),
    ).toThrow(SingularMatrixError);
  });

  it('rejects a matrix singular to working precision: pivot below n·ε·‖A‖∞', () => {
    // 1 + 4e-16 rounds to 1 + 2ε; the second pivot 2ε ≈ 4.4e-16 is under 2·ε·2 ≈ 8.9e-16.
    const nearlySingular = [
      [1, 1],
      [1, 1 + 4e-16],
    ];
    expect(() => solve(nearlySingular, [2, 2])).toThrow(SingularMatrixError);
    // An explicit absolute tolerance of 0 accepts any non-zero pivot.
    expect(solve(nearlySingular, [2, 2], { tolerance: 0 })).toEqual([2, 0]);
    expect(() => solve(nearlySingular, [2, 2], { tolerance: -1 })).toThrow(InvalidArgumentError);
  });

  it('is backward stable on Hilbert matrices: tiny residual even when the error grows with conditioning', () => {
    for (const n of [6, 10]) {
      const h = hilbert(n);
      const ones = Array.from({ length: n }, () => 1);
      const b = multiply(h, ones);
      const x = solve(h, b);
      // Residual ‖H·x − b‖∞ stays at rounding level (≈ ε·‖H‖·‖x‖) regardless of n.
      expect(norm(minus(multiply(h, x), b), Infinity)).toBeLessThan(1e-14);
      // Forward error is bounded by roughly cond(H)·ε: ≈ 2.9e7·ε for H₆, ≈ 3.5e13·ε for H₁₀.
      const error = norm(minus(x, ones), Infinity);
      expect(error).toBeLessThan(n === 6 ? 1e-8 : 1e-2);
    }
  });

  it('refuses H₁₂, whose condition number (≈ 1.7e16) exceeds 1/ε', () => {
    expect(() =>
      solve(
        hilbert(12),
        Array.from({ length: 12 }, () => 1),
      ),
    ).toThrow(SingularMatrixError);
  });

  it('rejects non-square A and a mismatched b', () => {
    expect(() => solve([[1, 2]], [1])).toThrow(InvalidArgumentError);
    expect(() => solve(STRANG, [1, 2])).toThrow(InvalidArgumentError);
  });
});

describe('inverse', () => {
  it('matches the exact integer inverse of H₃', () => {
    // H₃⁻¹ has integer entries (Hilbert inverses always do).
    expectMatrixClose(
      inverse(hilbert(3)),
      [
        [9, -36, 30],
        [-36, 192, -180],
        [30, -180, 180],
      ],
      1e-12,
    );
  });

  it('A·A⁻¹ = I', () => {
    expectMatrixClose(multiply(STRANG, inverse(STRANG)), identity(3), 1e-15);
  });

  it('throws SingularMatrixError for a singular matrix', () => {
    expect(() => inverse(SINGULAR)).toThrow(SingularMatrixError);
  });
});

describe('rank', () => {
  it('counts independent rows, for square and rectangular matrices', () => {
    expect(rank(STRANG)).toBe(3);
    expect(rank(SINGULAR)).toBe(2);
    expect(rank([[1, 2, 3]])).toBe(1);
    expect(rank([[1], [2], [3]])).toBe(1);
    expect(
      rank([
        [0, 0],
        [0, 0],
      ]),
    ).toBe(0);
    expect(
      rank([
        [1, 2, 3, 4],
        [2, 4, 6, 8],
        [0, 0, 1, 1],
      ]),
    ).toBe(2);
  });

  it('treats rounding noise as zero by default, and honours an explicit tolerance', () => {
    const nearlyDependent = [
      [1, 1],
      [1, 1 + 1e-10],
    ];
    expect(rank(nearlyDependent)).toBe(2);
    expect(rank(nearlyDependent, { tolerance: 1e-8 })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Eigenvalues

/** Seeded n×n matrix with entries uniform in [-1, 1). */
function randomMatrix(seed: number, n: number): number[][] {
  const random = createRandom(seed);
  return Array.from({ length: n }, () => Array.from({ length: n }, () => random.float(-1, 1)));
}

/** Seeded symmetric n×n matrix (A + Aᵀ)/2, exactly symmetric. */
function randomSymmetric(seed: number, n: number): number[][] {
  const a = randomMatrix(seed, n);
  return a.map((row, i) => row.map((x, j) => (x + a[j]![i]!) / 2));
}

/** Frobenius norm ‖A‖_F. */
function frobenius(a: Matrix): number {
  return Math.sqrt(a.flat().reduce((sum, x) => sum + x * x, 0));
}

/** max_i |(A·v − λ·v)_i| for a complex eigenpair. */
function residual(a: Matrix, value: Complex, vector: readonly Complex[]): number {
  let worst = 0;
  for (const [i, row] of a.entries()) {
    let sum = Complex.ZERO;
    for (const [j, x] of row.entries()) sum = sum.plus(vector[j]!.times(x));
    worst = Math.max(worst, sum.minus(value.times(vector[i]!)).abs());
  }
  return worst;
}

/** max_i |(A·v − λ·v)_i| for a real eigenpair. */
function realResidual(a: Matrix, value: number, vector: Vector): number {
  return Math.max(...multiply(a, vector).map((x, i) => Math.abs(x - value * vector[i]!)));
}

/** Companion matrix of a monic-normalized polynomial (highest degree first): its eigenvalues are the roots. */
function companion(coefficients: readonly number[]): number[][] {
  const [lead = 1, ...rest] = coefficients;
  const n = rest.length;
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === 0 ? -rest[j]! / lead : i === j + 1 ? 1 : 0)),
  );
}

const parts = (values: readonly Complex[]): [number, number][] => values.map(z => [z.re, z.im]);

describe('symmetricEigenvalues / symmetricEigenDecompose', () => {
  it('a diagonal matrix: the eigenvalues are the diagonal (ascending, exact) and the vectors the standard basis', () => {
    // Nothing to rotate away, so no rounding may creep in.
    const { values, vectors } = symmetricEigenDecompose([
      [3, 0, 0],
      [0, -1, 0],
      [0, 0, 2],
    ]);
    expect(values).toEqual([-1, 2, 3]);
    expect(vectors).toEqual([
      [0, 1, 0],
      [0, 0, 1],
      [1, 0, 0],
    ]);
    expect(symmetricEigenvalues([[-7]])).toEqual([-7]);
  });

  it('the second-difference matrix tridiag(−1, 2, −1): λ = 2 − √2, 2, 2 + √2 (Strang §6.4)', () => {
    const a: Matrix = [
      [2, -1, 0],
      [-1, 2, -1],
      [0, -1, 2],
    ];
    const { values, vectors } = symmetricEigenDecompose(a);
    const expected = [2 - Math.SQRT2, 2, 2 + Math.SQRT2];
    for (const [k, value] of values.entries()) expect(value).toBeCloseTo(expected[k]!, 14);
    expect(symmetricEigenvalues(a)).toEqual(values);
    // v₁ = (1, √2, 1)/2 and v₃ = (1, −√2, 1)/2 up to sign; the sign rule makes the largest entry positive.
    const v1 = vectors[0]!;
    const v3 = vectors[2]!;
    for (const [i, x] of [0.5, Math.SQRT1_2, 0.5].entries()) expect(v1[i]).toBeCloseTo(x, 14);
    for (const [i, x] of [-0.5, Math.SQRT1_2, -0.5].entries()) expect(v3[i]).toBeCloseTo(x, 14);
    // v₂ = (1, 0, −1)/√2: its two largest entries tie, so only check it up to sign.
    expect(Math.abs(vectors[1]![0]!)).toBeCloseTo(Math.SQRT1_2, 14);
    expect(vectors[1]![1]).toBeCloseTo(0, 14);
    expect(vectors[1]![0]! + vectors[1]![2]!).toBeCloseTo(0, 14);
  });

  it('random symmetric matrices: residual ≤ 1e-12·‖A‖, orthonormal vectors, ascending values, Σλ = trace', () => {
    for (const n of [2, 5, 20, 50]) {
      const a = randomSymmetric(1000 + n, n);
      const { values, vectors } = symmetricEigenDecompose(a);
      const size = frobenius(a);
      for (const [k, value] of values.entries()) {
        expect(realResidual(a, value, vectors[k]!)).toBeLessThanOrEqual(1e-12 * size);
        if (k > 0) expect(value).toBeGreaterThanOrEqual(values[k - 1]!);
      }
      // VᵀV = I: the vectors are an orthonormal basis, not just eigenvectors.
      for (const [i, u] of vectors.entries()) {
        for (const [j, w] of vectors.entries()) expect(Math.abs(dot(u, w) - (i === j ? 1 : 0))).toBeLessThan(1e-13);
      }
      expect(values.reduce((sum, x) => sum + x, 0)).toBeCloseTo(trace(a), 11);
      // The values-only path skips the vector work but must agree.
      for (const [k, x] of symmetricEigenvalues(a).entries())
        expect(Math.abs(x - values[k]!)).toBeLessThan(1e-13 * size);
    }
  });

  it('a repeated eigenvalue still gets an orthonormal basis of its eigenspace', () => {
    // J + I with J the all-ones matrix: λ = 1, 1, 4; any orthonormal basis of x₁+x₂+x₃ = 0 is right for λ = 1.
    const a: Matrix = [
      [2, 1, 1],
      [1, 2, 1],
      [1, 1, 2],
    ];
    const { values, vectors } = symmetricEigenDecompose(a);
    expect(values[0]).toBeCloseTo(1, 14);
    expect(values[1]).toBeCloseTo(1, 14);
    expect(values[2]).toBeCloseTo(4, 14);
    for (const [k, v] of vectors.entries()) expect(realResidual(a, values[k]!, v)).toBeLessThan(1e-14);
    expect(Math.abs(dot(vectors[0]!, vectors[1]!))).toBeLessThan(1e-15);
    for (const x of vectors[2]!) expect(x).toBeCloseTo(1 / Math.sqrt(3), 15);
  });

  it('2×2 edge case [[1, 2], [2, 4]]: λ = 0 and 5, vectors (2, −1)/√5 and (1, 2)/√5', () => {
    const { values, vectors } = symmetricEigenDecompose([
      [1, 2],
      [2, 4],
    ]);
    expect(values[0]).toBeCloseTo(0, 14);
    expect(values[1]).toBeCloseTo(5, 14);
    const r5 = Math.sqrt(5);
    for (const [i, x] of [2 / r5, -1 / r5].entries()) expect(vectors[0]![i]).toBeCloseTo(x, 14);
    for (const [i, x] of [1 / r5, 2 / r5].entries()) expect(vectors[1]![i]).toBeCloseTo(x, 14);
  });

  it('entries near the float64 limits neither overflow nor underflow (exact power-of-two prescaling)', () => {
    // λ = −1, 3 times the scale; the squares inside the iteration would be 1e600 or 1e-600 unscaled.
    for (const scale of [1e300, 1e-300]) {
      const values = symmetricEigenvalues([
        [scale, 2 * scale],
        [2 * scale, scale],
      ]);
      expect(values[0]! / scale).toBeCloseTo(-1, 14);
      expect(values[1]! / scale).toBeCloseTo(3, 14);
    }
  });

  it('accepts float rounding noise in the symmetry but rejects a real asymmetry', () => {
    const noisy: Matrix = [
      [1, 0.1 + 0.2],
      [0.3, 1],
    ];
    expect(symmetricEigenvalues(noisy)[1]).toBeCloseTo(1.3, 15);
    expect(() => symmetricEigenvalues(noisy, { tolerance: 0 })).toThrow(InvalidArgumentError);
    expect(() =>
      symmetricEigenvalues([
        [1, 2],
        [3, 1],
      ]),
    ).toThrow(InvalidArgumentError);
    expect(
      symmetricEigenvalues(
        [
          [1, 2],
          [2.5, 1],
        ],
        { tolerance: 1 },
      ),
    ).toEqual(
      symmetricEigenvalues([
        [1, 2.25],
        [2.25, 1],
      ]),
    );
    expect(() => symmetricEigenvalues([[1]], { tolerance: -1 })).toThrow(InvalidArgumentError);
  });
});

describe('eigenvalues / eigenDecompose', () => {
  it('a triangular matrix: the eigenvalues are its diagonal (exact when upper triangular, already Schur form)', () => {
    const upper: Matrix = [
      [4, 1, -2],
      [0, -3, 5],
      [0, 0, 1],
    ];
    expect(parts(eigenvalues(upper))).toEqual([
      [-3, 0],
      [1, 0],
      [4, 0],
    ]);
    const lower = transpose(upper);
    for (const [k, z] of eigenvalues(lower).entries()) {
      expect(z.re).toBeCloseTo([-3, 1, 4][k]!, 13);
      expect(z.isReal()).toBe(true);
    }
    const diagonal = eigenDecompose([
      [2, 0],
      [0, -5],
    ]);
    expect(parts(diagonal.values)).toEqual([
      [-5, 0],
      [2, 0],
    ]);
    expect(diagonal.vectors.map(vector => parts(vector))).toEqual([
      [
        [0, 0],
        [1, 0],
      ],
      [
        [1, 0],
        [0, 0],
      ],
    ]);
  });

  it('a rotation by θ has the complex pair cos θ ∓ i·sin θ with vectors (1, ±i)/√2', () => {
    const theta = 0.3;
    const rotation: Matrix = [
      [Math.cos(theta), -Math.sin(theta)],
      [Math.sin(theta), Math.cos(theta)],
    ];
    const { values, vectors } = eigenDecompose(rotation);
    expect(values[0]!.approxEqual(complex(Math.cos(theta), -Math.sin(theta)), 1e-15)).toBe(true);
    expect(values[1]!.approxEqual(complex(Math.cos(theta), Math.sin(theta)), 1e-15)).toBe(true);
    expect(values[0]!.isReal()).toBe(false);
    // Conjugate eigenvalues get conjugate vectors.
    expect(vectors[0]![0]!.approxEqual(complex(Math.SQRT1_2, 0), 1e-15)).toBe(true);
    expect(vectors[0]![1]!.approxEqual(complex(0, Math.SQRT1_2), 1e-15)).toBe(true);
    expect(vectors[1]![1]!.approxEqual(complex(0, -Math.SQRT1_2), 1e-15)).toBe(true);
  });

  it('random general matrices: residual ≤ 1e-12·‖A‖, unit vectors, conjugate pairs, Σλ = trace', () => {
    for (const n of [1, 2, 5, 20, 40]) {
      const a = randomMatrix(2000 + n, n);
      const { values, vectors } = eigenDecompose(a);
      const size = frobenius(a);
      for (const [k, value] of values.entries()) {
        const v = vectors[k]!;
        expect(residual(a, value, v)).toBeLessThanOrEqual(1e-12 * size);
        expect(Math.sqrt(v.reduce((sum, z) => sum + z.abs() ** 2, 0))).toBeCloseTo(1, 14);
        if (value.isReal()) expect(v.every(z => z.isReal())).toBe(true);
      }
      const complexOnes = values.filter(z => !z.isReal());
      // Each complex eigenvalue's conjugate is in the list too.
      for (const z of complexOnes) expect(complexOnes.some(w => w.eq(z.conjugate()))).toBe(true);
      const sum = values.reduce((acc, z) => acc.plus(z), Complex.ZERO);
      expect(sum.re).toBeCloseTo(trace(a), 11);
      expect(sum.im).toBeCloseTo(0, 11);
      // The values-only path (EISPACK hqr) must find the same spectrum.
      for (const [k, z] of eigenvalues(a).entries()) expect(z.minus(values[k]!).abs()).toBeLessThan(1e-11 * size);
    }
  });

  it('the product of the eigenvalues is the determinant', () => {
    const a = randomMatrix(77, 6);
    const product = eigenvalues(a).reduce((acc, z) => acc.times(z), Complex.ONE);
    expect(product.re).toBeCloseTo(determinant(a), 12);
    expect(product.im).toBeCloseTo(0, 12);
  });

  it('a Jordan block keeps its triple eigenvalue; a non-triangular defective matrix gets it to ~√ε', () => {
    expect(
      parts(
        eigenvalues([
          [2, 1, 0],
          [0, 2, 1],
          [0, 0, 2],
        ]),
      ),
    ).toEqual([
      [2, 0],
      [2, 0],
      [2, 0],
    ]);
    // [[1, 1], [−1, 3]] has (λ − 2)² as characteristic polynomial and a single eigenvector (1, 1):
    // a double root perturbed by ε moves by about √ε ≈ 1.5e-8, in every float library.
    const { values, vectors } = eigenDecompose([
      [1, 1],
      [-1, 3],
    ]);
    for (const z of values) expect(z.minus(2).abs()).toBeLessThan(1e-7);
    for (const v of vectors) {
      expect(v[0]!.minus(Math.SQRT1_2).abs()).toBeLessThan(1e-7);
      expect(v[1]!.minus(Math.SQRT1_2).abs()).toBeLessThan(1e-7);
    }
  });

  it('balancing recovers the eigenvalues of a badly scaled matrix to full precision', () => {
    // A = D·T·D⁻¹ with D = diag(1e-10, 1, 1e10) and T = tridiag(−1, 2, −1): same eigenvalues 2 − √2, 2, 2 + √2.
    // Without balancing the error would be about ε·‖A‖ ≈ 2e-6; balancing brings ‖A‖ back to ~4.
    const a: Matrix = [
      [2, -1e-10, 0],
      [-1e10, 2, -1e-10],
      [0, -1e10, 2],
    ];
    const expected = [2 - Math.SQRT2, 2, 2 + Math.SQRT2];
    const { values, vectors } = eigenDecompose(a);
    for (const [k, z] of values.entries()) {
      expect(Math.abs(z.re - expected[k]!)).toBeLessThan(1e-14);
      expect(z.im).toBe(0);
    }
    // The vectors are undone through D as well: A·v = λ·v holds relative to v's own scale.
    for (const [k, v] of vectors.entries()) expect(residual(a, values[k]!, v)).toBeLessThan(1e-12);
  });

  it('a cyclic permutation (where standard shifts stall) converges through the exceptional shifts', () => {
    // Its eigenvalues are the cube roots of unity: 1 and −1/2 ± i·√3/2.
    const roots = eigenvalues([
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
    ]);
    const expected = [complex(-0.5, -Math.sqrt(3) / 2), complex(-0.5, Math.sqrt(3) / 2), complex(1, 0)];
    for (const [k, z] of roots.entries()) expect(z.approxEqual(expected[k]!, 1e-14)).toBe(true);
    // 4-cycle: the fourth roots of unity −1, −i, i, 1.
    const four = eigenvalues([
      [0, 0, 0, 1],
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
    ]);
    for (const [k, w] of [complex(-1, 0), complex(0, -1), complex(0, 1), complex(1, 0)].entries())
      expect(four[k]!.approxEqual(w, 1e-14)).toBe(true);
  });

  it('repeated eigenvalues of a non-symmetric matrix: 5·I and a block-diagonal pair', () => {
    expect(parts(eigenvalues(times(identity(3), 5)))).toEqual([
      [5, 0],
      [5, 0],
      [5, 0],
    ]);
    const { values, vectors } = eigenDecompose([
      [3, 4, 0, 0],
      [-4, 3, 0, 0],
      [0, 0, 3, 4],
      [0, 0, -4, 3],
    ]);
    expect(values.map(z => [z.re, Math.round(z.im)])).toEqual([
      [3, -4],
      [3, -4],
      [3, 4],
      [3, 4],
    ]);
    for (const [k, v] of vectors.entries())
      expect(
        residual(
          identity(4).map(
            (_, i) =>
              [
                [3, 4, 0, 0],
                [-4, 3, 0, 0],
                [0, 0, 3, 4],
                [0, 0, -4, 3],
              ][i]!,
          ),
          values[k]!,
          v,
        ),
      ).toBeLessThan(1e-14);
  });

  it('1×1 and 2×2 edge cases', () => {
    const one = eigenDecompose([[-3]]);
    expect(parts(one.values)).toEqual([[-3, 0]]);
    expect(parts(one.vectors[0]!)).toEqual([[1, 0]]);
    // Companion of x² + 3x + 2 = (x + 1)(x + 2).
    for (const [k, z] of eigenvalues([
      [0, 1],
      [-2, -3],
    ]).entries()) {
      expect(z.re).toBeCloseTo([-2, -1][k]!, 15);
      expect(z.im).toBe(0);
    }
    expect(
      parts(
        eigenvalues([
          [0, 0],
          [0, 0],
        ]),
      ),
    ).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });

  it('the companion matrix of a polynomial has its roots as eigenvalues (agrees with polynomialRoots)', () => {
    // x⁵ − 2x⁴ + 3x³ − 4x² + 5x − 6: one real root, two complex pairs.
    const coefficients = [1, -2, 3, -4, 5, -6];
    const fromRoots = polynomialRoots(coefficients);
    const fromMatrix = eigenvalues(companion(coefficients));
    expect(fromMatrix).toHaveLength(5);
    for (const [k, z] of fromMatrix.entries()) expect(z.minus(fromRoots[k]!).abs()).toBeLessThan(1e-12);
    expect(fromMatrix.filter(z => z.isReal())).toHaveLength(1);
  });
});

describe('eigen solvers: validation and hygiene', () => {
  it('rejects non-square, empty and non-finite input with a typed error', () => {
    for (const solver of [eigenvalues, eigenDecompose, symmetricEigenvalues, symmetricEigenDecompose]) {
      expect(() => solver([[1, 2]])).toThrow(InvalidArgumentError);
      expect(() => solver([])).toThrow(InvalidArgumentError);
      expect(() => solver([[Number.NaN]])).toThrow(InvalidArgumentError);
      expect(() =>
        solver([
          [Infinity, 0],
          [0, 1],
        ]),
      ).toThrow(InvalidArgumentError);
    }
  });

  it('never modifies or aliases the input, and never returns -0', () => {
    const a = [
      [-0, 0],
      [0, -0],
    ];
    const frozen = a.map(row => Object.freeze([...row]));
    const symmetric = symmetricEigenDecompose(frozen);
    const general = eigenDecompose(frozen);
    for (const x of [...symmetric.values, ...symmetric.vectors.flat()]) expect(Object.is(x, -0)).toBe(false);
    for (const z of [...general.values, ...general.vectors.flat()]) {
      expect(Object.is(z.re, -0) || Object.is(z.im, -0)).toBe(false);
    }
    symmetric.vectors[0]![0] = 99;
    expect(frozen).toEqual([
      [-0, 0],
      [0, -0],
    ]);
    const b = randomMatrix(5, 4);
    const copy = b.map(row => [...row]);
    eigenDecompose(b);
    eigenvalues(b);
    expect(b).toEqual(copy);
  });
});

// ---------------------------------------------------------------------------
// QR, Cholesky, SVD, least squares

const EPSILON = Number.EPSILON;

/** Seeded m×n matrix with entries uniform in [-1, 1). */
function randomRectangular(seed: number, m: number, n: number): number[][] {
  const random = createRandom(seed);
  return Array.from({ length: m }, () => Array.from({ length: n }, () => random.float(-1, 1)));
}

/** Seeded symmetric positive definite n×n matrix BᵀB + I. */
function randomSpd(seed: number, n: number): number[][] {
  const b = randomMatrix(seed, n);
  return plus(multiply(transpose(b), b), identity(n));
}

/** ‖QᵀQ − I‖_F: how far the columns of `q` are from orthonormal. */
function orthogonalityError(q: Matrix): number {
  const columns = q[0]!.length;
  return frobenius(minus(multiply(transpose(q), q), identity(columns)));
}

/** Σₖ σₖ · left[k] · right[k]ᵀ. */
function fromSvd(values: Vector, left: Matrix, right: Matrix): number[][] {
  return multiply(
    transpose(left).map(row => row.map((x, k) => x * values[k]!)),
    right,
  );
}

/** Wilkinson's W₂₁⁺: tridiagonal, diagonal |10 − i|, off-diagonal 1. Its two largest eigenvalues agree to 14 digits. */
const WILKINSON_21: Matrix = Array.from({ length: 21 }, (_, i) =>
  Array.from({ length: 21 }, (_, j) => (i === j ? Math.abs(10 - i) : Math.abs(i - j) === 1 ? 1 : 0)),
);

/** Kahan's matrix (n = 100, θ = 1.2): upper triangular, smallest pivot ≈ 9e-4, yet σ_min ≈ 9e-17. */
function kahan(n: number): number[][] {
  const s = Math.sin(1.2);
  const c = Math.cos(1.2);
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (j < i ? 0 : s ** i * (j === i ? 1 : -c))),
  );
}

const SHAPES: readonly (readonly [number, number])[] = [
  [1, 1],
  [6, 6],
  [12, 5],
  [5, 12],
  [40, 40],
  [100, 10],
];

describe('qrDecompose', () => {
  it('matches the textbook Householder example exactly (unique when R has a positive diagonal)', () => {
    // Wikipedia, "QR decomposition", Householder example: A = Q·R with R = [[14, 21, −14], [0, 175, −70], [0, 0, 35]].
    const a = [
      [12, -51, 4],
      [6, 167, -68],
      [-4, 24, -41],
    ];
    const { orthogonal, upper, permutation, rank: r } = qrDecompose(a, { pivoting: false });
    expect(permutation).toEqual([0, 1, 2]);
    expect(r).toBe(3);
    expectMatrixClose(
      upper,
      [
        [14, 21, -14],
        [0, 175, -70],
        [0, 0, 35],
      ],
      1e-12,
    );
    expectMatrixClose(
      orthogonal,
      [
        [6 / 7, -69 / 175, -58 / 175],
        [3 / 7, 158 / 175, 6 / 175],
        [-2 / 7, 6 / 35, -33 / 35],
      ],
      1e-15,
    );
  });

  it('is backward stable with orthonormal Q, for tall, wide and square matrices, pivoted or not', () => {
    // The Householder guarantee (Higham, Accuracy and Stability, Thm 19.4): ‖A·P − Q·R‖ ≤ c·n·ε·‖A‖.
    for (const [index, [m, n]] of SHAPES.entries()) {
      const a = randomRectangular(100 + index, m, n);
      for (const pivoting of [true, false]) {
        const { orthogonal, upper, permutation } = qrDecompose(a, { pivoting });
        const k = Math.min(m, n);
        expect(orthogonal).toHaveLength(m);
        expect(orthogonal[0]).toHaveLength(k);
        expect(upper).toHaveLength(k);
        expect(upper[0]).toHaveLength(n);
        const permuted = a.map(row => permutation.map(j => row[j]!));
        const bound = 4 * Math.max(m, n) * EPSILON;
        expect(frobenius(minus(permuted, multiply(orthogonal, upper)))).toBeLessThanOrEqual(bound * frobenius(a));
        expect(orthogonalityError(orthogonal)).toBeLessThanOrEqual(bound);
        for (const [i, row] of upper.entries()) {
          for (let j = 0; j < i; j++) expect(row[j]).toBe(0);
          expect(row[i]).toBeGreaterThanOrEqual(0);
        }
        if (pivoting) {
          // Pivoting makes |r_kk| non-increasing: that is what makes the rank readable from R.
          for (let i = 1; i < k; i++) expect(upper[i]![i]!).toBeLessThanOrEqual(upper[i - 1]![i - 1]! * (1 + 1e-12));
        }
      }
    }
  });

  it('reveals the numerical rank with pivoting, and honours an explicit tolerance', () => {
    expect(qrDecompose(SINGULAR).rank).toBe(2);
    expect(qrDecompose(STRANG).rank).toBe(3);
    expect(qrDecompose([[0, 0, 0]]).rank).toBe(0);
    // Columns 0 and 2 are equal and column 3 = column 0 + column 1: rank 2 of 4.
    const dependent = [
      [1, 2, 1, 3],
      [0, 1, 0, 1],
      [2, -1, 2, 1],
      [1, 1, 1, 2],
      [3, 0, 3, 3],
    ];
    expect(qrDecompose(dependent).rank).toBe(2);
    expect(rank(dependent)).toBe(2);
    const nearlyDependent = [
      [1, 1],
      [1, 1 + 1e-10],
    ];
    expect(qrDecompose(nearlyDependent).rank).toBe(2);
    expect(qrDecompose(nearlyDependent, { tolerance: 1e-8 }).rank).toBe(1);
  });

  it('scales away from overflow and underflow', () => {
    for (const factor of [1e300, 1e-300]) {
      const a = randomRectangular(7, 6, 4).map(row => row.map(x => x * factor));
      const { orthogonal, upper, permutation } = qrDecompose(a);
      expect(orthogonalityError(orthogonal)).toBeLessThan(1e-14);
      const permuted = a.map(row => permutation.map(j => row[j]! / factor));
      const product = multiply(orthogonal, upper).map(row => row.map(x => x / factor));
      expect(frobenius(minus(permuted, product))).toBeLessThan(1e-14);
    }
  });
});

describe('choleskyDecompose / choleskySolve', () => {
  // Wikipedia, "Cholesky decomposition", example: an integer matrix with an integer factor.
  const SPD = [
    [4, 12, -16],
    [12, 37, -43],
    [-16, -43, 98],
  ];

  it('factors the textbook example exactly', () => {
    expect(choleskyDecompose(SPD).lower).toEqual([
      [2, 0, 0],
      [6, 1, 0],
      [-8, 5, 3],
    ]);
  });

  it('reconstructs A = L·Lᵀ to working precision', () => {
    for (const n of [1, 5, 30]) {
      const a = randomSpd(n, n);
      const { lower } = choleskyDecompose(a);
      for (const [i, row] of lower.entries()) {
        for (let j = i + 1; j < n; j++) expect(row[j]).toBe(0);
        expect(row[i]).toBeGreaterThan(0);
      }
      expect(frobenius(minus(a, multiply(lower, transpose(lower))))).toBeLessThanOrEqual(
        4 * n * EPSILON * frobenius(a),
      );
    }
  });

  it('throws NotPositiveDefiniteError for symmetric matrices that are not positive definite', () => {
    // Eigenvalues 3 and −1: symmetric but indefinite. Cholesky is the standard definiteness test.
    const indefinite = [
      [1, 2],
      [2, 1],
    ];
    expect(() => choleskyDecompose(indefinite)).toThrow(NotPositiveDefiniteError);
    expect(() => choleskyDecompose([[-1]])).toThrow(NotPositiveDefiniteError);
    expect(() => choleskyDecompose([[0]])).toThrow(NotPositiveDefiniteError);
    expect(() => choleskySolve(indefinite, [1, 1])).toThrow(NotPositiveDefiniteError);
    expect(() => choleskyDecompose(indefinite)).toThrow(MathError);
  });

  it('rejects a non-symmetric matrix instead of reading one triangle', () => {
    const lopsided = [
      [4, 1],
      [3, 4],
    ];
    expect(() => choleskyDecompose(lopsided)).toThrow(InvalidArgumentError);
    expect(() => choleskySolve(lopsided, [1, 1])).toThrow(InvalidArgumentError);
    // Within a loose tolerance it factors (A + Aᵀ)/2 = [[4, 2], [2, 4]]: l₁₀ = 2/2.
    expect(choleskyDecompose(lopsided, { tolerance: 2 }).lower[1]![0]).toBe(1);
  });

  it('solves SPD systems like solve does, for vector and matrix right-hand sides', () => {
    const a = randomSpd(9, 12);
    const b = randomRectangular(10, 12, 3);
    expectMatrixClose(choleskySolve(a, b), solve(a, b), 1e-12);
    const v = b.map(row => row[0]!);
    expectClose(choleskySolve(a, v), solve(a, v), 1e-12);
    expectClose(choleskySolve(SPD, multiply(SPD, [1, -2, 3])), [1, -2, 3], 1e-12);
  });

  it('solves an ill-conditioned Hilbert system as accurately as LU', () => {
    // cond₂(H₈) ≈ 1.5e10: the error bound is cond·ε ≈ 3e-6 relative.
    const h = hilbert(8);
    const x = choleskySolve(
      h,
      multiply(
        h,
        Array.from({ length: 8 }, () => 1),
      ),
    );
    for (const value of x) expect(Math.abs(value - 1)).toBeLessThan(1e-5);
  });

  it('throws SingularMatrixError for a singular positive semidefinite matrix', () => {
    const semidefinite = [
      [1, 1],
      [1, 1],
    ];
    expect(() => choleskySolve(semidefinite, [1, 1])).toThrow(SingularMatrixError);
    expect(() => choleskySolve([[1e-10]], [1], { tolerance: 1e-9 })).toThrow(SingularMatrixError);
  });
});

describe('singularValues / singularValueDecompose', () => {
  it('matches known singular values', () => {
    // Worked example (MIT 18.06; NumPy svd gives [5, 3]): A·Aᵀ = [[17, 8], [8, 17]], eigenvalues 25 and 9.
    expectClose(
      singularValues([
        [3, 2, 2],
        [2, 3, -2],
      ]),
      [5, 3],
      1e-14,
    );
    // Signs are absorbed into the vectors; values come out descending.
    expect(
      singularValues([
        [2, 0],
        [0, -3],
      ]),
    ).toEqual([3, 2]);
    // NumPy: svd([[1,2,3],[4,5,6],[7,8,9]]) → 16.8481033526142, 1.06836951455471, ~0.
    const values = singularValues(SINGULAR);
    expectClose(values.slice(0, 2), [16.848_103_352_614_2, 1.068_369_514_554_71], 1e-12);
    expect(values[2]).toBeLessThan(1e-14);
  });

  it('agrees with the symmetric eigensolver on Hilbert and Wilkinson matrices', () => {
    // For a symmetric matrix the singular values are the |eigenvalues|: two independent algorithms must agree.
    for (const a of [hilbert(10), WILKINSON_21, randomSymmetric(3, 15)]) {
      // Descending |λ|, by insertion (no Array#sort or #toSorted in this package's sources).
      const fromEigen: number[] = [];
      for (const x of symmetricEigenvalues(a)) {
        const magnitude = Math.abs(x);
        let at = fromEigen.length;
        while (at > 0 && fromEigen[at - 1]! < magnitude) at--;
        fromEigen.splice(at, 0, magnitude);
      }
      const values = singularValues(a);
      const scale = values[0]!;
      for (const [k, value] of values.entries()) {
        expect(Math.abs(value - fromEigen[k]!)).toBeLessThanOrEqual(8 * a.length * EPSILON * scale);
      }
    }
    // W₂₁⁺'s two largest eigenvalues, 10.746194182903322 and 10.746194182903393, are resolved apart.
    const [first, second] = singularValues(WILKINSON_21);
    expect(first! - second!).toBeGreaterThan(0);
    expect(first! - second!).toBeLessThan(1e-12);
    expect(first).toBeCloseTo(10.746_194_182_903_39, 12);
  });

  it('reconstructs A = U·Σ·Vᵀ with orthonormal U and V, for every shape', () => {
    for (const [index, [m, n]] of SHAPES.entries()) {
      const a = randomRectangular(200 + index, m, n);
      const { values, left, right } = singularValueDecompose(a);
      const k = Math.min(m, n);
      expect(values).toHaveLength(k);
      expect(left).toHaveLength(k);
      expect(left[0]).toHaveLength(m);
      expect(right).toHaveLength(k);
      expect(right[0]).toHaveLength(n);
      for (let i = 1; i < k; i++) expect(values[i]!).toBeLessThanOrEqual(values[i - 1]!);
      expect(values[k - 1]).toBeGreaterThanOrEqual(0);
      const bound = 8 * Math.max(m, n) * EPSILON;
      expect(frobenius(minus(a, fromSvd(values, left, right)))).toBeLessThanOrEqual(bound * frobenius(a));
      expect(orthogonalityError(transpose(left))).toBeLessThanOrEqual(bound);
      expect(orthogonalityError(transpose(right))).toBeLessThanOrEqual(bound);
      expectClose(singularValues(a), values, 0);
    }
  });

  it('fixes each sign pair so the largest entry of left[k] is positive', () => {
    const { left } = singularValueDecompose(randomRectangular(4, 7, 5));
    for (const vector of left) {
      const largest = vector.reduce((best, x) => (Math.abs(x) > Math.abs(best) ? x : best), 0);
      expect(largest).toBeGreaterThan(0);
    }
  });

  it('handles zero, rank-one and badly scaled matrices', () => {
    const zero = singularValueDecompose([
      [0, 0, 0],
      [0, 0, 0],
    ]);
    expect(zero.values).toEqual([0, 0]);
    expect(orthogonalityError(transpose(zero.left))).toBe(0);
    // Rank one: u·vᵀ with ‖u‖ = 3, ‖v‖ = 5 has the single non-zero singular value 15.
    const outer = [1, 2, 2].map(x => [3, 4].map(y => x * y));
    const values = singularValues(outer);
    expect(values[0]).toBeCloseTo(15, 13);
    expect(values[1]).toBeLessThan(1e-14);
    for (const factor of [1e305, 1e-305]) {
      expectClose(
        singularValues([
          [3 * factor, 2 * factor, 2 * factor],
          [2 * factor, 3 * factor, -2 * factor],
        ]).map(x => x / factor),
        [5, 3],
        1e-13,
      );
    }
  });
});

describe('conditionNumber', () => {
  it('is 1 for the identity and for any orthogonal matrix', () => {
    expect(conditionNumber(identity(5))).toBe(1);
    const { orthogonal } = qrDecompose(randomMatrix(8, 6));
    expect(conditionNumber(orthogonal)).toBeCloseTo(1, 13);
  });

  it('measures how ill-conditioned a matrix is', () => {
    expect(
      conditionNumber([
        [1, 0],
        [0, 1e-10],
      ]),
    ).toBeCloseTo(1e10, 0);
    // NumPy: np.linalg.cond(scipy.linalg.hilbert(5)) = 476607.25024259...
    expect(conditionNumber(hilbert(5)) / 476_607.250_242_59).toBeCloseTo(1, 9);
    expect(conditionNumber(hilbert(12))).toBeGreaterThan(1e15);
  });

  it('is Infinity when the smallest singular value is exactly zero', () => {
    expect(conditionNumber([[0, 0]])).toBe(Infinity);
    expect(
      conditionNumber([
        [1, 2],
        [2, 4],
        [0, 0],
      ]),
    ).toBeGreaterThan(1e15);
  });
});

describe('leastSquares', () => {
  it('fits a straight line to an overdetermined system', () => {
    // Points (1, 1), (2, 2), (3, 2): least-squares line y = 2/3 + x/2.
    const x = leastSquares(
      [
        [1, 1],
        [1, 2],
        [1, 3],
      ],
      [1, 2, 2],
    );
    // cond(A) ≈ 6.4, so a few ulps of error are the backward-stable bound.
    expectClose(x, [2 / 3, 1 / 2], 1e-14);
  });

  it('leaves a residual orthogonal to the columns of A, and solves square systems like solve', () => {
    const a = randomRectangular(11, 30, 6);
    const b = randomRectangular(12, 30, 1).map(row => row[0]!);
    const x = leastSquares(a, b);
    const r = minus(multiply(a, x), b);
    for (const value of multiply(transpose(a), r)) expect(Math.abs(value)).toBeLessThan(1e-13);
    const square = randomMatrix(13, 7);
    const v = randomRectangular(14, 7, 1).map(row => row[0]!);
    expectClose(leastSquares(square, v), solve(square, v), 1e-12);
    const columns = randomRectangular(15, 30, 3);
    const solutions = leastSquares(a, columns);
    expectClose(
      solutions.map(row => row[1]!),
      leastSquares(
        a,
        columns.map(row => row[1]!),
      ),
      0,
    );
  });

  it("solves Läuchli's problem, where the normal equations are singular in float64", () => {
    // AᵀA = [[1 + δ², 1], [1, 1 + δ²]] and δ² = 1e-16 < ε, so forming it loses the answer.
    const delta = 1e-8;
    const lauchli = [
      [1, 1],
      [delta, 0],
      [0, delta],
    ];
    const b = [2, delta, delta];
    expectClose(leastSquares(lauchli, b), [1, 1], 1e-14);
    expect(() => solve(multiply(transpose(lauchli), lauchli), multiply(transpose(lauchli), b))).toThrow(
      SingularMatrixError,
    );
  });

  it('recovers a consistent solution on an ill-conditioned Hilbert-like system, to cond·ε', () => {
    // The first 8 columns of the 20×20 Hilbert matrix: cond₂ ≈ 3.8e8, so normal equations (cond² ≈ 1.5e17) fail.
    const a = Array.from({ length: 20 }, (_, i) => Array.from({ length: 8 }, (_, j) => 1 / (i + j + 1)));
    const x = leastSquares(
      a,
      multiply(
        a,
        Array.from({ length: 8 }, () => 1),
      ),
    );
    for (const value of x) expect(Math.abs(value - 1)).toBeLessThan(1e-6);
  });

  it('returns the minimum-norm solution when A is rank-deficient or underdetermined', () => {
    // Every x with x₀ + x₁ = 2 fits [[1, 1], [1, 1]]·x = [2, 2]; the shortest is [1, 1].
    expectClose(
      leastSquares(
        [
          [1, 1],
          [1, 1],
          [1, 1],
        ],
        [1, 2, 3],
      ),
      [1, 1],
      1e-15,
    );
    // One equation, three unknowns: x = 6·[1, 2, 3] / 14, along the row.
    expectClose(leastSquares([[1, 2, 3]], [6]), [6 / 14, 12 / 14, 18 / 14], 1e-15);
    // Agrees with the pseudo-inverse (the definition of the minimum-norm solution).
    const deficient = [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
      [1, 0, -1],
    ];
    const b = [1, 2, 4, 0];
    expectClose(leastSquares(deficient, b), multiply(pseudoInverse(deficient), b), 1e-13);
    expect(leastSquares([[0, 0]], [5])).toEqual([0, 0]);
  });

  it('rejects mismatched right-hand sides', () => {
    expect(() => leastSquares([[1], [2]], [1, 2, 3])).toThrow(InvalidArgumentError);
    expect(() => leastSquares([[1], [2]], [[1]])).toThrow(InvalidArgumentError);
  });
});

describe('pseudoInverse', () => {
  it('matches NumPy pinv on a full-column-rank matrix', () => {
    // np.linalg.pinv([[1, 2], [3, 4], [5, 6]]) = [[-4/3, -1/3, 2/3], [13/12, 1/3, -5/12]].
    expectMatrixClose(
      pseudoInverse([
        [1, 2],
        [3, 4],
        [5, 6],
      ]),
      [
        [-4 / 3, -1 / 3, 2 / 3],
        [13 / 12, 1 / 3, -5 / 12],
      ],
      1e-14,
    );
  });

  it('satisfies the four Moore–Penrose conditions on a rank-deficient matrix', () => {
    const a = multiply(randomRectangular(21, 7, 3), randomRectangular(22, 3, 5)); // 7×5, rank 3
    const p = pseudoInverse(a);
    expect(p).toHaveLength(5);
    expect(p[0]).toHaveLength(7);
    const ap = multiply(a, p);
    const pa = multiply(p, a);
    expect(frobenius(minus(multiply(ap, a), a))).toBeLessThan(1e-13);
    expect(frobenius(minus(multiply(pa, p), p))).toBeLessThan(1e-13);
    expect(frobenius(minus(ap, transpose(ap)))).toBeLessThan(1e-13);
    expect(frobenius(minus(pa, transpose(pa)))).toBeLessThan(1e-13);
  });

  it('equals the inverse for a non-singular matrix, and is zero for the zero matrix', () => {
    expectMatrixClose(pseudoInverse(STRANG), inverse(STRANG), 1e-14);
    expect(
      pseudoInverse([
        [0, 0, 0],
        [0, 0, 0],
      ]),
    ).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
    // An explicit tolerance drops the small singular value of a near-singular matrix.
    const near = [
      [1, 0],
      [0, 1e-12],
    ];
    expect(pseudoInverse(near, { tolerance: 1e-9 })).toEqual([
      [1, 0],
      [0, 0],
    ]);
  });
});

describe('rank: singular values vs elimination', () => {
  it("sees the near-singularity of Kahan's matrix that elimination and pivoted QR miss", () => {
    // Every pivot of the triangular Kahan matrix is ≥ 9e-4, but σ_min ≈ 9e-17 ≤ 100·ε·σ₁. It is built so
    // that column pivoting swaps nothing (R = K), which is why rank defaults to the singular values.
    const k = kahan(100);
    expect(rank(k)).toBe(99);
    expect(rank(k, { method: 'elimination' })).toBe(100);
    expect(qrDecompose(k).rank).toBe(100);
  });

  it('applies an explicit tolerance to whichever quantity is counted, and rejects unknown methods', () => {
    const near = [
      [1, 0],
      [0, 1e-10],
    ];
    expect(rank(near)).toBe(2);
    expect(rank(near, { tolerance: 1e-9 })).toBe(1);
    expect(rank(near, { method: 'elimination', tolerance: 1e-9 })).toBe(1);
    // @ts-expect-error -- an unknown method is a runtime error too
    expect(() => rank(near, { method: 'qr' })).toThrow(InvalidArgumentError);
  });
});

describe('factorizations: validation and hygiene', () => {
  it('rejects malformed input with a typed error', () => {
    for (const run of [
      (a: Matrix) => qrDecompose(a),
      (a: Matrix) => singularValues(a),
      (a: Matrix) => singularValueDecompose(a),
      (a: Matrix) => conditionNumber(a),
      (a: Matrix) => pseudoInverse(a),
      (a: Matrix) => leastSquares(a, [1]),
    ]) {
      expect(() => run([])).toThrow(InvalidArgumentError);
      expect(() => run([[Number.NaN]])).toThrow(InvalidArgumentError);
      expect(() => run([[1, 2], [3]])).toThrow(InvalidArgumentError);
    }
    expect(() => choleskyDecompose([[1, 2]])).toThrow(InvalidArgumentError);
    expect(() => choleskySolve([[1]], [1, 2])).toThrow(InvalidArgumentError);
  });

  it('never modifies or aliases the input, and never returns -0', () => {
    const a = randomRectangular(31, 5, 3).map(row => Object.freeze([...row]));
    const copy = a.map(row => [...row]);
    const qr = qrDecompose(a);
    const svd = singularValueDecompose(a);
    pseudoInverse(a);
    leastSquares(a, [1, 2, 3, 4, 5]);
    expect(a).toEqual(copy);
    const negativeZero = [
      [-0, 0],
      [0, -0],
    ];
    const outputs = [
      ...qrDecompose(negativeZero).upper.flat(),
      ...qrDecompose(negativeZero).orthogonal.flat(),
      ...singularValueDecompose(negativeZero).left.flat(),
      ...singularValueDecompose(negativeZero).right.flat(),
      ...pseudoInverse(negativeZero).flat(),
      ...leastSquares(negativeZero, [-0, 0]),
      ...choleskyDecompose([
        [4, -0],
        [-0, 9],
      ]).lower.flat(),
    ];
    for (const x of outputs) expect(Object.is(x, -0)).toBe(false);
    expect(qr.orthogonal[0]).not.toBe(a[0]);
    expect(svd.right[0]).not.toBe(a[0]);
  });
});
