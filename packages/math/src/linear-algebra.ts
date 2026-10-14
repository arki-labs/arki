/**
 * Lean dense linear algebra over plain JS numbers (float64): vectors, small to
 * medium matrices, LU with partial pivoting, eigenvalues and eigenvectors. For
 * symbolic algebra or sparse storage, reach for a full CAS such as mathjs.
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
 *
 * **Eigenvalues.** Four functions, named like `luDecompose`:
 * `symmetricEigenvalues` / `symmetricEigenDecompose` for a symmetric matrix,
 * `eigenvalues` / `eigenDecompose` for any real square matrix. The symmetric
 * pair returns real `number`s sorted ascending with orthonormal eigenvectors;
 * it accepts `A` when every `|a[i][j] − a[j][i]|` is at most
 * `n · Number.EPSILON · ‖A‖∞` (or `{ tolerance }`, absolute) and works on
 * `(A + Aᵀ) / 2`; otherwise it throws `InvalidArgumentError`. The general pair
 * always returns `Complex` values (from `@arki/math/complex`) sorted by real
 * part, then imaginary part, as `polynomialRoots` does: a real eigenvalue has
 * an imaginary part of exactly `0` (so `isReal()` is true), and complex
 * eigenvalues come in conjugate pairs. Eigenvectors are a list: `vectors[k]`
 * belongs to `values[k]` (call `transpose` for the matrix with eigenvectors as
 * columns). Each has unit Euclidean length and its largest-magnitude entry (the
 * first, on an exact tie) is real and positive, so results are reproducible.
 * Algorithms are the LAPACK/EISPACK routes: Householder tridiagonalization plus
 * implicit QL with Wilkinson shifts (`dsyev`/`tql2`) for symmetric input;
 * balancing, Householder reduction to Hessenberg form and Francis double-shift
 * QR (`dgeev`/`hqr2`) for general input. The matrix is first scaled by a power
 * of two (exact) so entries near the float64 limits neither overflow nor
 * underflow. Results are backward stable: each eigenpair satisfies
 * `‖A·v − λ·v‖ ≈ n · ε · ‖A‖`. Eigenvalues of a defective matrix (a Jordan
 * block) are as accurate as the problem allows, about `ε^(1/k)` for a block of
 * size `k`, so a double root may come out as a close real pair or a tiny
 * complex pair, as in every float library; their eigenvectors are then nearly
 * parallel. The QR iteration is capped (30 sweeps per eigenvalue for the
 * symmetric case, `30 · max(10, n)` per eigenvalue for the general case, with
 * exceptional shifts at 10 and 30); past the cap it throws `ConvergenceError`.
 */

import { Complex } from './complex.js';
import {
  ConvergenceError,
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
  let i = 0;
  for (const x of v) {
    // Cheap check first; the message is only built for the failing entry.
    if (typeof x !== 'number' || !Number.isFinite(x)) assertFinite(x, `${name}[${i}]`);
    i++;
  }
  return v.length;
}

