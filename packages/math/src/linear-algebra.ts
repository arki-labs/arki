/**
 * Lean dense linear algebra over plain JS numbers (float64): vectors, small to
 * medium matrices, LU with partial pivoting, QR with column pivoting,
 * Cholesky, the singular value decomposition, least squares, eigenvalues and
 * eigenvectors. For symbolic algebra or sparse storage, reach for a full CAS
 * such as mathjs.
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
 * exactly singular. Rank decisions use one rule everywhere, NumPy's
 * `matrix_rank`: a singular value counts as zero at or below
 * `max(m, n) · Number.EPSILON · σ₁` (σ₁ the largest). `rank`, `pseudoInverse`
 * and the rank-deficient path of `leastSquares` apply it to singular values;
 * `qrDecompose` and the full-rank test of `leastSquares` apply it to the
 * diagonal of a column-pivoted `R`, where `|r₀₀|` stands in for σ₁ (it is
 * within a factor `√n` of it). Each function takes `{ tolerance }` to replace
 * the default with an absolute threshold. `determinant` never throws for a
 * singular matrix; it returns the product of the pivots, which may be tiny
 * rather than exactly zero.
 *
 * **Orthogonal factorizations and least squares.** `qrDecompose` is
 * Householder QR with column pivoting (LAPACK `dgeqp3`; `{ pivoting: false }`
 * for plain QR). `choleskyDecompose` / `choleskySolve` factor a symmetric
 * positive definite matrix as `L·Lᵀ` (`dpotrf`); a matrix that is not throws
 * `NotPositiveDefiniteError`. `singularValues` / `singularValueDecompose` are
 * Golub–Kahan–Reinsch: Householder bidiagonalization and implicit-shift QR
 * (LINPACK `dsvdc`, as in JAMA), backward stable, singular values descending.
 * `leastSquares` solves `min ‖A·x − b‖₂` by pivoted QR and, when `A` is
 * rank-deficient or wide, returns the minimum-norm solution from the SVD;
 * neither path forms the normal equations `AᵀA`, which square the condition
 * number. Column pivoting reveals rank on all but contrived inputs (Kahan's
 * matrix defeats it); the SVD never misses. `conditionNumber` is `σ₁ / σₖ`;
 * `pseudoInverse` is `V·Σ⁺·Uᵀ`. The SVD's QR iteration is capped at 75 sweeps
 * per singular value (typically 2 or 3 are needed); past the cap it throws
 * `ConvergenceError`. Like the eigen routines, all of these work on a copy
 * scaled by a power of two, so entries near the float64 limits neither
 * overflow nor underflow.
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
 * QR (`dgeev`/`dgebal`/`dlahqr`) for general input. The matrix is first scaled
 * by a power of two (exact) so entries near the float64 limits neither overflow
 * nor underflow. Results are backward stable: each eigenpair satisfies
 * `‖A·v − λ·v‖ ≈ n · ε · ‖A‖`. Balancing trades a little of that for accuracy
 * when it rescales strongly: a nearly defective or graded matrix keeps far more
 * accurate eigenvalues, with residuals up to a few hundred `n · ε · ‖A‖`, as
 * LAPACK's `dgeev` gives. Entries far below `ε · ‖A‖` (round-off left over from
 * a cancellation, say) can make balancing rescale a whole row, and then the
 * eigenvectors may be poor, as in LAPACK and MATLAB: zero such entries first. Eigenvalues of a defective matrix (a Jordan
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
  NotPositiveDefiniteError,
  NumericRangeError,
  ResourceLimitError,
  SingularMatrixError,
} from './errors.js';
import { applyQTranspose, backSubstitute, householderQr } from './internal/householder.js';
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
  // eslint-disable-next-line unicorn/prefer-spread -- slice keeps JavaScriptCore's unboxed double storage; a spread copy boxes the entries and makes elimination about 2× slower in Bun
  const lu = a.map(row => row.slice());
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

/** Options for `rank`. */
export type RankOptions = ToleranceOptions & {
  /**
   * `'svd'` (the default) counts singular values above the tolerance, the
   * reliable rank test. `'elimination'` counts pivots of row echelon form with
   * partial pivoting: several times faster, but on badly conditioned input it
   * can miss a near-dependence that the singular values show.
   */
  method?: 'svd' | 'elimination';
};

/**
 * The number of linearly independent rows (equivalently, columns) of any
 * `m×n` matrix. By default it counts the singular values above
 * `max(m, n) · Number.EPSILON · σ₁` (σ₁ the largest), the rule of NumPy's
 * `matrix_rank`, so `rank`, `pseudoInverse` and `leastSquares` agree.
 * `{ method: 'elimination' }` counts row echelon pivots above
 * `max(m, n) · Number.EPSILON · ‖A‖∞` instead. `{ tolerance }` replaces the
 * default with an absolute threshold for whichever quantity is counted.
 */
export function rank(a: Matrix, options?: RankOptions): number {
  const [rows, columns] = assertMatrix(a, 'a');
  const method = options?.method ?? 'svd';
  if (method === 'elimination') return eliminationRank(a, rows, columns, options);
  if (method !== 'svd') throw new InvalidArgumentError(`method must be 'svd' or 'elimination', got ${String(method)}`);
  const { values, scale } = svdOf(a, rows, columns, false);
  const tolerance =
    options?.tolerance === undefined
      ? Math.max(rows, columns) * EPS * values[0]!
      : resolveTolerance(options, () => 0) * scale;
  let r = 0;
  for (const value of values) if (value > tolerance) r++;
  return r;
}

function eliminationRank(a: Matrix, rows: number, columns: number, options: ToleranceOptions | undefined): number {
  const tolerance = resolveTolerance(options, () => Math.max(rows, columns) * Number.EPSILON * normInfinity(a));
  // eslint-disable-next-line unicorn/prefer-spread -- slice keeps JavaScriptCore's unboxed double storage; a spread copy boxes the entries and makes elimination about 2× slower in Bun
  const work = a.map(row => row.slice());
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
const MIN_NORMAL = 2 ** -1022;

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
  return bufferRows(n, n);
}

/** `count` zeroed rows of length `length`, as views on one buffer. */
function bufferRows(count: number, length: number): Float64Array[] {
  const buffer = new Float64Array(count * length);
  const rows: Float64Array[] = [];
  for (let i = 0; i < count; i++) rows.push(buffer.subarray(i * length, i * length + length));
  return rows;
}

