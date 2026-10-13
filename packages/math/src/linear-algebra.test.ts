import { describe, expect, it } from 'vitest';

import type { Matrix, Vector } from './linear-algebra.js';
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
  times,
  trace,
  transpose,
} from './linear-algebra.js';

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