/** Checks shape and entries; returns `[rows, columns]`. */
function assertMatrix(a: Matrix, name: string): [number, number] {
  if (!Array.isArray(a)) throw new TypeError(`${name} must be an array of rows`);
  if (a.length === 0) throw new InvalidArgumentError(`${name} must have at least one row`);
  let columns = -1;
  let i = 0;
  for (const row of a) {
    if (!Array.isArray(row)) throw new TypeError(`${name}[${i}] must be an array of numbers`);
    if (columns === -1) {
      if (row.length === 0) throw new InvalidArgumentError(`${name} must have at least one column`);
      columns = row.length;
    } else if (row.length !== columns) {
      throw new InvalidArgumentError(
        `${name} is not rectangular: row ${i} has ${row.length} columns, row 0 has ${columns}`,
      );
    }
    let j = 0;
    for (const x of row) {
      // Cheap check first; the message is only built for the failing entry.
      if (typeof x !== 'number' || !Number.isFinite(x)) assertFinite(x, `${name}[${i}][${j}]`);
      j++;
    }
    i++;
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
  // i-k-j order: the inner loop walks a row of b and the accumulator, both
  // contiguous. The rows of b are copied once into Float64Arrays, so the hot
  // loop reads one storage kind however the caller built its arrays (mixed
  // array kinds otherwise make engines fall back to slower generic loads).
  // Indexed loops throughout: JSC iterates a typed array with for-of through slow helpers.
  const rowsOfB: Float64Array[] = [];
  for (const rowB of b) rowsOfB.push(new Float64Array(rowB));
  const accumulator = new Float64Array(columnsB);
  const rows = a.length;
  const product: number[][] = [];
  for (let i = 0; i < rows; i++) {
    const row = a[i]!;
    accumulator.fill(0);
    let k = 0;
    // Four rows of b per sweep, so the accumulator is loaded and stored a
    // quarter as often. Every entry still adds its products in k order, so
    // the result is bit-identical to the one-row loop.
    for (; k + 3 < columns; k += 4) {
      const x0 = row[k]!;
      const x1 = row[k + 1]!;
      const x2 = row[k + 2]!;
      const x3 = row[k + 3]!;
      const b0 = rowsOfB[k]!;
      const b1 = rowsOfB[k + 1]!;
      const b2 = rowsOfB[k + 2]!;
      const b3 = rowsOfB[k + 3]!;
      for (let j = 0; j < columnsB; j++) {
        accumulator[j] = accumulator[j]! + x0 * b0[j]! + x1 * b1[j]! + x2 * b2[j]! + x3 * b3[j]!;
      }
    }
    for (; k < columns; k++) {
      const x = row[k]!;
      const rowB = rowsOfB[k]!;
      for (let j = 0; j < columnsB; j++) accumulator[j]! += x * rowB[j]!;
    }
    const out: number[] = [];
    for (let j = 0; j < columnsB; j++) out.push(finish(accumulator[j]!));
    product.push(out);
  }
  return product;
}

function rowDot(row: Vector, v: Vector): number {
  let sum = 0;
  let i = 0;
  for (const x of row) sum += x * v[i++]!;
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
  const { lu, permutation } = factorNonSingular(a, options);
  // Solves L·U·X = P for all n columns at once, a row of X at a time: every
  // entry gets the same operations in the same order as one `substitute` per
  // column, but the inner loops run along contiguous Float64Array rows.
  const x: Float64Array[] = [];
  for (const source of permutation) {
    const row = new Float64Array(n);
    row[source] = 1;
    x.push(row);
  }
  for (let i = 1; i < n; i++) {
    const factors = lu[i]!;
    const target = x[i]!;
    for (let j = 0; j < i; j++) {
      const f = factors[j]!;
      const solved = x[j]!;
      for (let c = 0; c < n; c++) target[c]! -= f * solved[c]!;
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    const factors = lu[i]!;
    const target = x[i]!;
    for (let j = i + 1; j < n; j++) {
      const f = factors[j]!;
      const solved = x[j]!;
      for (let c = 0; c < n; c++) target[c]! -= f * solved[c]!;
    }
    const pivot = factors[i]!;
    for (let c = 0; c < n; c++) target[c]! /= pivot;
  }
  const result: number[][] = [];
  for (const row of x) {
    const out: number[] = [];
    for (let c = 0; c < n; c++) out.push(finish(row[c]!));
    result.push(out);
  }
  return result;
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

// ---------------------------------------------------------------------------
// Eigenvalues and eigenvectors

/** Options for the symmetric eigen solvers. */
export type SymmetryOptions = {
  /**
   * Largest accepted `|a[i][j] − a[j][i]|`, absolute. Defaults to
   * `n · Number.EPSILON · ‖A‖∞`, which accepts the rounding noise of a
   * matrix computed in floating point; `0` demands exact symmetry.
   */
  tolerance?: number;
};

/** `A = V·Λ·Vᵀ`, from `symmetricEigenDecompose`. */
export type SymmetricEigenDecomposition = {
  /** The eigenvalues, ascending, repeated by multiplicity. */
  values: number[];
  /** `vectors[k]` is the unit eigenvector for `values[k]`; together they are orthonormal. */
  vectors: number[][];
};

/** Eigenpairs of a general real matrix, from `eigenDecompose`. */
export type EigenDecomposition = {
  /** The eigenvalues, sorted by real part, then imaginary part; a real one has `im === 0`. */
  values: Complex[];
  /** `vectors[k]` is a unit eigenvector for `values[k]` (real entries for a real eigenvalue). */
  vectors: Complex[][];
};

const EPS = Number.EPSILON;

/** `√(a² + b²)` without overflow or underflow of the squares. */
function hypot(a: number, b: number): number {
  const x = Math.abs(a);
  const y = Math.abs(b);
  const big = Math.max(x, y);
  if (big > 1e150 || big < 1e-150) {
    if (big === 0) return 0;
    const small = Math.min(x, y) / big;
    return big * Math.sqrt(1 + small * small);
  }
  // eslint-disable-next-line unicorn/prefer-modern-math-apis -- in this range the squares cannot over- or underflow, and Math.hypot is several times slower in the QL inner loop
  return Math.sqrt(x * x + y * y);
}

/**
 * `n` zeroed rows of length `n`, as views on one buffer: allocating one typed
 * array per row costs more than a 20×20 decomposition's whole setup.
 */
function squareRows(n: number): Float64Array[] {
  const buffer = new Float64Array(n * n);
  const rows: Float64Array[] = [];
  for (let i = 0; i < n; i++) rows.push(buffer.subarray(i * n, i * n + n));
  return rows;
}

/**
 * A copy of a validated square matrix as `Float64Array` rows (the working
 * storage of every eigen routine: a row reference hoisted out of an inner loop
 * beats flat `i·n + j` indexing), multiplied by the power of two that brings
 * its largest magnitude near 1. Scaling by a power of two is exact, and it
 * keeps the squares and products inside the iterations away from overflow
 * and underflow.
 */
function scaledCopy(a: Matrix, n: number): { work: Float64Array[]; scale: number } {
  const work = squareRows(n);
  let largest = 0;
  for (let i = 0; i < n; i++) {
    const source = a[i]!;
    const row = work[i]!;
    for (let j = 0; j < n; j++) {
      const x = source[j]!;
      row[j] = x;
      const magnitude = Math.abs(x);
      if (magnitude > largest) largest = magnitude;
    }
  }
  const exponent = largest === 0 ? 0 : Math.max(-1020, Math.min(1020, Math.round(Math.log2(largest))));
  const scale = 2 ** -exponent;
  if (scale !== 1) for (const row of work) for (let j = 0; j < n; j++) row[j]! *= scale;
  return { work, scale };
}

/** Validates, scales and symmetrizes `a`; throws `InvalidArgumentError` if it is not symmetric. */
function symmetricInput(
  a: Matrix,
  options: SymmetryOptions | undefined,
): { w: Float64Array[]; n: number; scale: number } {
  const n = assertSquare(a, 'a');
  const { work, scale } = scaledCopy(a, n);
  let tolerance: number;
  if (options?.tolerance === undefined) {
    let norm = 0;
    for (const row of work) {
      let sum = 0;
      for (let j = 0; j < n; j++) sum += Math.abs(row[j]!);
      norm = Math.max(norm, sum);
    }
    tolerance = n * EPS * norm;
  } else {
    // Compared on the scaled copy, where differences cannot overflow.
    tolerance = resolveTolerance(options, () => 0) * scale;
  }
  for (let i = 0; i < n; i++) {
    const row = work[i]!;
    for (let j = i + 1; j < n; j++) {
      const column = work[j]!;
      const upper = row[j]!;
      const lower = column[i]!;
      if (Math.abs(upper - lower) > tolerance) {
        throw new InvalidArgumentError(
          `a is not symmetric: |a[${i}][${j}] − a[${j}][${i}]| = ${Math.abs(a[i]![j]! - a[j]![i]!)} exceeds the tolerance`,
        );
      }
      const mean = (upper + lower) / 2;
      row[j] = mean;
      column[i] = mean;
    }
  }
  return { w: work, n, scale };
}

/**
 * Householder reduction of the symmetric `w` to tridiagonal form (EISPACK
 * `tred2`, as in JAMA): diagonal in `d`, subdiagonal in `e[1..n-1]`. With
 * `vectors`, `w` ends up holding the orthogonal transformation, stored
 * transposed (row `k` of `w` is column `k` of `V`), so every hot loop below
 * walks one row. Without, `w` is scratch.
 */
function tridiagonalize(w: Float64Array[], n: number, d: Float64Array, e: Float64Array, vectors: boolean): void {
  // Below, V[r][c] (JAMA's notation) is stored at w[c][r].
  for (let j = 0; j < n; j++) d[j] = w[j]![n - 1]!;
  for (let i = n - 1; i > 0; i--) {
    const wi = w[i]!;
    let scale = 0;
    let h = 0;
    for (let k = 0; k < i; k++) scale += Math.abs(d[k]!);
    if (scale === 0) {
      e[i] = d[i - 1]!;
      for (let j = 0; j < i; j++) {
        const row = w[j]!;
        d[j] = row[i - 1]!;
        row[i] = 0;
        wi[j] = 0;
      }
    } else {
      for (let k = 0; k < i; k++) {
        d[k]! /= scale;
        h += d[k]! * d[k]!;
      }
      let f = d[i - 1]!;
      let g = Math.sqrt(h);
      if (f > 0) g = -g;
      e[i] = scale * g;
      h -= f * g;
      d[i - 1] = f - g;
      for (let j = 0; j < i; j++) e[j] = 0;
      for (let j = 0; j < i; j++) {
        const row = w[j]!;
        f = d[j]!;
        wi[j] = f;
        g = e[j]! + row[j]! * f;
        for (let k = j + 1; k < i; k++) {
          const x = row[k]!;
          g += x * d[k]!;
          e[k]! += x * f;
        }
        e[j] = g;
      }
      f = 0;
      for (let j = 0; j < i; j++) {
        e[j]! /= h;
        f += e[j]! * d[j]!;
      }
      const hh = f / (h + h);
      for (let j = 0; j < i; j++) e[j]! -= hh * d[j]!;
      for (let j = 0; j < i; j++) {
        const row = w[j]!;
        f = d[j]!;
        g = e[j]!;
        for (let k = j; k < i; k++) row[k]! -= f * e[k]! + g * d[k]!;
        d[j] = row[i - 1]!;
        row[i] = 0;
      }
    }
    d[i] = h;
  }
  if (!vectors) {
    // The reduction leaves the tridiagonal diagonal on the diagonal of w.
    for (let j = 0; j < n; j++) d[j] = w[j]![j]!;
    e[0] = 0;
    return;
  }
  // Accumulate the transformations.
  for (let i = 0; i < n - 1; i++) {
    const row = w[i]!;
    const next = w[i + 1]!;
    row[n - 1] = row[i]!;
    row[i] = 1;
    const h = d[i + 1]!;
    if (h !== 0) {
      for (let k = 0; k <= i; k++) d[k] = next[k]! / h;
      for (let j = 0; j <= i; j++) {
        const target = w[j]!;
        let g = 0;
        for (let k = 0; k <= i; k++) g += next[k]! * target[k]!;
        for (let k = 0; k <= i; k++) target[k]! -= g * d[k]!;
      }
    }
    for (let k = 0; k <= i; k++) next[k] = 0;
  }
  for (let j = 0; j < n; j++) {
    const row = w[j]!;
    d[j] = row[n - 1]!;
    row[n - 1] = 0;
  }
  w[n - 1]![n - 1] = 1;
  e[0] = 0;
}

/**
 * Eigenvalues of the symmetric tridiagonal (`d`, `e`) by implicit QL with
 * Wilkinson shifts (EISPACK `tql2`); with `vectors`, the rotations are applied
 * to the transposed `w` so its rows become the eigenvectors. Unsorted.
 */
function tridiagonalQl(d: Float64Array, e: Float64Array, w: Float64Array[], n: number, vectors: boolean): void {
  for (let i = 1; i < n; i++) e[i - 1] = e[i]!;
  e[n - 1] = 0;
  // Deflate against the norm of the whole tridiagonal matrix (the backward-
  // stable test), which also bounds the shift computation below away from overflow.
  let tst1 = 0;
  for (let i = 0; i < n; i++) tst1 = Math.max(tst1, Math.abs(d[i]!) + Math.abs(e[i]!));
  const small = EPS * tst1;
  let budget = 30 * n;
  let f = 0;
  for (let l = 0; l < n; l++) {
    let m = l;
    while (m < n - 1 && Math.abs(e[m]!) > small) m++;
    if (m > l) {
      do {
        if (budget-- === 0) {
          throw new ConvergenceError(`symmetric QL iteration did not converge in ${30 * n} sweeps`);
        }
        // Shift: the eigenvalue of the leading 2×2 closer to d[l].
        let g = d[l]!;
        let p = (d[l + 1]! - g) / (2 * e[l]!);
        let r = hypot(p, 1);
        if (p < 0) r = -r;
        d[l] = e[l]! / (p + r);
        d[l + 1] = e[l]! * (p + r);
        const dl1 = d[l + 1]!;
        let h = g - d[l]!;
        for (let i = l + 2; i < n; i++) d[i]! -= h;
        f += h;
        // Implicit QL sweep from m up to l.
        p = d[m]!;
        let c = 1;
        let c2 = 1;
        let c3 = 1;
        const el1 = e[l + 1]!;
        let s = 0;
        let s2 = 0;
        for (let i = m - 1; i >= l; i--) {
          c3 = c2;
          c2 = c;
          s2 = s;
          g = c * e[i]!;
          h = c * p;
          r = hypot(p, e[i]!);
          e[i + 1] = s * r;
          s = e[i]! / r;
          c = p / r;
          p = c * d[i]! - s * g;
          d[i + 1] = h + s * (c * g + s * d[i]!);
          if (vectors) {
            const a = w[i]!;
            const b = w[i + 1]!;
            let k = 0;
            // Two entries per pass: fewer loop checks in the hottest loop of the solver.
            for (; k + 1 < n; k += 2) {
              const x0 = b[k]!;
              const y0 = a[k]!;
              const x1 = b[k + 1]!;
              const y1 = a[k + 1]!;
              b[k] = s * y0 + c * x0;
              a[k] = c * y0 - s * x0;
              b[k + 1] = s * y1 + c * x1;
              a[k + 1] = c * y1 - s * x1;
            }
            if (k < n) {
              const x = b[k]!;
              const y = a[k]!;
              b[k] = s * y + c * x;
              a[k] = c * y - s * x;
            }
          }
        }
        p = (-s * s2 * c3 * el1 * e[l]!) / dl1;
        e[l] = s * p;
        d[l] = c * p;
      } while (Math.abs(e[l]!) > small);
    }
    d[l]! += f;
    e[l] = 0;
  }
}

/**
 * Indices `0..n-1` sorted by `compare`: an insertion sort, which is stable and
 * whose O(n²) worst case is nothing next to the O(n³) solve before it.
 */
function order(n: number, compare: (i: number, j: number) => number): number[] {
  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    let at = i;
    while (at > 0 && compare(indices[at - 1]!, i) > 0) {
      indices[at] = indices[at - 1]!;
      at--;
    }
    indices[at] = i;
  }
  return indices;
}

/**
 * The eigenvalues of a symmetric matrix, ascending, repeated by multiplicity.
 * Throws `InvalidArgumentError` when `A` is not symmetric within the tolerance
 * (see the module docs, or pass `{ tolerance }`), and `ConvergenceError` if
 * the QL iteration stalls. Faster than `symmetricEigenDecompose`: no
 * eigenvectors are accumulated.
 */
export function symmetricEigenvalues(a: Matrix, options?: SymmetryOptions): number[] {
  const { w, n, scale } = symmetricInput(a, options);
  const d = new Float64Array(n);
  const e = new Float64Array(n);
  tridiagonalize(w, n, d, e, false);
  tridiagonalQl(d, e, w, n, false);
  d.sort();
  const values: number[] = [];
  for (let i = 0; i < n; i++) values.push(finish(d[i]! / scale));
  return values;
}

/**
 * Eigenvalues and orthonormal eigenvectors of a symmetric matrix, so that
 * `A = V·Λ·Vᵀ` with `V = transpose(vectors)`. Values ascend; `vectors[k]`
 * belongs to `values[k]`, has unit length, and its largest-magnitude entry is
 * positive. Throws like `symmetricEigenvalues`.
 */
export function symmetricEigenDecompose(a: Matrix, options?: SymmetryOptions): SymmetricEigenDecomposition {
  const { w, n, scale } = symmetricInput(a, options);
  const d = new Float64Array(n);
  const e = new Float64Array(n);
  tridiagonalize(w, n, d, e, true);
  tridiagonalQl(d, e, w, n, true);
  const values: number[] = [];
  const vectors: number[][] = [];
  for (const k of order(n, (i, j) => d[i]! - d[j]!)) {
    values.push(finish(d[k]! / scale));
    const row = w[k]!;
    // Sign convention: the largest-magnitude entry (first on a tie) is positive.
    let largest = 0;
    let sign = 1;
    for (let i = 0; i < n; i++) {
      const x = row[i]!;
      if (Math.abs(x) > largest) {
        largest = Math.abs(x);
        sign = x < 0 ? -1 : 1;
      }
    }
    const vector: number[] = [];
    for (let i = 0; i < n; i++) vector.push(finish(sign * row[i]!));
    vectors.push(vector);
  }
  return { values, vectors };
}

/**
 * Balances `h` in place by a diagonal similarity `D⁻¹·A·D` with power-of-two
 * entries (EISPACK `balanc`, scaling only): each row and column pair gets
 * comparable norms, which can make the eigenvalues of a badly scaled matrix
 * far more accurate. Returns the diagonal of `D`.
 */
function balance(h: Float64Array[], n: number): Float64Array {
  const factors = new Float64Array(n).fill(1);
  let done = false;
  while (!done) {
    done = true;
    for (let i = 0; i < n; i++) {
      const hi = h[i]!;
      let c = 0;
      let r = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        c += Math.abs(h[j]![i]!);
        r += Math.abs(hi[j]!);
      }
      if (c === 0 || r === 0) continue;
      let g = r / 2;
      let f = 1;
      const s = c + r;
      while (c < g) {
        f *= 2;
        c *= 4;
      }
      g = r * 2;
      while (c > g) {
        f /= 2;
        c /= 4;
      }
      if ((c + r) / f < 0.95 * s) {
        done = false;
        factors[i]! *= f;
        const inverseF = 1 / f;
        for (let j = 0; j < n; j++) hi[j]! *= inverseF;
        for (let j = 0; j < n; j++) h[j]![i]! *= f;
      }
    }
  }
  return factors;
}

/**
 * Householder reduction of `h` to upper Hessenberg form (EISPACK `orthes`, as
 * in JAMA). With `vt`, also forms the orthogonal transformation, stored
 * transposed (`vt[j][i]` is `V[i][j]`). Zeroes everything below the subdiagonal.
 */
function hessenberg(h: Float64Array[], n: number, vt?: Float64Array[]): void {
  const ort = new Float64Array(n);
  const sums = new Float64Array(n);
  for (let m = 1; m <= n - 2; m++) {
    let scale = 0;
    for (let i = m; i < n; i++) scale += Math.abs(h[i]![m - 1]!);
    if (scale === 0) continue;
    let hh = 0;
    for (let i = n - 1; i >= m; i--) {
      ort[i] = h[i]![m - 1]! / scale;
      hh += ort[i]! * ort[i]!;
    }
    let g = Math.sqrt(hh);
    if (ort[m]! > 0) g = -g;
    hh -= ort[m]! * g;
    ort[m]! -= g;
    // H ← (I − u·uᵀ/hh)·H: column sums first, a row at a time.
    sums.fill(0);
    for (let i = n - 1; i >= m; i--) {
      const o = ort[i]!;
      const row = h[i]!;
      for (let j = m; j < n; j++) sums[j]! += o * row[j]!;
    }
    for (let j = m; j < n; j++) sums[j]! /= hh;
    for (let i = m; i < n; i++) {
      const o = ort[i]!;
      const row = h[i]!;
      for (let j = m; j < n; j++) row[j]! -= sums[j]! * o;
    }
    // H ← H·(I − u·uᵀ/hh).
    for (const row of h) {
      let f = 0;
      for (let j = n - 1; j >= m; j--) f += ort[j]! * row[j]!;
      f /= hh;
      for (let j = m; j < n; j++) row[j]! -= f * ort[j]!;
    }
    ort[m]! *= scale;
    h[m]![m - 1] = scale * g;
  }
  if (vt) {
    for (const [i, row] of vt.entries()) {
      row.fill(0);
      row[i] = 1;
    }
    for (let m = n - 2; m >= 1; m--) {
      const sub = h[m]![m - 1]!;
      if (sub === 0) continue;
      for (let i = m + 1; i < n; i++) ort[i] = h[i]![m - 1]!;
      for (let j = m; j < n; j++) {
        const row = vt[j]!;
        let g = 0;
        for (let i = m; i < n; i++) g += ort[i]! * row[i]!;
        // Double division avoids possible underflow.
        g = g / ort[m]! / sub;
        for (let i = m; i < n; i++) row[i]! += g * ort[i]!;
      }
    }
  }
  for (let i = 2; i < n; i++) h[i]!.fill(0, 0, i - 1);
}

/** Smith's complex division `(xr + xi·i) / (yr + yi·i)` into `out`. */
function complexDivide(xr: number, xi: number, yr: number, yi: number, out: Float64Array): void {
  if (Math.abs(yr) > Math.abs(yi)) {
    const r = yi / yr;
    const d = yr + r * yi;
    out[0] = (xr + r * xi) / d;
    out[1] = (xi - r * xr) / d;
  } else {
    const r = yr / yi;
    const d = yi + r * yr;
    out[0] = (r * xr + xi) / d;
    out[1] = (r * xi - xr) / d;
  }
}

/**
 * Francis double-shift QR on the Hessenberg `h` (EISPACK `hqr2`, as in JAMA,
 * plus an iteration cap). Writes eigenvalue `k` as `d[k] + e[k]·i`; a complex
 * pair sits at `k, k+1` with `e[k] > 0`. With `vt`, the rows of `vt` become
 * the eigenvectors of the matrix `vt` was formed for: row `k` alone for a
 * real eigenvalue, rows `k` (real part) and `k+1` (imaginary part) for the
 * pair's `e[k] > 0` member. Without `vt`, only the active block is updated
 * (EISPACK `hqr`).
 */
function francisQr(h: Float64Array[], n: number, d: Float64Array, e: Float64Array, vt?: Float64Array[]): void {
  const maxIterations = 30 * Math.max(10, n);
  let norm = 0;
  for (let i = 0; i < n; i++) {
    const row = h[i]!;
    for (let j = Math.max(i - 1, 0); j < n; j++) norm += Math.abs(row[j]!);
  }
  // The zero matrix: every eigenvalue is 0 and `vt` (the identity) already holds the vectors.
  // Returning here also keeps the deflation tests below from comparing 0 < ε·0.
  if (norm === 0) return;
  let en = n - 1;
  let exshift = 0;
  let iter = 0;
  let p = 0;
  let q = 0;
  let r = 0;
  let s = 0;
  let z = 0;
  let w: number;
  let x: number;
  let y: number;
  while (en >= 0) {
    // Look for a single small subdiagonal element.
    let l = en;
    while (l > 0) {
      s = Math.abs(h[l - 1]![l - 1]!) + Math.abs(h[l]![l]!);
      if (s === 0) s = norm;
      if (Math.abs(h[l]![l - 1]!) < EPS * s) break;
      l--;
    }
    const hEn = h[en]!;
    if (l === en) {
      // One root found.
      hEn[en]! += exshift;
      d[en] = hEn[en]!;
      e[en] = 0;
      en--;
      iter = 0;
    } else if (l === en - 1) {
      // Two roots found.
      const nm = en - 1;
      const hNm = h[nm]!;
      w = hEn[nm]! * hNm[en]!;
      p = (hNm[nm]! - hEn[en]!) / 2;
      q = p * p + w;
      z = Math.sqrt(Math.abs(q));
      hEn[en]! += exshift;
      hNm[nm]! += exshift;
      x = hEn[en]!;
      if (q >= 0) {
        // A real pair.
        z = p >= 0 ? p + z : p - z;
        d[nm] = x + z;
        d[en] = z === 0 ? x + z : x - w / z;
        e[nm] = 0;
        e[en] = 0;
        if (vt) {
          x = hEn[nm]!;
          s = Math.abs(x) + Math.abs(z);
          p = x / s;
          q = z / s;
          r = Math.hypot(p, q);
          p /= r;
          q /= r;
          for (let j = nm; j < n; j++) {
            z = hNm[j]!;
            hNm[j] = q * z + p * hEn[j]!;
            hEn[j] = q * hEn[j]! - p * z;
          }
          for (let i = 0; i <= en; i++) {
            const row = h[i]!;
            z = row[nm]!;
            row[nm] = q * z + p * row[en]!;
            row[en] = q * row[en]! - p * z;
          }
          const a = vt[nm]!;
          const b = vt[en]!;
          for (let i = 0; i < n; i++) {
            z = a[i]!;
            a[i] = q * z + p * b[i]!;
            b[i] = q * b[i]! - p * z;
          }
        }
      } else {
        // A complex pair.
        d[nm] = x + p;
        d[en] = x + p;
        e[nm] = z;
        e[en] = -z;
      }
      en -= 2;
      iter = 0;
    } else {
      // No convergence yet: form the shift.
      const hNm = h[en - 1]!;
      x = hEn[en]!;
      y = hNm[en - 1]!;
      w = hEn[en - 1]! * hNm[en]!;
      if (iter === 10) {
        // Wilkinson's original ad hoc shift.
        exshift += x;
        for (let i = 0; i <= en; i++) h[i]![i]! -= x;
        s = Math.abs(hEn[en - 1]!) + Math.abs(hNm[en - 2]!);
        x = 0.75 * s;
        y = x;
        w = -0.4375 * s * s;
      }
      if (iter === 30) {
        // MATLAB's ad hoc shift.
        s = (y - x) / 2;
        s = s * s + w;
        if (s > 0) {
          s = Math.sqrt(s);
          if (y < x) s = -s;
          s = x - w / ((y - x) / 2 + s);
          for (let i = 0; i <= en; i++) h[i]![i]! -= s;
          exshift += s;
          x = 0.964;
          y = x;
          w = x;
        }
      }
      iter++;
      if (iter > maxIterations) {
        throw new ConvergenceError(`QR iteration did not converge in ${maxIterations} sweeps for eigenvalue ${en}`);
      }
      // Look for two consecutive small subdiagonal elements.
      let m = en - 2;
      while (m >= l) {
        const hm = h[m]!;
        const hm1 = h[m + 1]!;
        z = hm[m]!;
        r = x - z;
        s = y - z;
        p = (r * s - w) / hm1[m]! + hm[m + 1]!;
        q = hm1[m + 1]! - z - r - s;
        r = h[m + 2]![m + 1]!;
        s = Math.abs(p) + Math.abs(q) + Math.abs(r);
        p /= s;
        q /= s;
        r /= s;
        if (m === l) break;
        if (
          Math.abs(hm[m - 1]!) * (Math.abs(q) + Math.abs(r)) <
          EPS * (Math.abs(p) * (Math.abs(h[m - 1]![m - 1]!) + Math.abs(z) + Math.abs(hm1[m + 1]!)))
        ) {
          break;
        }
        m--;
      }
      for (let i = m + 2; i <= en; i++) {
        const row = h[i]!;
        row[i - 2] = 0;
        if (i > m + 2) row[i - 3] = 0;
      }
      // Double QR step on rows l..en and columns m..en (the whole matrix with vt).
      const rowEnd = vt ? n : en + 1;
      const columnStart = vt ? 0 : l;
      for (let k = m; k <= en - 1; k++) {
        const notLast = k !== en - 1;
        const h0 = h[k]!;
        const h1 = h[k + 1]!;
        if (k !== m) {
          p = h0[k - 1]!;
          q = h1[k - 1]!;
          r = notLast ? h[k + 2]![k - 1]! : 0;
          x = Math.abs(p) + Math.abs(q) + Math.abs(r);
          if (x === 0) continue;
          p /= x;
          q /= x;
          r /= x;
        }
        // eslint-disable-next-line unicorn/prefer-modern-math-apis -- p, q, r are already scaled by their sum; Math.hypot's own scaling is slow in the QR sweep
        s = Math.sqrt(p * p + q * q + r * r);
        if (p < 0) s = -s;
        if (s === 0) continue;
        if (k !== m) h0[k - 1] = -s * x;
        else if (l !== m) h0[k - 1] = -h0[k - 1]!;
        p += s;
        x = p / s;
        y = q / s;
        z = r / s;
        q /= p;
        r /= p;
        if (notLast) {
          const h2 = h[k + 2]!;
          for (let j = k; j < rowEnd; j++) {
            const t = h0[j]! + q * h1[j]! + r * h2[j]!;
            h0[j]! -= t * x;
            h1[j]! -= t * y;
            h2[j]! -= t * z;
          }
        } else {
          for (let j = k; j < rowEnd; j++) {
            const t = h0[j]! + q * h1[j]!;
            h0[j]! -= t * x;
            h1[j]! -= t * y;
          }
        }
        const lastRow = Math.min(en, k + 3);
        for (let i = columnStart; i <= lastRow; i++) {
          const row = h[i]!;
          let t = x * row[k]! + y * row[k + 1]!;
          if (notLast) {
            t += z * row[k + 2]!;
            row[k + 2]! -= t * r;
          }
          row[k]! -= t;
          row[k + 1]! -= t * q;
        }
        if (vt) {
          const v0 = vt[k]!;
          const v1 = vt[k + 1]!;
          if (notLast) {
            const v2 = vt[k + 2]!;
            for (let i = 0; i < n; i++) {
              const t = x * v0[i]! + y * v1[i]! + z * v2[i]!;
              v0[i]! -= t;
              v1[i]! -= t * q;
              v2[i]! -= t * r;
            }
          } else {
            for (let i = 0; i < n; i++) {
              const t = x * v0[i]! + y * v1[i]!;
              v0[i]! -= t;
              v1[i]! -= t * q;
            }
          }
        }
      }
    }
  }
  if (!vt) return;

  // Back-substitute to find the eigenvectors of the quasi-triangular form.
  const quotient = new Float64Array(2);
  for (en = n - 1; en >= 0; en--) {
    p = d[en]!;
    q = e[en]!;
    if (q === 0) {
      // A real vector.
      let l = en;
      h[en]![en] = 1;
      for (let i = en - 1; i >= 0; i--) {
        const row = h[i]!;
        w = row[i]! - p;
        r = 0;
        for (let j = l; j <= en; j++) r += row[j]! * h[j]![en]!;
        if (e[i]! < 0) {
          z = w;
          s = r;
          continue;
        }
        l = i;
        if (e[i] === 0) {
          row[en] = w === 0 ? -r / (EPS * norm) : -r / w;
        } else {
          const below = h[i + 1]!;
          x = row[i + 1]!;
          y = below[i]!;
          q = (d[i]! - p) * (d[i]! - p) + e[i]! * e[i]!;
          const t = (x * s - z * r) / q;
          row[en] = t;
          below[en] = Math.abs(x) > Math.abs(z) ? (-r - w * t) / x : (-s - y * t) / z;
        }
        // Overflow control.
        const t = Math.abs(row[en]!);
        if (EPS * t * t > 1) for (let j = i; j <= en; j++) h[j]![en]! /= t;
      }
    } else if (q < 0) {
      // A complex vector, for the pair member d[en−1] + e[en−1]·i.
      const nm = en - 1;
      const hNm = h[nm]!;
      const hEn = h[en]!;
      let l = nm;
      if (Math.abs(hEn[nm]!) > Math.abs(hNm[en]!)) {
        hNm[nm] = q / hEn[nm]!;
        hNm[en] = -(hEn[en]! - p) / hEn[nm]!;
      } else {
        complexDivide(0, -hNm[en]!, hNm[nm]! - p, q, quotient);
        hNm[nm] = quotient[0]!;
        hNm[en] = quotient[1]!;
      }
      hEn[nm] = 0;
      hEn[en] = 1;
      for (let i = en - 2; i >= 0; i--) {
        const row = h[i]!;
        let ra = 0;
        let sa = 0;
        for (let j = l; j <= en; j++) {
          const hj = h[j]!;
          ra += row[j]! * hj[nm]!;
          sa += row[j]! * hj[en]!;
        }
        w = row[i]! - p;
        if (e[i]! < 0) {
          z = w;
          r = ra;
          s = sa;
          continue;
        }
        l = i;
        if (e[i] === 0) {
          complexDivide(-ra, -sa, w, q, quotient);
          row[nm] = quotient[0]!;
          row[en] = quotient[1]!;
        } else {
          const below = h[i + 1]!;
          x = row[i + 1]!;
          y = below[i]!;
          let vr = (d[i]! - p) * (d[i]! - p) + e[i]! * e[i]! - q * q;
          const vi = (d[i]! - p) * 2 * q;
          if (vr === 0 && vi === 0) {
            vr = EPS * norm * (Math.abs(w) + Math.abs(q) + Math.abs(x) + Math.abs(y) + Math.abs(z));
          }
          complexDivide(x * r - z * ra + q * sa, x * s - z * sa - q * ra, vr, vi, quotient);
          row[nm] = quotient[0]!;
          row[en] = quotient[1]!;
          if (Math.abs(x) > Math.abs(z) + Math.abs(q)) {
            below[nm] = (-ra - w * row[nm] + q * row[en]!) / x;
            below[en] = (-sa - w * row[en]! - q * row[nm]) / x;
          } else {
            complexDivide(-r - y * row[nm], -s - y * row[en]!, z, q, quotient);
            below[nm] = quotient[0]!;
            below[en] = quotient[1]!;
          }
        }
        // Overflow control.
        const t = Math.max(Math.abs(row[nm]), Math.abs(row[en]!));
        if (EPS * t * t > 1) {
          for (let j = i; j <= en; j++) {
            const hj = h[j]!;
            hj[nm]! /= t;
            hj[en]! /= t;
          }
        }
      }
    }
  }

  // Back-transform: column j of V ← Σ_{k ≤ j} V[:, k]·H[k][j], a row of vt at a time.
  const accumulator = new Float64Array(n);
  for (let j = n - 1; j >= 0; j--) {
    accumulator.fill(0);
    for (let k = 0; k <= j; k++) {
      const f = h[k]![j]!;
      if (f === 0) continue;
      const row = vt[k]!;
      for (let i = 0; i < n; i++) accumulator[i]! += row[i]! * f;
    }
    vt[j]!.set(accumulator);
  }
}

/** Scales and balances a validated copy of `a`; `factors` is the balancing diagonal `D`. */
function generalInput(a: Matrix): { n: number; h: Float64Array[]; scale: number; factors: Float64Array } {
  const n = assertSquare(a, 'a');
  const { work: h, scale } = scaledCopy(a, n);
  return { n, h, scale, factors: balance(h, n) };
}

/** Eigenvalue indices sorted by real part, then imaginary part. */
function complexOrder(d: Float64Array, e: Float64Array, n: number): number[] {
  return order(n, (i, j) => d[i]! - d[j]! || e[i]! - e[j]!);
}

/**
 * The eigenvalues of any real square matrix, as `Complex` values sorted by
 * real part, then imaginary part, repeated by multiplicity. A real eigenvalue
 * has an imaginary part of exactly `0`; complex ones come in conjugate pairs.
 * For a symmetric matrix, `symmetricEigenvalues` is faster and returns plain
 * numbers. Throws `ConvergenceError` if the QR iteration stalls.
 */
export function eigenvalues(a: Matrix): Complex[] {
  const { n, h, scale } = generalInput(a);
  hessenberg(h, n);
  const d = new Float64Array(n);
  const e = new Float64Array(n);
  francisQr(h, n, d, e);
  return complexOrder(d, e, n).map(k => Complex.fromParts(finish(d[k]! / scale), finish(e[k]! / scale)));
}

/**
 * Eigenvalues and eigenvectors of any real square matrix: `A·v = λ·v` for
 * `λ = values[k]`, `v = vectors[k]`. Values are sorted as in `eigenvalues`.
 * Each vector has unit length with its largest-magnitude entry real and
 * positive; a real eigenvalue's vector has real entries, and conjugate
 * eigenvalues have conjugate vectors. For a defective matrix the vectors of a
 * repeated eigenvalue are (nearly) parallel: there is no full basis to find.
 * Throws `ConvergenceError` if the QR iteration stalls.
 */
export function eigenDecompose(a: Matrix): EigenDecomposition {
  const { n, h, scale, factors } = generalInput(a);
  const v = squareRows(n);
  hessenberg(h, n, v);
  const d = new Float64Array(n);
  const e = new Float64Array(n);
  francisQr(h, n, d, e, v);
  // Undo the balancing: x = D·y.
  for (const row of v) for (let i = 0; i < n; i++) row[i]! *= factors[i]!;
  const im = new Float64Array(n);
  const unit: Complex[][] = [];
  for (let k = 0; k < n; k++) {
    const imag = e[k]!;
    if (imag === 0) {
      im.fill(0);
      unit.push(unitVector(v[k]!, im, n));
    } else if (imag > 0) {
      // Rows k and k+1 hold the real and imaginary parts for d[k] + e[k]·i.
      const vector = unitVector(v[k]!, v[k + 1]!, n);
      unit.push(
        vector,
        vector.map(z => z.conjugate()),
      );
      k++;
    }
  }
  const values: Complex[] = [];
  const vectors: Complex[][] = [];
  for (const k of complexOrder(d, e, n)) {
    values.push(Complex.fromParts(finish(d[k]! / scale), finish(e[k]! / scale)));
    vectors.push(unit[k]!);
  }
  return { values, vectors };
}

/**
 * `re + im·i` scaled to unit length with its largest-magnitude entry real and
 * positive. Scaled by the largest part first, so no square overflows. Uses
 * `re` and `im` as scratch.
 */
function unitVector(re: Float64Array, im: Float64Array, n: number): Complex[] {
  let largest = 0;
  for (let i = 0; i < n; i++) largest = Math.max(largest, Math.abs(re[i]!), Math.abs(im[i]!));
  if (largest === 0) throw new ConvergenceError('the QR iteration produced a zero eigenvector');
  let at = 0;
  let best = -1;
  for (let i = 0; i < n; i++) {
    re[i]! /= largest;
    im[i]! /= largest;
    const modulus = re[i]! * re[i]! + im[i]! * im[i]!;
    if (modulus > best) {
      best = modulus;
      at = i;
    }
  }
  // Divide by the pivot entry (|pivot|² = best, in [1, 2]): it becomes exactly 1.
  const pr = re[at]!;
  const pi = im[at]!;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = re[i]!;
    const b = im[i]!;
    re[i] = (a * pr + b * pi) / best;
    im[i] = (b * pr - a * pi) / best;
    sum += re[i]! * re[i]! + im[i]! * im[i]!;
  }
  const length = Math.sqrt(sum);
  const vector: Complex[] = [];
  for (let i = 0; i < n; i++) vector.push(Complex.fromParts(finish(re[i]! / length), finish(im[i]! / length)));
  return vector;
}
