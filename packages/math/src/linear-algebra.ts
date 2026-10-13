/**
 * Lean dense linear algebra over plain JS numbers (float64): vectors, small to
 * medium matrices, LU with partial pivoting. For symbolic algebra, sparse
 * storage or eigenvalues, reach for a full CAS such as mathjs.
 *
 * **Representation.** Vectors are `readonly number[]` and matrices are
 * `readonly (readonly number[])[]` (an array of rows), not a `Matrix` class.
 * Plain arrays cost nothing to create, serialize to JSON as-is, and pass
 * straight to charts, other libraries and API payloads. A
 * class would add an allocation and a conversion at every boundary and buy
 * only cached shape checks, which are O(n·m) against O(n³) for the work that
 * matters. The `readonly` input types promise that nothing is modified; every
 * result is a fresh `number[]` / `number[][]` that never aliases an input.
 *
 * **Validation.** Every call checks its inputs: arrays only (`TypeError`
 * otherwise), non-empty, rectangular, finite entries, matching dimensions
 * (`InvalidArgumentError` otherwise). A result that overflows to `±Infinity`
 * throws `NumericRangeError`. Results never carry `NaN` or `-0`.
 *
 * **Tolerance.** `solve` and `inverse` factor `A` as `P·A = L·U` with partial
 * pivoting and throw `SingularMatrixError` when a pivot satisfies
 * `|u_kk| <= n · Number.EPSILON · ‖A‖∞` (‖A‖∞ = largest absolute row sum).
 * That is the point where the matrix is singular to working precision: a
 * perturbation of `A` the size of its own rounding error could make it
 * exactly singular. `rank` counts pivots above `max(m, n) · Number.EPSILON ·
 * ‖A‖∞`, the same rule NumPy's `matrix_rank` applies to singular values. Each
 * function takes `{ tolerance }` to replace the default with an absolute
 * threshold. `determinant` never throws for a singular matrix; it returns the
 * product of the pivots, which may be tiny rather than exactly zero.
 * Gaussian elimination is a fast, good-enough rank test; for rank decisions on
 * badly conditioned data, use an SVD.
 */

import {
  DivisionByZeroError,
  InvalidArgumentError,
  NumericRangeError,
  ResourceLimitError,
  SingularMatrixError,
} from './errors.js';
import { assertFinite } from './number.js';

/** A vector: a non-empty array of finite numbers. */
export type Vector = readonly number[];

/** A matrix: a non-empty array of equally long, non-empty rows of finite numbers. */
export type Matrix = readonly Vector[];

export type ToleranceOptions = {
  /**
   * Absolute pivot threshold. A pivot whose magnitude is at or below it
   * counts as zero. Defaults to the size-and-norm-relative rule in the module
   * docs; `0` treats only exact zeros as zero.
   */
  tolerance?: number;
};

/** `P·A = L·U`, from `luDecompose`. */
export type LuDecomposition = {
  /** Unit lower-triangular factor `L` (ones on the diagonal). */
  lower: number[][];
  /** Upper-triangular factor `U`; a zero (or tiny) diagonal entry means `A` is singular. */
  upper: number[][];
  /** Row `i` of `P·A` is row `permutation[i]` of `A`. */
  permutation: number[];
  /** Sign of the permutation: `1` for an even number of row swaps, `-1` for odd. */
  sign: 1 | -1;
};

/** Largest matrix `identity` builds (rows × columns); keeps `identity(1e6)` from exhausting memory. */
const MAX_ELEMENTS = 10_000_000;

// ---------------------------------------------------------------------------
// Validation and result guards

function assertVector(v: Vector, name: string): number {
  if (!Array.isArray(v)) throw new TypeError(`${name} must be an array of numbers`);
  if (v.length === 0) throw new InvalidArgumentError(`${name} must not be empty`);
  for (const [i, x] of v.entries()) assertFinite(x, `${name}[${i}]`);
  return v.length;
}