/** The power of two that brings `largest` near 1 (`1` for zero); scaling by it is exact. */
function powerOfTwoScale(largest: number): number {
  const exponent = largest === 0 ? 0 : Math.max(-1020, Math.min(1020, Math.round(Math.log2(largest))));
  return 2 ** -exponent;
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
  const scale = powerOfTwoScale(largest);
  if (scale !== 1) for (const row of work) for (let j = 0; j < n; j++) row[j]! *= scale;
  return { work, scale };
}

/** Validates, scales and symmetrizes `a`; throws `InvalidArgumentError` if it is not symmetric. */
function symmetricInput(a: Matrix, options?: SymmetryOptions): { w: Float64Array[]; n: number; scale: number } {
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

/** A balancing similarity `A = P·D·B·D⁻¹·Pᵀ` (LAPACK `dgebal`): see `balance`. */
type Balancing = {
  /** The diagonal of `D`; 1 outside `low..high`. */
  readonly factors: Float64Array;
  /** Outside `low..high`, the index row/column `j` was swapped with (LAPACK's `SCALE`). */
  readonly swaps: Int32Array;
  readonly low: number;
  readonly high: number;
};

/** Smallest and largest safe balancing factors (LAPACK `SFMIN1`/`SFMAX1`, `SFMIN2`/`SFMAX2`). */
const SAFE_MIN = MIN_NORMAL / EPS;
const SAFE_MAX = 1 / SAFE_MIN;
const SAFE_MIN2 = SAFE_MIN * 2;
const SAFE_MAX2 = 1 / SAFE_MIN2;

/** Swaps rows `i` and `j` and columns `i` and `j` of `h`: a permutation similarity. */
function swapRowsAndColumns(h: Float64Array[], i: number, j: number): void {
  for (const row of h) {
    const t = row[i]!;
    row[i] = row[j]!;
    row[j] = t;
  }
  const a = h[i]!;
  const b = h[j]!;
  for (let k = 0; k < a.length; k++) {
    const t = a[k]!;
    a[k] = b[k]!;
    b[k] = t;
  }
}

/**
 * Balances `h` in place (LAPACK 3.5+ `dgebal`). First a permutation moves rows
 * and columns that isolate an eigenvalue out of the way, leaving the block
 * `low..high`; then a diagonal similarity `D⁻¹·B·D` with power-of-two entries
 * gives each row and column of that block comparable norms, which can make the
 * eigenvalues of a badly scaled matrix far more accurate. The norms include
 * the diagonal (James, Langou & Lowery, 2014): EISPACK's `balanc` left it out,
 * so an entry far below rounding level (1e-100 next to 7) drove `D` to 1e56,
 * and `x = D·y` then turned the round-off in `y` into eigenvectors with a
 * residual of order `‖A‖`.
 */
function balance(h: Float64Array[], n: number): Balancing {
  const factors = new Float64Array(n).fill(1);
  const swaps = new Int32Array(n);
  for (let i = 0; i < n; i++) swaps[i] = i;
  let low = 0;
  let high = n - 1;
  // Push rows with no off-diagonal entry in columns low..high to the bottom: each isolates an eigenvalue.
  let moved = true;
  while (moved) {
    moved = false;
    for (let i = high; i >= 0; i--) {
      const row = h[i]!;
      let isolated = true;
      for (let j = 0; j <= high; j++) {
        if (j !== i && row[j] !== 0) {
          isolated = false;
          break;
        }
      }
      if (!isolated) continue;
      swaps[high] = i;
      if (i !== high) swapRowsAndColumns(h, i, high);
      moved = true;
      if (high === 0) return { factors, swaps, low: 0, high: 0 };
      high--;
    }
  }
  // Push columns with no off-diagonal entry in rows low..high to the left.
  moved = true;
  while (moved) {
    moved = false;
    for (let j = low, last = high; j <= last; j++) {
      let isolated = true;
      for (let i = low; i <= high; i++) {
        if (i !== j && h[i]![j] !== 0) {
          isolated = false;
          break;
        }
      }
      if (!isolated) continue;
      swaps[low] = j;
      if (j !== low) swapRowsAndColumns(h, j, low);
      moved = true;
      low++;
    }
  }
  // Scale rows and columns low..high (LAPACK 3.5+ `dgebal`): 2-norms that include the diagonal.
  let done = false;
  while (!done) {
    done = true;
    for (let i = low; i <= high; i++) {
      const hi = h[i]!;
      let c = 0;
      let r = 0;
      for (let j = low; j <= high; j++) {
        c = hypot(c, h[j]![i]!);
        r = hypot(r, hi[j]!);
      }
      let ca = 0;
      for (let j = 0; j <= high; j++) ca = Math.max(ca, Math.abs(h[j]![i]!));
      let ra = 0;
      for (let j = low; j < n; j++) ra = Math.max(ra, Math.abs(hi[j]!));
      if (c === 0 || r === 0) continue;
      let g = r / 2;
      let f = 1;
      const s = c + r;
      while (c < g && Math.max(f, c, ca) < SAFE_MAX2 && Math.min(r, g, ra) > SAFE_MIN2) {
        f *= 2;
        c *= 2;
        ca *= 2;
        r /= 2;
        g /= 2;
        ra /= 2;
      }
      g = c / 2;
      while (g >= r && Math.max(r, ra) < SAFE_MAX2 && Math.min(f, c, g, ca) > SAFE_MIN2) {
        f /= 2;
        c /= 2;
        g /= 2;
        ca /= 2;
        r *= 2;
        ra *= 2;
      }
      if (c + r >= 0.95 * s) continue;
      const factor = factors[i]!;
      if (f < 1 && factor < 1 && f * factor <= SAFE_MIN) continue;
      if (f > 1 && factor > 1 && factor >= SAFE_MAX / f) continue;
      done = false;
      factors[i] = factor * f;
      const inverseF = 1 / f;
      for (let j = 0; j < n; j++) hi[j]! *= inverseF;
      for (let j = 0; j < n; j++) h[j]![i]! *= f;
    }
  }
  return { factors, swaps, low, high };
}

/** Maps each eigenvector row `y` of `vt` (of the balanced matrix) back to `x = P·D·y` (LAPACK `dgebak`). */
function unbalance(vt: Float64Array[], n: number, { factors, swaps, low, high }: Balancing): void {
  for (const row of vt) {
    for (let i = low; i <= high; i++) row[i]! *= factors[i]!;
    // Undo the swaps in reverse: the column pushes (low−1 down to 0), then the row pushes (high+1 up to n−1).
    for (let k = 0; k < n; k++) {
      if (k >= low && k <= high) continue;
      const i = k < low ? low - 1 - k : k;
      const j = swaps[i]!;
      if (j === i) continue;
      const t = row[i]!;
      row[i] = row[j]!;
      row[j] = t;
    }
  }
}

/**
 * Householder reduction of `h` to upper Hessenberg form (EISPACK `orthes`, as
 * in JAMA). With `vt`, also forms the orthogonal transformation, stored
 * transposed (`vt[j][i]` is `V[i][j]`). Zeroes everything below the subdiagonal.
 */
function hessenberg(h: Float64Array[], n: number, vt?: Float64Array[]): void {
  const ort = new Float64Array(n);
  const sums = new Float64Array(n);
  // Per column, the scale and `hh` of its reflector `I − v·vᵀ/hh` (`v` = column / scale).
  const scales = new Float64Array(n);
  const norms = new Float64Array(n);
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
    scales[m] = scale;
    norms[m] = hh;
    h[m]![m - 1] = scale * g;
  }
  if (vt) {
    for (const [i, row] of vt.entries()) {
      row.fill(0);
      row[i] = 1;
    }
    for (let m = n - 2; m >= 1; m--) {
      const scale = scales[m]!;
      if (scale === 0) continue;
      // The reflector in its scaled form: EISPACK's unscaled one divides by scale², which
      // underflows to 0 for a subnormal column.
      for (let i = m + 1; i < n; i++) ort[i] = h[i]![m - 1]! / scale;
      const hh = norms[m]!;
      for (let j = m; j < n; j++) {
        const row = vt[j]!;
        let g = 0;
        for (let i = m; i < n; i++) g += ort[i]! * row[i]!;
        g /= hh;
        for (let i = m; i < n; i++) row[i]! -= g * ort[i]!;
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
 * plus an iteration cap, LAPACK `dlahqr`'s deflation test and LAPACK `dtrevc`'s
 * guard on tiny pivots in the back-substitution). Writes eigenvalue `k` as `d[k] + e[k]·i`; a complex
 * pair sits at `k, k+1` with `e[k] > 0`. With `vt`, the rows of `vt` become
 * the eigenvectors of the matrix `vt` was formed for: row `k` alone for a
 * real eigenvalue, rows `k` (real part) and `k+1` (imaginary part) for the
 * pair's `e[k] > 0` member. Without `vt`, only the active block is updated
 * (EISPACK `hqr`).
 */
function francisQr(h: Float64Array[], n: number, d: Float64Array, e: Float64Array, vt?: Float64Array[]): void {
  const maxIterations = 30 * Math.max(10, n);
  // LAPACK's SMLNUM: a subdiagonal this small is negligible outright.
  const tiny = (MIN_NORMAL * n) / EPS;
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
      const hl = h[l]!;
      const sub = Math.abs(hl[l - 1]!);
      if (sub <= tiny) break;
      const corner = h[l - 1]![l - 1]!;
      s = Math.abs(corner) + Math.abs(hl[l]!);
      if (s === 0) s = norm;
      if (sub < EPS * s) {
        // Ahues & Kressner's conservative test (LAPACK `dlahqr`): it weighs the product
        // h[l][l−1]·h[l−1][l], which a diagonal (balancing) similarity leaves unchanged.
        const sup = Math.abs(h[l - 1]![l]!);
        const ab = Math.max(sub, sup);
        const ba = Math.min(sub, sup);
        const diagonal = Math.abs(hl[l]!);
        const gap = Math.abs(corner - hl[l]!);
        const aa = Math.max(diagonal, gap);
        const bb = Math.min(diagonal, gap);
        const sum = aa + ab;
        if (ba * (ab / sum) <= Math.max(tiny, EPS * (bb * (aa / sum)))) break;
      }
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
      const smin = Math.max(EPS * Math.abs(p), tiny);
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
          // A pivot below smin is raised to it (LAPACK `dlaln2`), and the vector is scaled
          // down first when the quotient would overflow.
          const pivot = Math.abs(w) < smin ? smin : w;
          if (Math.abs(r) > 1 && Math.abs(pivot) < 1 && Math.abs(r) > Math.abs(pivot) / tiny) {
            const shrink = 1 / Math.abs(r);
            for (let j = i + 1; j <= en; j++) h[j]![en]! *= shrink;
            r *= shrink;
          }
          row[en] = -r / pivot;
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
function generalInput(a: Matrix): { n: number; h: Float64Array[]; scale: number; balancing: Balancing } {
  const n = assertSquare(a, 'a');
  const { work: h, scale } = scaledCopy(a, n);
  const balancing = balance(h, n);

  return { n, h, scale, balancing };
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
  const { n, h, scale, balancing } = generalInput(a);
  const v = squareRows(n);
  hessenberg(h, n, v);
  const d = new Float64Array(n);
  const e = new Float64Array(n);
  francisQr(h, n, d, e, v);
  unbalance(v, n, balancing);
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

// ---------------------------------------------------------------------------
// QR, Cholesky, singular values and least squares

/** Options for `qrDecompose`. */
export type QrOptions = ToleranceOptions & {
  /**
   * Column pivoting (default `true`): each step takes the remaining column of
   * largest norm, so `|r_kk|` falls along the diagonal and `rank` is reliable.
   * `false` gives plain Householder QR of `A` itself (`permutation` is then the
   * identity).
   */
  pivoting?: boolean;
};

/** `A·P = Q·R`, from `qrDecompose`; `k = min(m, n)` for an `m×n` matrix `A`. */
export type QrDecomposition = {
  /** `Q`, `m×k` with orthonormal columns. */
  orthogonal: number[][];
  /** `R`, `k×n` upper triangular (trapezoidal when `n > m`), with a non-negative diagonal. */
  upper: number[][];
  /** Column `j` of `A·P` is column `permutation[j]` of `A`. */
  permutation: number[];
  /** The number of diagonal entries of `R` above the tolerance: the numerical rank, with pivoting. */
  rank: number;
};

/** `A = L·Lᵀ`, from `choleskyDecompose`. */
export type CholeskyDecomposition = {
  /** Lower-triangular `L` with a positive diagonal. */
  lower: number[][];
};

/** `A = Σₖ values[k] · left[k] · right[k]ᵀ`, from `singularValueDecompose`. */
export type SingularValueDecomposition = {
  /** The `min(m, n)` singular values, descending, all `≥ 0`. */
  values: number[];
  /** `left[k]` is the unit left singular vector (length `m`) for `values[k]`; together they are orthonormal. */
  left: number[][];
  /** `right[k]` is the unit right singular vector (length `n`) for `values[k]`; together they are orthonormal. */
  right: number[][];
};

/**
 * A validated `m×n` matrix as `Float64Array` views on one buffer, by columns
 * (`n` arrays of length `m`) or by rows, multiplied by the power of two that
 * brings its largest magnitude near 1 (exact; see `scaledCopy`).
 */
function scaledVectors(a: Matrix, m: number, n: number, byColumns: boolean): { work: Float64Array[]; scale: number } {
  const work = byColumns ? bufferRows(n, m) : bufferRows(m, n);
  let largest = 0;
  for (let i = 0; i < m; i++) {
    const source = a[i]!;
    for (let j = 0; j < n; j++) {
      const x = source[j]!;
      if (byColumns) work[j]![i] = x;
      else work[i]![j] = x;
      const magnitude = Math.abs(x);
      if (magnitude > largest) largest = magnitude;
    }
  }
  const scale = powerOfTwoScale(largest);
  if (scale !== 1) for (const vector of work) for (let i = 0; i < vector.length; i++) vector[i]! *= scale;
  return { work, scale };
}

/** Validates a vector or matrix right-hand side with `m` rows; returns its columns. */
function rightHandSides(b: Vector | Matrix, m: number): { columns: Float64Array[]; vector: boolean } {
  if (!isMatrixShape(b)) {
    assertSameLength(m, assertVector(b, 'b'));
    return { columns: [Float64Array.from(b)], vector: true };
  }
  const [rows, count] = assertMatrix(b, 'b');
  assertSameLength(m, rows);
  const columns = bufferRows(count, m);
  for (let i = 0; i < m; i++) {
    const row = b[i]!;
    for (let j = 0; j < count; j++) columns[j]![i] = row[j]!;
  }
  return { columns, vector: false };
}

/** Solution columns (each of length `n`, scaled by `factor`) as a vector or an `n×count` matrix. */
function solutionOutput(
  columns: readonly Float64Array[],
  n: number,
  factor: number,
  vector: boolean,
): number[] | number[][] {
  if (!vector) return columnsToRows(columns, n, factor);
  const x = columns[0]!;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(finish(x[i]! * factor));
  return out;
}

/** Columns of length `n`, times `factor`, as an `n×count` matrix. */
function columnsToRows(columns: readonly Float64Array[], n: number, factor: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (const column of columns) row.push(finish(column[i]! * factor));
    out.push(row);
  }
  return out;
}

/**
 * `A·P = Q·R` for any `m×n` matrix, by Householder reflections (LAPACK
 * `dgeqp3`, or `dgeqrf` with `{ pivoting: false }`). `Q` is the thin `m×k`
 * factor with `k = min(m, n)`; `R` is `k×n`. Each diagonal entry of `R` is made
 * non-negative (flipping the matching column of `Q`), so without pivoting the
 * factorization of a full-rank `A` is unique. `rank` counts the `|r_kk|` above
 * `max(m, n) · Number.EPSILON · |r₀₀|`, or above `{ tolerance }` (absolute).
 * Backward stable: `‖A·P − Q·R‖ ≈ n · ε · ‖A‖`. Never throws for a
 * rank-deficient matrix.
 */
export function qrDecompose(a: Matrix, options?: QrOptions): QrDecomposition {
  const [m, n] = assertMatrix(a, 'a');
  const { work: columns, scale } = scaledVectors(a, m, n, true);
  const { tau, permutation } = householderQr(columns, m, options?.pivoting !== false);
  const k = Math.min(m, n);
  const tolerance =
    options?.tolerance === undefined
      ? Math.max(m, n) * EPS * Math.abs(columns[0]![0]!)
      : resolveTolerance(options, () => 0) * scale;
  // Q's columns, accumulated backwards from [I; 0] (LAPACK dorgqr): reflector
  // i leaves the columns before i untouched.
  const q = bufferRows(k, m);
  for (let j = 0; j < k; j++) q[j]![j] = 1;
  for (let i = k - 1; i >= 0; i--) {
    const t = tau[i]!;
    if (t === 0) continue;
    const v = columns[i]!;
    for (let j = i; j < k; j++) {
      const column = q[j]!;
      let s = column[i]!;
      for (let r = i + 1; r < m; r++) s += v[r]! * column[r]!;
      s *= t;
      column[i]! -= s;
      for (let r = i + 1; r < m; r++) column[r]! -= s * v[r]!;
    }
  }
  let r = 0;
  const signs: number[] = [];
  for (let j = 0; j < k; j++) {
    const diagonal = columns[j]![j]!;
    signs.push(diagonal < 0 ? -1 : 1);
    if (Math.abs(diagonal) > tolerance) r++;
  }
  const orthogonal: number[][] = [];
  for (let i = 0; i < m; i++) {
    const row: number[] = [];
    for (let j = 0; j < k; j++) row.push(finish(signs[j]! * q[j]![i]!));
    orthogonal.push(row);
  }
  const upper: number[][] = [];
  for (let i = 0; i < k; i++) {
    const row: number[] = [];
    const factor = signs[i]! / scale;
    for (let j = 0; j < n; j++) row.push(j < i ? 0 : finish(columns[j]![i]! * factor));
    upper.push(row);
  }
  return { orthogonal, upper, permutation, rank: r };
}

/**
 * Cholesky–Banachiewicz (LAPACK `dpotrf`'s arithmetic) on a fresh `number[][]`
 * copy of a square matrix (`n×n`, validated by the caller), row by row, so each inner product walks
 * two rows; the copy becomes `L`. Unscaled: every product is bounded by a
 * diagonal entry of `A`, so nothing overflows, and an integer matrix with an
 * integer factor gets it exactly.
 *
 * Symmetry is checked as each lower entry `a[i][j]` is reached (the upper
 * triangle still holds the input), against `n · ε · ‖A‖∞` or `symmetry`
 * (absolute), and the factorization uses the mean of `a[i][j]` and `a[j][i]`.
 * A non-symmetric matrix always throws `InvalidArgumentError`, even when a
 * pivot fails first. Stops at the first diagonal pivot `d` (the value whose
 * square root becomes `l_ii`) that is not above `floor`: returns that `d` and
 * its index. On success every entry is finite (an overflow would have made a
 * later pivot `−∞` or `NaN`) and the upper triangle is zero.
 */
function cholesky(
  a: Matrix,
  n: number,
  symmetry: number | undefined,
  floor: (norm: number) => number,
): { lower: number[][]; norm: number; failed?: { index: number; pivot: number; threshold: number } } {
  const w: number[][] = [];
  let norm = 0;
  for (const source of a) {
    let sum = 0;
    for (const x of source) sum += Math.abs(x);
    if (sum > norm) norm = sum;
    // eslint-disable-next-line unicorn/prefer-spread -- slice keeps JavaScriptCore's unboxed double storage; a spread copy boxes the entries and makes the factorization about 2.5× slower in Bun
    w.push(source.slice());
  }
  const tolerance = symmetry ?? n * EPS * norm;
  const threshold = floor(norm);
  const asymmetry = (i: number, j: number, lower: number, upper: number): InvalidArgumentError =>
    new InvalidArgumentError(
      `a is not symmetric: |a[${i}][${j}] − a[${j}][${i}]| = ${Math.abs(lower - upper)} exceeds the tolerance`,
    );
  for (let i = 0; i < n; i++) {
    const row = w[i]!;
    for (let j = 0; j < i; j++) {
      const other = w[j]!;
      const lower = row[j]!;
      const upper = other[i]!;
      if (Math.abs(lower - upper) > tolerance) throw asymmetry(i, j, lower, upper);
      other[i] = 0; // read for the last time: L is zero above the diagonal
      // Four running sums, so consecutive subtractions do not wait on each other
      // (the split BLAS kernels use; the error bound is unchanged).
      let s0 = (lower + upper) / 2;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;
      let k = 0;
      for (; k + 3 < j; k += 4) {
        s0 -= row[k]! * other[k]!;
        s1 -= row[k + 1]! * other[k + 1]!;
        s2 -= row[k + 2]! * other[k + 2]!;
        s3 -= row[k + 3]! * other[k + 3]!;
      }
      for (; k < j; k++) s0 -= row[k]! * other[k]!;
      const l = (s0 + s1 + (s2 + s3)) / other[j]!;
      row[j] = l === 0 ? 0 : l; // drops -0
    }
    let d = row[i]!;
    for (let k = 0; k < i; k++) d -= row[k]! * row[k]!;
    // `!(d > threshold)` also stops at NaN (LAPACK checks it too).
    if (!(d > threshold)) {
      // The rows not reached yet still hold the input: finish the symmetry check there.
      for (let r = i + 1; r < n; r++) {
        for (let c = 0; c < r; c++) {
          const lower = w[r]![c]!;
          const upper = w[c]![r]!;
          if (Math.abs(lower - upper) > tolerance) throw asymmetry(r, c, lower, upper);
        }
      }
      return { lower: w, norm, failed: { index: i, pivot: d, threshold } };
    }
    row[i] = Math.sqrt(d);
  }
  return { lower: w, norm };
}

/**
 * `A = L·Lᵀ` for a symmetric positive definite matrix (LAPACK `dpotrf`): about
 * half the work of LU, and no pivoting is needed. Symmetry is checked like
 * `symmetricEigenvalues` (`InvalidArgumentError` beyond the tolerance; the
 * factorization uses `(A + Aᵀ) / 2`). Throws `NotPositiveDefiniteError` when a
 * diagonal pivot is `≤ 0`, the LAPACK rule, which makes this the standard
 * positive-definiteness test. A singular positive semidefinite matrix may pass
 * with a tiny diagonal entry or throw, depending on rounding.
 */
export function choleskyDecompose(a: Matrix, options?: SymmetryOptions): CholeskyDecomposition {
  const symmetry = options?.tolerance === undefined ? undefined : resolveTolerance(options, () => 0);
  const { lower, failed } = cholesky(a, assertSquare(a, 'a'), symmetry, () => 0);
  if (failed) {
    throw new NotPositiveDefiniteError(
      `matrix is not positive definite (pivot ${failed.index} is ${failed.pivot}, not > 0)`,
    );
  }
  return { lower };
}

/**
 * Solves `A·x = b` for a symmetric positive definite `A` by Cholesky: about
 * twice as fast as `solve`, and as accurate. `b` is a vector or a matrix of
 * right-hand-side columns, as for `solve`. Symmetry is checked with the
 * default tolerance (see `choleskyDecompose`). A pivot `d` with
 * `|d| ≤ n · Number.EPSILON · ‖A‖∞` (or `{ tolerance }`, absolute; the same
 * quantity `solve` tests, since for this matrix `d` equals LU's pivot) throws
 * `SingularMatrixError`; a pivot below `−tolerance` throws
 * `NotPositiveDefiniteError`.
 */
export function choleskySolve(a: Matrix, b: Vector, options?: ToleranceOptions): number[];
export function choleskySolve(a: Matrix, b: Matrix, options?: ToleranceOptions): number[][];
export function choleskySolve(a: Matrix, b: Vector | Matrix, options?: ToleranceOptions): number[] | number[][] {
  const explicit = options?.tolerance === undefined ? undefined : resolveTolerance(options, () => 0);
  const n = assertSquare(a, 'a');
  const { columns, vector } = rightHandSides(b, n);
  const { lower: w, failed } = cholesky(a, n, undefined, norm => explicit ?? n * EPS * norm);
  if (failed) {
    const { index, pivot, threshold } = failed;
    if (pivot < -threshold || Number.isNaN(pivot)) {
      throw new NotPositiveDefiniteError(`matrix is not positive definite (pivot ${index} is ${pivot})`);
    }
    throw new SingularMatrixError(`matrix is singular to working precision (pivot ${index} ≤ ${threshold})`);
  }
  for (const y of columns) {
    // L·z = b, then Lᵀ·x = z (by columns of Lᵀ, which are rows of L).
    for (let i = 0; i < n; i++) {
      const row = w[i]!;
      let s = y[i]!;
      for (let k = 0; k < i; k++) s -= row[k]! * y[k]!;
      y[i] = s / row[i]!;
    }
    for (let i = n - 1; i >= 0; i--) {
      const row = w[i]!;
      const x = y[i]! / row[i]!;
      y[i] = x;
      for (let k = 0; k < i; k++) y[k]! -= row[k]! * x;
    }
  }
  return solutionOutput(columns, n, 1, vector);
}

/** Largest number of QR sweeps spent on one singular value before `ConvergenceError`. */
const SVD_SWEEPS = 75;
const SVD_TINY = 2 ** -966;

/**
 * Golub–Kahan–Reinsch SVD of an `m×n` matrix with `m ≥ n`, held by columns in
 * `c` (destroyed): Householder bidiagonalization, then implicit-shift QR on
 * the bidiagonal with deflation and splitting (LINPACK `dsvdc`, as in JAMA).
 * Every loop walks one column, since `c`, `U` and `V` are all stored by
 * columns. Singular values come out descending; `u[k]` (length `m`) and `v[k]`
 * (length `n`) are the singular vectors when `vectors` is set.
 */
function golubKahan(
  c: Float64Array[],
  m: number,
  n: number,
  vectors: boolean,
): { s: Float64Array; u: Float64Array[]; v: Float64Array[] } {
  const s = new Float64Array(n);
  const e = new Float64Array(n);
  const work = new Float64Array(m);
  const u = vectors ? bufferRows(n, m) : [];
  const v = vectors ? bufferRows(n, n) : [];
  const nct = Math.min(m - 1, n);
  const nrt = Math.max(0, Math.min(n - 2, m));
  // Bidiagonalize: diagonal into s, superdiagonal into e.
  for (let k = 0; k < Math.max(nct, nrt); k++) {
    const ck = c[k]!;
    if (k < nct) {
      let sum = 0;
      for (let i = k; i < m; i++) sum += ck[i]! * ck[i]!;
      let norm = Math.sqrt(sum);
      if (norm !== 0) {
        if (ck[k]! < 0) norm = -norm;
        for (let i = k; i < m; i++) ck[i]! /= norm;
        ck[k]! += 1;
      }
      s[k] = -norm;
    }
    for (let j = k + 1; j < n; j++) {
      const cj = c[j]!;
      if (k < nct && s[k] !== 0) {
        let t = 0;
        for (let i = k; i < m; i++) t += ck[i]! * cj[i]!;
        t = -t / ck[k]!;
        for (let i = k; i < m; i++) cj[i]! += t * ck[i]!;
      }
      e[j] = cj[k]!;
    }
    if (vectors && k < nct) {
      const uk = u[k]!;
      for (let i = k; i < m; i++) uk[i] = ck[i]!;
    }
    if (k < nrt) {
      let sum = 0;
      for (let i = k + 1; i < n; i++) sum += e[i]! * e[i]!;
      let norm = Math.sqrt(sum);
      if (norm !== 0) {
        if (e[k + 1]! < 0) norm = -norm;
        for (let i = k + 1; i < n; i++) e[i]! /= norm;
        e[k + 1]! += 1;
      }
      e[k] = -norm;
      if (k + 1 < m && norm !== 0) {
        work.fill(0, k + 1);
        for (let j = k + 1; j < n; j++) {
          const ej = e[j]!;
          const cj = c[j]!;
          for (let i = k + 1; i < m; i++) work[i]! += ej * cj[i]!;
        }
        for (let j = k + 1; j < n; j++) {
          const t = -e[j]! / e[k + 1]!;
          const cj = c[j]!;
          for (let i = k + 1; i < m; i++) cj[i]! += t * work[i]!;
        }
      }
      if (vectors) {
        const vk = v[k]!;
        for (let i = k + 1; i < n; i++) vk[i] = e[i]!;
      }
    }
  }
  let p = n;
  if (nct < n) s[nct] = c[nct]![nct]!;
  if (nrt + 1 < p) e[nrt] = c[p - 1]![nrt]!;
  e[p - 1] = 0;
  if (vectors) {
    for (let j = nct; j < n; j++) u[j]![j] = 1;
    for (let k = nct - 1; k >= 0; k--) {
      const uk = u[k]!;
      if (s[k] === 0) {
        uk.fill(0);
        uk[k] = 1;
        continue;
      }
      for (let j = k + 1; j < n; j++) {
        const uj = u[j]!;
        let t = 0;
        for (let i = k; i < m; i++) t += uk[i]! * uj[i]!;
        t = -t / uk[k]!;
        for (let i = k; i < m; i++) uj[i]! += t * uk[i]!;
      }
      for (let i = k; i < m; i++) uk[i] = -uk[i]!;
      uk[k] = 1 + uk[k]!;
      uk.fill(0, 0, k);
    }
    for (let k = n - 1; k >= 0; k--) {
      const vk = v[k]!;
      if (k < nrt && e[k] !== 0) {
        for (let j = k + 1; j < n; j++) {
          const vj = v[j]!;
          let t = 0;
          for (let i = k + 1; i < n; i++) t += vk[i]! * vj[i]!;
          t = -t / vk[k + 1]!;
          for (let i = k + 1; i < n; i++) vj[i]! += t * vk[i]!;
        }
      }
      vk.fill(0);
      vk[k] = 1;
    }
  }
  const last = p - 1;
  let sweeps = 0;
  while (p > 0) {
    // Find the trailing unreduced block. kase 1: s[p-1] and e[k-1] negligible
    // (deflate); 2: s[k] negligible (split); 3: QR sweep on s[k..p-1]; 4: converged.
    let k: number;
    for (k = p - 2; k >= 0; k--) {
      if (Math.abs(e[k]!) <= SVD_TINY + EPS * (Math.abs(s[k]!) + Math.abs(s[k + 1]!))) {
        e[k] = 0;
        break;
      }
    }
    let kase: number;
    if (k === p - 2) {
      kase = 4;
    } else {
      let ks: number;
      for (ks = p - 1; ks > k; ks--) {
        const t = Math.abs(e[ks]!) + (ks === k + 1 ? 0 : Math.abs(e[ks - 1]!));
        if (Math.abs(s[ks]!) <= SVD_TINY + EPS * t) {
          s[ks] = 0;
          break;
        }
      }
      if (ks === k) {
        kase = 3;
      } else if (ks === p - 1) {
        kase = 1;
      } else {
        kase = 2;
        k = ks;
      }
    }
    k++;
    switch (kase) {
      case 1: {
        let f = e[p - 2]!;
        e[p - 2] = 0;
        for (let j = p - 2; j >= k; j--) {
          const t = hypot(s[j]!, f);
          const cs = s[j]! / t;
          const sn = f / t;
          s[j] = t;
          if (j !== k) {
            f = -sn * e[j - 1]!;
            e[j - 1] = cs * e[j - 1]!;
          }
          if (vectors) rotate(v[j]!, v[p - 1]!, cs, sn, n);
        }
        break;
      }
      case 2: {
        let f = e[k - 1]!;
        e[k - 1] = 0;
        for (let j = k; j < p; j++) {
          const t = hypot(s[j]!, f);
          const cs = s[j]! / t;
          const sn = f / t;
          s[j] = t;
          f = -sn * e[j]!;
          e[j] = cs * e[j]!;
          if (vectors) rotate(u[j]!, u[k - 1]!, cs, sn, m);
        }
        break;
      }
      case 3: {
        if (++sweeps > SVD_SWEEPS) {
          throw new ConvergenceError(`the SVD did not converge in ${SVD_SWEEPS} sweeps for one singular value`);
        }
        // The shift: the eigenvalue of the trailing 2×2 of BᵀB nearer its last entry.
        const scale = Math.max(
          Math.abs(s[p - 1]!),
          Math.abs(s[p - 2]!),
          Math.abs(e[p - 2]!),
          Math.abs(s[k]!),
          Math.abs(e[k]!),
        );
        const sp = s[p - 1]! / scale;
        const spm1 = s[p - 2]! / scale;
        const epm1 = e[p - 2]! / scale;
        const sk = s[k]! / scale;
        const ek = e[k]! / scale;
        const b = ((spm1 + sp) * (spm1 - sp) + epm1 * epm1) / 2;
        const cc = sp * epm1 * (sp * epm1);
        let shift = 0;
        if (b !== 0 || cc !== 0) {
          shift = Math.sqrt(b * b + cc);
          if (b < 0) shift = -shift;
          shift = cc / (b + shift);
        }
        let f = (sk + sp) * (sk - sp) + shift;
        let g = sk * ek;
        // Chase the bulge down the bidiagonal.
        for (let j = k; j < p - 1; j++) {
          let t = hypot(f, g);
          let cs = f / t;
          let sn = g / t;
          if (j !== k) e[j - 1] = t;
          f = cs * s[j]! + sn * e[j]!;
          e[j] = cs * e[j]! - sn * s[j]!;
          g = sn * s[j + 1]!;
          s[j + 1] = cs * s[j + 1]!;
          if (vectors) rotate(v[j]!, v[j + 1]!, cs, sn, n);
          t = hypot(f, g);
          cs = f / t;
          sn = g / t;
          s[j] = t;
          f = cs * e[j]! + sn * s[j + 1]!;
          s[j + 1] = -sn * e[j]! + cs * s[j + 1]!;
          g = sn * e[j + 1]!;
          e[j + 1] = cs * e[j + 1]!;
          if (vectors && j < m - 1) rotate(u[j]!, u[j + 1]!, cs, sn, m);
        }
        e[p - 2] = f;
        break;
      }
      default: {
        // Converged: make s[k] non-negative, then bubble it into descending order.
        if (s[k]! <= 0) {
          s[k] = s[k]! < 0 ? -s[k]! : 0;
          if (vectors) {
            const vk = v[k]!;
            for (let i = 0; i < n; i++) vk[i] = -vk[i]!;
          }
        }
        while (k < last && s[k]! < s[k + 1]!) {
          const t = s[k]!;
          s[k] = s[k + 1]!;
          s[k + 1] = t;
          if (vectors) {
            [v[k], v[k + 1]] = [v[k + 1]!, v[k]!];
            [u[k], u[k + 1]] = [u[k + 1]!, u[k]!];
          }
          k++;
        }
        sweeps = 0;
        p--;
      }
    }
  }
  return { s, u, v };
}

/** `(x, y) ← (cs·x + sn·y, cs·y − sn·x)` over the first `length` entries. */
function rotate(x: Float64Array, y: Float64Array, cs: number, sn: number, length: number): void {
  for (let i = 0; i < length; i++) {
    const a = x[i]!;
    const b = y[i]!;
    x[i] = cs * a + sn * b;
    y[i] = cs * b - sn * a;
  }
}

/**
 * The SVD of a validated `m×n` matrix, on a power-of-two scaled copy (values
 * are `scale` times the true ones). A wide matrix is factored as its
 * transpose, with the roles of the singular vectors swapped back.
 */
function svdOf(
  a: Matrix,
  m: number,
  n: number,
  vectors: boolean,
): { values: Float64Array; left: Float64Array[]; right: Float64Array[]; scale: number } {
  const tall = m >= n;
  // Tall: the columns of A. Wide: the rows of A, which are the columns of Aᵀ.
  const { work, scale } = scaledVectors(a, m, n, tall);
  const { s, u, v } = tall ? golubKahan(work, m, n, vectors) : golubKahan(work, n, m, vectors);
  return tall ? { values: s, left: u, right: v, scale } : { values: s, left: v, right: u, scale };
}

/**
 * The singular values of any `m×n` matrix: `min(m, n)` of them, descending,
 * all `≥ 0` (the square roots of the eigenvalues of `AᵀA`, computed without
 * forming it). Golub–Kahan–Reinsch: backward stable, so each value is within
 * about `max(m, n) · ε · σ₁` of the exact one. Throws `ConvergenceError` if
 * the QR iteration stalls (see the module docs). Faster than
 * `singularValueDecompose`: no singular vectors are accumulated.
 */
export function singularValues(a: Matrix): number[] {
  const [m, n] = assertMatrix(a, 'a');
  const { values, scale } = svdOf(a, m, n, false);
  const out: number[] = [];
  for (const value of values) out.push(finish(value / scale));
  return out;
}

/**
 * `A = U·Σ·Vᵀ` for any `m×n` matrix, in thin form: `values` holds the
 * `k = min(m, n)` singular values, descending; `left[k]` and `right[k]` are the
 * matching unit singular vectors, so `transpose(left)` is the `m×k` factor `U`
 * and `right` is `Vᵀ` (NumPy's `Vh`). Each pair's sign is fixed so that the
 * largest-magnitude entry of `left[k]` (the first, on a tie) is positive.
 * Throws like `singularValues`.
 */
export function singularValueDecompose(a: Matrix): SingularValueDecomposition {
  const [m, n] = assertMatrix(a, 'a');
  const { values, left, right, scale } = svdOf(a, m, n, true);
  const out: SingularValueDecomposition = { values: [], left: [], right: [] };
  for (const [k, value] of values.entries()) {
    const u = left[k]!;
    const v = right[k]!;
    let largest = 0;
    let sign = 1;
    for (let i = 0; i < m; i++) {
      const x = u[i]!;
      if (Math.abs(x) > largest) {
        largest = Math.abs(x);
        sign = x < 0 ? -1 : 1;
      }
    }
    out.values.push(finish(value / scale));
    const leftVector: number[] = [];
    for (let i = 0; i < m; i++) leftVector.push(finish(sign * u[i]!));
    const rightVector: number[] = [];
    for (let i = 0; i < n; i++) rightVector.push(finish(sign * v[i]!));
    out.left.push(leftVector);
    out.right.push(rightVector);
  }
  return out;
}

/**
 * The 2-norm condition number `σ₁ / σₖ` (largest over smallest singular
 * value) of any `m×n` matrix: about how many times a relative error in `A` or
 * `b` can be magnified in the solution of `A·x = b` or a least-squares fit.
 * `1` for an orthogonal matrix; `Infinity` (as NumPy's `cond` returns) when
 * the smallest singular value is exactly `0`, the one case in this module
 * that returns a non-finite number, since the condition number of a singular
 * matrix is infinite by definition.
 */
export function conditionNumber(a: Matrix): number {
  const [m, n] = assertMatrix(a, 'a');
  const { values } = svdOf(a, m, n, false);
  const smallest = values.at(-1)!;
  if (smallest === 0) return Infinity;
  return finish(values[0]! / smallest);
}

/**
 * The Moore–Penrose pseudo-inverse `A⁺` (`n×m` for an `m×n` matrix) from the
 * SVD: `V·Σ⁺·Uᵀ`, where `Σ⁺` inverts the singular values above
 * `max(m, n) · Number.EPSILON · σ₁` (NumPy's `pinv` default) and zeroes the
 * rest; `{ tolerance }` sets an absolute cut-off instead. `A⁺·b` is the
 * minimum-norm least-squares solution, but `leastSquares` computes that faster
 * and more accurately.
 */
export function pseudoInverse(a: Matrix, options?: ToleranceOptions): number[][] {
  const [m, n] = assertMatrix(a, 'a');
  const { values, left, right, scale } = svdOf(a, m, n, true);
  const tolerance =
    options?.tolerance === undefined ? Math.max(m, n) * EPS * values[0]! : resolveTolerance(options, () => 0) * scale;
  // Built by columns (one per row of A) so the inner loop is contiguous.
  const columns = bufferRows(m, n);
  for (const [k, value] of values.entries()) {
    if (!(value > tolerance)) break;
    const u = left[k]!;
    const v = right[k]!;
    // (s·A)⁺ = A⁺ / s, so A⁺ = s · (s·A)⁺.
    const factor = scale / value;
    for (let j = 0; j < m; j++) {
      const weight = u[j]! * factor;
      if (weight === 0) continue;
      const column = columns[j]!;
      for (let i = 0; i < n; i++) column[i]! += weight * v[i]!;
    }
  }
  return columnsToRows(columns, n, 1);
}

/**
 * The least-squares solution of `A·x ≈ b` for any `m×n` matrix: the `x` that
 * minimizes `‖A·x − b‖₂`. `b` is a vector (gives `x`, length `n`) or a matrix
 * of right-hand-side columns (gives an `n`-row matrix of solution columns).
 *
 * Solved by Householder QR with column pivoting, never the normal equations
 * `AᵀA·x = Aᵀb` (which square the condition number). When `R` shows `A` has
 * full column rank (every `|r_kk|` above `max(m, n) · Number.EPSILON · |r₀₀|`,
 * or above `{ tolerance }`, absolute), `x` is unique and comes from `R`. Otherwise
 * (rank-deficient, or fewer rows than columns) infinitely many `x` fit equally
 * well, and the one of smallest norm is returned, as NumPy's `lstsq` does: it
 * is computed from the SVD, dropping singular values at or below
 * `max(m, n) · Number.EPSILON · σ₁` (or `{ tolerance }`). Never throws for a
 * singular or rank-deficient `A`.
 */
export function leastSquares(a: Matrix, b: Vector, options?: ToleranceOptions): number[];
export function leastSquares(a: Matrix, b: Matrix, options?: ToleranceOptions): number[][];
export function leastSquares(a: Matrix, b: Vector | Matrix, options?: ToleranceOptions): number[] | number[][] {
  const [m, n] = assertMatrix(a, 'a');
  const { columns: rhs, vector } = rightHandSides(b, m);
  const explicit = options?.tolerance === undefined ? undefined : resolveTolerance(options, () => 0);
  if (m >= n) {
    const { work: columns, scale } = scaledVectors(a, m, n, true);
    const { tau, permutation } = householderQr(columns, m, true);
    const tolerance = explicit === undefined ? m * EPS * Math.abs(columns[0]![0]!) : explicit * scale;
    let fullRank = true;
    for (let k = 0; k < n; k++) if (!(Math.abs(columns[k]![k]!) > tolerance)) fullRank = false;
    if (fullRank) {
      const solutions = bufferRows(rhs.length, n);
      for (const [c, y] of rhs.entries()) {
        applyQTranspose(columns, tau, m, y);
        backSubstitute(columns, n, y);
        const x = solutions[c]!;
        for (let k = 0; k < n; k++) x[permutation[k]!] = y[k]!;
      }
      // (s·A)·x_s = b, so x = s·x_s.
      return solutionOutput(solutions, n, scale, vector);
    }
  }
  const { values, left, right, scale } = svdOf(a, m, n, true);
  const tolerance = explicit === undefined ? Math.max(m, n) * EPS * values[0]! : explicit * scale;
  const solutions = bufferRows(rhs.length, n);
  for (const [c, y] of rhs.entries()) {
    const x = solutions[c]!;
    for (const [k, value] of values.entries()) {
      if (!(value > tolerance)) break;
      const u = left[k]!;
      const v = right[k]!;
      let projection = 0;
      for (let i = 0; i < m; i++) projection += u[i]! * y[i]!;
      const weight = projection / value;
      for (let i = 0; i < n; i++) x[i]! += weight * v[i]!;
    }
  }
  return solutionOutput(solutions, n, scale, vector);
}
