/**
 * Householder QR kernels shared by `linear-algebra` (`qrDecompose`,
 * `leastSquares`) and `stats` (`polynomialRegression`).
 *
 * A matrix is held by columns: `columns[j]` is column `j` of an `m×n` matrix,
 * a `Float64Array` of length `m` (callers allocate them as views on one
 * buffer). Every hot loop then walks one contiguous column, and a column
 * swap is a swap of two references. Callers scale the input first (by a power
 * of two, or to unit column norms) so the plain sums of squares below cannot
 * overflow.
 *
 * After `householderQr`, the LAPACK `dgeqp3` layout holds: for `i ≤ j`,
 * `columns[j][i]` is `r_ij` of `R`; below the diagonal, `columns[j][j+1..]`
 * is the tail of the `j`-th Householder vector (its head is an implied 1).
 */

const SQRT_EPSILON = Math.sqrt(Number.EPSILON);

export type HouseholderQr = {
  /** `τ` of each reflector `H_k = I − τ_k·v_k·v_kᵀ`; `0` means `H_k = I`. */
  tau: Float64Array;
  /** `columns[j]` now holds original column `permutation[j]`. */
  permutation: number[];
};

function columnNorm(column: Float64Array, from: number, m: number): number {
  let sum = 0;
  for (let i = from; i < m; i++) sum += column[i]! * column[i]!;
  return Math.sqrt(sum);
}

/**
 * Factors `A·P = Q·R` in place, with Householder reflectors. With `pivoting`,
 * each step moves the remaining column of largest norm to the front (LAPACK
 * `dgeqp3`), so `|r_kk|` falls along the diagonal and reveals the numerical
 * rank; the partial column norms are downdated, and recomputed when the
 * downdate has cancelled too far (the `dlaqp2` safeguard).
 */
export function householderQr(columns: Float64Array[], m: number, pivoting: boolean): HouseholderQr {
  const n = columns.length;
  const steps = Math.min(m, n);
  const tau = new Float64Array(steps);
  const permutation = Array.from({ length: n }, (_, j) => j);
  // Partial norms of the trailing part of each column, and their values at the last recompute.
  const norms = new Float64Array(n);
  const reference = new Float64Array(n);
  if (pivoting) {
    for (let j = 0; j < n; j++) {
      norms[j] = columnNorm(columns[j]!, 0, m);
      reference[j] = norms[j]!;
    }
  }
  for (let k = 0; k < steps; k++) {
    if (pivoting) {
      let best = k;
      for (let j = k + 1; j < n; j++) if (norms[j]! > norms[best]!) best = j;
      if (best !== k) {
        [columns[k], columns[best]] = [columns[best]!, columns[k]!];
        [permutation[k], permutation[best]] = [permutation[best]!, permutation[k]!];
        norms[best] = norms[k]!;
        reference[best] = reference[k]!;
      }
    }
    const v = columns[k]!;
    const alpha = v[k]!;
    const tail = columnNorm(v, k + 1, m);
    if (tail !== 0) {
      // dlarfg: β = −sign(α)·‖x‖, so α − β never cancels.
      const length = Math.hypot(alpha, tail);
      const beta = alpha >= 0 ? -length : length;
      const t = (beta - alpha) / beta;
      tau[k] = t;
      const scale = 1 / (alpha - beta);
      for (let i = k + 1; i < m; i++) v[i]! *= scale;
      v[k] = beta;
      for (let j = k + 1; j < n; j++) {
        const column = columns[j]!;
        let s = column[k]!;
        for (let i = k + 1; i < m; i++) s += v[i]! * column[i]!;
        s *= t;
        column[k]! -= s;
        for (let i = k + 1; i < m; i++) column[i]! -= s * v[i]!;
      }
    }
    if (pivoting) {
      for (let j = k + 1; j < n; j++) {
        const norm = norms[j]!;
        if (norm === 0) continue;
        const ratio = Math.abs(columns[j]![k]!) / norm;
        const remaining = Math.max(0, (1 + ratio) * (1 - ratio));
        const drift = norm / reference[j]!;
        if (remaining * drift * drift <= SQRT_EPSILON) {
          norms[j] = columnNorm(columns[j]!, k + 1, m);
          reference[j] = norms[j]!;
        } else {
          norms[j] = norm * Math.sqrt(remaining);
        }
      }
    }
  }
  return { tau, permutation };
}

/** Overwrites `y` (length `m`) with `Qᵀ·y`, from the reflectors `householderQr` left in `columns`. */
export function applyQTranspose(columns: readonly Float64Array[], tau: Float64Array, m: number, y: Float64Array): void {
  for (const [k, t] of tau.entries()) {
    if (t === 0) continue;
    const v = columns[k]!;
    let s = y[k]!;
    for (let i = k + 1; i < m; i++) s += v[i]! * y[i]!;
    s *= t;
    y[k]! -= s;
    for (let i = k + 1; i < m; i++) y[i]! -= s * v[i]!;
  }
}

/**
 * Solves `R₁₁·z = c` for the leading `size×size` block of `R` in place
 * (`c` becomes `z`), column by column so each inner loop walks one column.
 */
export function backSubstitute(columns: readonly Float64Array[], size: number, c: Float64Array): void {
  for (let j = size - 1; j >= 0; j--) {
    const column = columns[j]!;
    const z = c[j]! / column[j]!;
    c[j] = z;
    for (let i = 0; i < j; i++) c[i]! -= z * column[i]!;
  }
}