/** Checks shape and entries; returns `[rows, columns]`. */
function assertMatrix(a: Matrix, name: string): [number, number] {
  if (!Array.isArray(a)) throw new TypeError(`${name} must be an array of rows`);
  if (a.length === 0) throw new InvalidArgumentError(`${name} must have at least one row`);
  let columns = -1;
  for (const [i, row] of a.entries()) {
    if (!Array.isArray(row)) throw new TypeError(`${name}[${i}] must be an array of numbers`);
    if (columns === -1) {
      if (row.length === 0) throw new InvalidArgumentError(`${name} must have at least one column`);
      columns = row.length;
    } else if (row.length !== columns) {
      throw new InvalidArgumentError(
        `${name} is not rectangular: row ${i} has ${row.length} columns, row 0 has ${columns}`,
      );
    }
    for (const [j, x] of row.entries()) assertFinite(x, `${name}[${i}][${j}]`);
  }
  return [a.length, columns];
}

function assertSquare(a: Matrix, name: string): number {
  const [rows, columns] = assertMatrix(a, name);
  if (rows !== columns) throw new InvalidArgumentError(`${name} must be square, got ${rows}×${columns}`);
  return rows;
}

function assertSameLength(a: number, b: number): void {
  if (a !== b) throw new InvalidArgumentError(`dimension mismatch: ${a} vs ${b}`);
}

function resolveTolerance(options: ToleranceOptions | undefined, fallback: () => number): number {
  const tolerance = options?.tolerance;
  if (tolerance === undefined) return fallback();
  assertFinite(tolerance, 'tolerance');
  if (tolerance < 0) throw new InvalidArgumentError('tolerance must be non-negative');
  return tolerance;
}

/** Rejects overflow (and the `NaN` that `Infinity - Infinity` would bring); drops `-0`. */
function finish(x: number): number {
  if (!Number.isFinite(x)) throw new NumericRangeError('result overflows the float64 range');
  return x === 0 ? 0 : x;
}

function finishVector(v: number[]): number[] {
  for (let i = 0; i < v.length; i++) v[i] = finish(v[i]!);
  return v;
}

function finishMatrix(a: number[][]): number[][] {
  for (const row of a) finishVector(row);
  return a;
}

function isMatrixShape(x: Vector | Matrix): x is Matrix {
  return Array.isArray(x[0]);
}

/** ‖A‖∞: the largest absolute row sum. Inputs are already validated. */
function normInfinity(a: Matrix): number {
  let max = 0;
  for (const row of a) {
    let sum = 0;
    for (const x of row) sum += Math.abs(x);
    if (sum > max) max = sum;
  }
  return max;
}

// ---------------------------------------------------------------------------
// Vectors

/** Dot product `Σ aᵢ·bᵢ`. Throws `InvalidArgumentError` for different lengths. */
export function dot(a: Vector, b: Vector): number {
  assertSameLength(assertVector(a, 'a'), assertVector(b, 'b'));
  let sum = 0;
  for (const [i, x] of a.entries()) sum += x * b[i]!;
  return finish(sum);
}

/** Cross product of two 3-vectors; perpendicular to both, right-handed. */
export function cross(a: Vector, b: Vector): number[] {
  if (assertVector(a, 'a') !== 3 || assertVector(b, 'b') !== 3) {
    throw new InvalidArgumentError('cross product needs two 3-dimensional vectors');
  }
  const [a1 = 0, a2 = 0, a3 = 0] = a;
  const [b1 = 0, b2 = 0, b3 = 0] = b;
  return finishVector([a2 * b3 - a3 * b2, a3 * b1 - a1 * b3, a1 * b2 - a2 * b1]);
}

/**
 * The p-norm `(Σ |vᵢ|^p)^(1/p)`: Euclidean length by default, `1` for the
 * taxicab sum, `Infinity` for the largest magnitude. `p` must be at least 1
 * (below 1 it is not a norm). Scaled by the largest magnitude first, so
 * `norm([3e200, 4e200])` is `5e200` instead of overflowing.
 */
