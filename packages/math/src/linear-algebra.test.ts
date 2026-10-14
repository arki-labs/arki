import { describe, expect, it } from 'vitest';

import type { Matrix, Vector } from './linear-algebra.js';
import { Complex, complex } from './complex.js';
import {
  DivisionByZeroError,
  InvalidArgumentError,
  MathError,
  NumericRangeError,
  ResourceLimitError,
  SingularMatrixError,
} from './errors.js';
import {
  angleBetween,
  cross,
  determinant,
  dot,
  eigenDecompose,
  eigenvalues,
  identity,
  inverse,
  luDecompose,
  matrix,
  minus,
  multiply,
  norm,
  normalize,
  plus,
  projection,
  rank,
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