export function norm(v: Vector, p = 2): number {
  assertVector(v, 'v');
  if (typeof p !== 'number') throw new TypeError('p must be a number');
  if (!(p >= 1)) throw new InvalidArgumentError(`p must be at least 1 (or Infinity), got ${p}`);
  let largest = 0;
  for (const x of v) largest = Math.max(largest, Math.abs(x));
  if (largest === 0 || p === Infinity) return largest;
  if (p === 1) {
    let sum = 0;
    for (const x of v) sum += Math.abs(x);
    return finish(sum);
  }
  let sum = 0;
  if (p === 2) {
    for (const x of v) {
      const r = x / largest;
      sum += r * r;
    }
    return finish(largest * Math.sqrt(sum));
  }
  for (const x of v) sum += Math.abs(x / largest) ** p;
  return finish(largest * sum ** (1 / p));
}

/** The unit vector in the direction of `v`. Throws `DivisionByZeroError` for the zero vector. */
export function normalize(v: Vector): number[] {
  const length = norm(v);
  if (length === 0) throw new DivisionByZeroError('the zero vector has no direction');
  return finishVector(v.map(x => x / length));
}

/**
 * The angle between two vectors in radians, in `[0, π]`. Uses Kahan's
 * `2·atan2(‖û − v̂‖, ‖û + v̂‖)` on the unit vectors, which stays accurate for
 * nearly parallel and nearly opposite vectors where `acos(cos θ)` loses half
 * its digits. Throws `DivisionByZeroError` if either vector is zero.
 */
export function angleBetween(a: Vector, b: Vector): number {
  assertSameLength(assertVector(a, 'a'), assertVector(b, 'b'));
  const u = normalize(a);
  const w = normalize(b);
  const difference = u.map((x, i) => x - w[i]!);
  const sum = u.map((x, i) => x + w[i]!);
  return 2 * Math.atan2(norm(difference), norm(sum));
}

/**
 * The vector projection of `v` onto `onto`: `(v·onto / onto·onto)·onto`.
 * Throws `DivisionByZeroError` when `onto` is the zero vector.
 */
export function projection(v: Vector, onto: Vector): number[] {
  assertSameLength(assertVector(v, 'v'), assertVector(onto, 'onto'));
  const largest = norm(onto, Infinity);
  if (largest === 0) throw new DivisionByZeroError('cannot project onto the zero vector');
  // Scale `onto` so its largest entry is ±1: `w·w` then lies in [1, n] and cannot
  // overflow or underflow, and no square root rounds the direction.
  const w = onto.map(x => x / largest);
  const scale = dot(v, w) / dot(w, w);
  return finishVector(w.map(x => x * scale));
}

// ---------------------------------------------------------------------------
// Element-wise (vectors and matrices)

/** Element-wise sum of two vectors, or of two matrices of the same shape. */
export function plus(a: Vector, b: Vector): number[];
export function plus(a: Matrix, b: Matrix): number[][];
export function plus(a: Vector | Matrix, b: Vector | Matrix): number[] | number[][] {
  return elementWise(a, b, (x, y) => x + y);
}

/** Element-wise difference `a − b` of two vectors, or of two matrices of the same shape. */
export function minus(a: Vector, b: Vector): number[];
export function minus(a: Matrix, b: Matrix): number[][];
export function minus(a: Vector | Matrix, b: Vector | Matrix): number[] | number[][] {
  return elementWise(a, b, (x, y) => x - y);
}

/** Every element multiplied by the scalar `k`. For the matrix product, see `multiply`. */
export function times(a: Vector, k: number): number[];
export function times(a: Matrix, k: number): number[][];
export function times(a: Vector | Matrix, k: number): number[] | number[][] {
  assertFinite(k, 'k');
  if (isMatrixShape(a)) {
    assertMatrix(a, 'a');
    return finishMatrix(a.map(row => row.map(x => x * k)));
  }
  assertVector(a, 'a');
  return finishVector(a.map(x => x * k));
}

function elementWise(
  a: Vector | Matrix,
  b: Vector | Matrix,
  op: (x: number, y: number) => number,
): number[] | number[][] {
  if (isMatrixShape(a)) {
    if (!isMatrixShape(b)) throw new InvalidArgumentError('cannot combine a matrix with a vector');
    const [rows, columns] = assertMatrix(a, 'a');
    const [rowsB, columnsB] = assertMatrix(b, 'b');
    if (rows !== rowsB || columns !== columnsB) {
      throw new InvalidArgumentError(`shape mismatch: ${rows}×${columns} vs ${rowsB}×${columnsB}`);
    }
    return finishMatrix(a.map((row, i) => row.map((x, j) => op(x, b[i]![j]!))));
  }
  if (isMatrixShape(b)) throw new InvalidArgumentError('cannot combine a vector with a matrix');
  assertSameLength(assertVector(a, 'a'), assertVector(b, 'b'));
  return finishVector(a.map((x, i) => op(x, b[i]!)));
}

// ---------------------------------------------------------------------------
// Matrices

/**
 * A validated copy of `rows`: throws unless it is a non-empty, rectangular
 * array of non-empty rows of finite numbers. Use it at a trust boundary
 * (parsed JSON, user input); every other function validates on its own.
 */
export function matrix(rows: Matrix): number[][] {
  assertMatrix(rows, 'rows');
  return rows.map(row => finishVector([...row]));
}

/** The `n × n` identity matrix. Throws `ResourceLimitError` past 10,000,000 elements. */
export function identity(n: number): number[][] {
  assertFinite(n, 'n');
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError(`n must be a positive integer, got ${n}`);
  if (n * n > MAX_ELEMENTS)
    throw new ResourceLimitError(`identity(${n}) exceeds the limit of ${MAX_ELEMENTS} elements`);
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
}

/** Rows become columns: `transpose(A)[j][i] === A[i][j]`. */
export function transpose(a: Matrix): number[][] {
  const [rows, columns] = assertMatrix(a, 'a');
  return Array.from({ length: columns }, (_, j) => Array.from({ length: rows }, (_, i) => finish(a[i]![j]!)));
}

/** Sum of the diagonal of a square matrix. */
export function trace(a: Matrix): number {
  assertSquare(a, 'a');
  let sum = 0;
  for (const [i, row] of a.entries()) sum += row[i]!;
  return finish(sum);
}

/**
 * The matrix product `A·B` (`m×n` times `n×p` gives `m×p`), or the
 * matrix-vector product `A·v` (an `m`-vector). For a row vector times a
 * matrix, use `multiply(transpose(A), v)`. For scaling by a number, see
 * `times`.
 */
export function multiply(a: Matrix, b: Matrix): number[][];
export function multiply(a: Matrix, b: Vector): number[];
export function multiply(a: Matrix, b: Matrix | Vector): number[][] | number[] {
  const [, columns] = assertMatrix(a, 'a');
  if (!isMatrixShape(b)) {
    assertSameLength(columns, assertVector(b, 'b'));
    return finishVector(a.map(row => rowDot(row, b)));
  }
  const [rowsB, columnsB] = assertMatrix(b, 'b');
  if (columns !== rowsB)
    throw new InvalidArgumentError(`cannot multiply: a has ${columns} columns, b has ${rowsB} rows`);
  // i-k-j order: the inner loop walks rows of b and of the result, both contiguous.
  return finishMatrix(
    a.map(row => {
      const out = Array.from({ length: columnsB }, () => 0);
      for (const [k, x] of row.entries()) {
        if (x === 0) continue;
        const rowB = b[k]!;
        for (let j = 0; j < columnsB; j++) out[j]! += x * rowB[j]!;
      }
      return out;
    }),
  );
}

function rowDot(row: Vector, v: Vector): number {
  let sum = 0;
  for (const [i, x] of row.entries()) sum += x * v[i]!;
  return sum;
}

type Factored = {
  /** `L` below the diagonal (unit diagonal implied), `U` on and above it. */
  lu: number[][];
  permutation: number[];
  sign: 1 | -1;
};

/** In-place Doolittle LU with partial pivoting on a fresh copy of a validated square matrix. */
function factor(a: Matrix): Factored {
  const n = a.length;
  const lu = a.map(row => [...row]);
  const permutation = Array.from({ length: n }, (_, i) => i);
  let sign: 1 | -1 = 1;
  for (let k = 0; k < n; k++) {
    let pivotRow = k;
    let largest = Math.abs(lu[k]![k]!);
    for (let i = k + 1; i < n; i++) {
      const candidate = Math.abs(lu[i]![k]!);
      if (candidate > largest) {
        largest = candidate;
        pivotRow = i;
      }
    }
    if (pivotRow !== k) {
      [lu[k], lu[pivotRow]] = [lu[pivotRow]!, lu[k]!];
      [permutation[k], permutation[pivotRow]] = [permutation[pivotRow]!, permutation[k]!];
      sign = sign === 1 ? -1 : 1;
    }
    // An all-zero column below the diagonal needs no elimination (and has no pivot to divide by).
    if (largest === 0) continue;
    const pivot = lu[k]!;
    const p = pivot[k]!;
    for (let i = k + 1; i < n; i++) {
      const row = lu[i]!;
      const f = row[k]! / p;
      row[k] = f;
      if (f === 0) continue;
      for (let j = k + 1; j < n; j++) row[j]! -= f * pivot[j]!;
    }
  }
  return { lu, permutation, sign };
}

/** Factors `a` and throws `SingularMatrixError` if any pivot is at or below the tolerance. */
function factorNonSingular(a: Matrix, options: ToleranceOptions | undefined): Factored {
  const n = a.length;
  const tolerance = resolveTolerance(options, () => n * Number.EPSILON * normInfinity(a));
  const factored = factor(a);
  for (const [k, row] of factored.lu.entries()) {
    if (Math.abs(row[k]!) <= tolerance) {
      throw new SingularMatrixError(`matrix is singular to working precision (pivot ${k} ≤ ${tolerance})`);
    }
  }
  return factored;
}

/** Solves `L·U·x = P·b` for one right-hand side, given as a column accessor. */
function substitute({ lu, permutation }: Factored, b: (i: number) => number): number[] {
  const n = lu.length;
  const x = permutation.map(i => b(i));
  for (let i = 1; i < n; i++) {
    const row = lu[i]!;
    let sum = x[i]!;
    for (let j = 0; j < i; j++) sum -= row[j]! * x[j]!;
    x[i] = sum;
  }
  for (let i = n - 1; i >= 0; i--) {
    const row = lu[i]!;
    let sum = x[i]!;
    for (let j = i + 1; j < n; j++) sum -= row[j]! * x[j]!;
    x[i] = sum / row[i]!;
  }
  return x;
}

/**
 * `P·A = L·U` for a square matrix, with partial pivoting (the largest
 * remaining entry in each column becomes the pivot, so every multiplier in `L`
 * has magnitude at most 1). Never throws for a singular matrix: `upper` then
 * has a zero, or tiny, diagonal entry.
 */
export function luDecompose(a: Matrix): LuDecomposition {
  assertSquare(a, 'a');
  const { lu, permutation, sign } = factor(a);
  const lower = lu.map((row, i) => row.map((x, j) => (j < i ? x : j === i ? 1 : 0)));
  const upper = lu.map((row, i) => row.map((x, j) => (j >= i ? x : 0)));
  return { lower: finishMatrix(lower), upper: finishMatrix(upper), permutation, sign };
}

/**
 * The determinant, as `sign(P) · Π u_kk` from an LU factorization: O(n³),
 * where cofactor expansion is O(n!). A singular matrix gives `0` or a value
 * tiny next to the entries; it never throws for that. Throws
 * `NumericRangeError` if the product overflows.
 */
export function determinant(a: Matrix): number {
  assertSquare(a, 'a');
  const { lu, sign } = factor(a);
  let product: number = sign;
  for (const [k, row] of lu.entries()) product *= row[k]!;
  return finish(product);
}

/**
 * Solves `A·x = b` for a square `A`, by LU with partial pivoting. `b` is a
 * vector (gives `x`) or a matrix of right-hand-side columns (gives a matrix
 * of solution columns). Throws `SingularMatrixError` when `A` is singular to
 * working precision; see the module docs for the tolerance.
 */
export function solve(a: Matrix, b: Vector, options?: ToleranceOptions): number[];
export function solve(a: Matrix, b: Matrix, options?: ToleranceOptions): number[][];
export function solve(a: Matrix, b: Vector | Matrix, options?: ToleranceOptions): number[] | number[][] {
  const n = assertSquare(a, 'a');
  if (!isMatrixShape(b)) {
    assertSameLength(n, assertVector(b, 'b'));
    return finishVector(substitute(factorNonSingular(a, options), i => b[i]!));
  }
  const [rows, columns] = assertMatrix(b, 'b');
  assertSameLength(n, rows);
  const factored = factorNonSingular(a, options);
  const solutionColumns = Array.from({ length: columns }, (_, j) => substitute(factored, i => b[i]![j]!));
  return finishMatrix(Array.from({ length: n }, (_, i) => solutionColumns.map(column => column[i]!)));
}

/**
 * The inverse `A⁻¹`, so that `A·A⁻¹ = I`. Throws `SingularMatrixError` when
 * `A` is singular to working precision. To solve `A·x = b`, call `solve`: it
 * is faster and more accurate than `multiply(inverse(A), b)`.
 */
export function inverse(a: Matrix, options?: ToleranceOptions): number[][] {
  const n = assertSquare(a, 'a');
  const factored = factorNonSingular(a, options);
  const columns = Array.from({ length: n }, (_, j) => substitute(factored, i => (i === j ? 1 : 0)));
  return finishMatrix(Array.from({ length: n }, (_, i) => columns.map(column => column[i]!)));
}

/**
 * The number of linearly independent rows (equivalently, columns) of any
 * `m×n` matrix, by row echelon form with partial pivoting. A pivot at or below
 * `max(m, n) · Number.EPSILON · ‖A‖∞` counts as zero; pass `{ tolerance }` to
 * set an absolute threshold instead.
 */
export function rank(a: Matrix, options?: ToleranceOptions): number {
  const [rows, columns] = assertMatrix(a, 'a');
  const tolerance = resolveTolerance(options, () => Math.max(rows, columns) * Number.EPSILON * normInfinity(a));
  const work = a.map(row => [...row]);
  let r = 0;
  for (let c = 0; c < columns && r < rows; c++) {
    let pivotRow = r;
    let largest = Math.abs(work[r]![c]!);
    for (let i = r + 1; i < rows; i++) {
      const candidate = Math.abs(work[i]![c]!);
      if (candidate > largest) {
        largest = candidate;
        pivotRow = i;
      }
    }
    if (largest <= tolerance) continue;
    [work[r], work[pivotRow]] = [work[pivotRow]!, work[r]!];
    const pivot = work[r]!;
    for (let i = r + 1; i < rows; i++) {
      const row = work[i]!;
      const f = row[c]! / pivot[c]!;
      if (f === 0) continue;
      for (let j = c; j < columns; j++) row[j]! -= f * pivot[j]!;
    }
    r++;
  }
  return r;
}
