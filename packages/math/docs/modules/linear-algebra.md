Back to the [README](../../README.md#documentation).

# @arki/math/linear-algebra

Dense float64 on plain arrays (`number[]`, `number[][]`): no wrapper class, so
values go to JSON and other libraries as they are, and results never share
memory with inputs. `solve`, `inverse` and `determinant` use LU with partial
pivoting. A matrix singular to working precision throws `SingularMatrixError`
(pivot at or below `n·ε·‖A‖∞`; `{ tolerance }` overrides). Import it from its
subpath; the root does not re-export it.

```ts
import { determinant, inverse, solve } from '@arki/math/linear-algebra';

solve(
  [
    [2, 1, 1],
    [4, -6, 0],
    [-2, 7, 2],
  ],
  [5, -2, 9],
); // [1, 1, 2]
determinant([
  [2, 1, 1],
  [4, -6, 0],
  [-2, 7, 2],
]); // -16
inverse([
  [1, 2],
  [3, 4],
]); // [[-2, 1], [1.5, -0.5]]
```

Vectors and matrices: `transpose`, `trace` (sum of the diagonal) and
`multiply`, which takes a matrix (`A·B`) or a vector (`A·v`) as its second
argument. `normalize` returns the unit vector and `projection(v, onto)` the
part of `v` along `onto`; both throw `DivisionByZeroError` for a zero vector.

```ts
import { multiply, normalize, projection, trace, transpose } from '@arki/math/linear-algebra';

transpose([
  [1, 2, 3],
  [4, 5, 6],
]); // [[1, 4], [2, 5], [3, 6]]
trace([
  [1, 2],
  [3, 4],
]); // 5
multiply(
  [
    [1, 2],
    [3, 4],
  ],
  [1, 1],
); // [3, 7]
normalize([3, 4]); // [0.6, 0.8]
projection([2, 3], [1, 1]); // [2.5, 2.5]
```

Decompositions follow LAPACK's algorithms: pivoted Householder QR, Cholesky
(`NotPositiveDefiniteError` when it fails), SVD (Golub–Kahan–Reinsch), and
eigenvalues — symmetric by Householder tridiagonalization and implicit QL,
general by balancing, Hessenberg reduction and Francis double-shift QR.
`leastSquares` uses pivoted QR and returns the minimum-norm solution when `A`
is rank-deficient. `rank` counts singular values above `max(m, n)·ε·σ₁` (NumPy's
rule); `{ method: 'elimination' }` uses LU instead. `conditionNumber` is
`Infinity` for an exactly singular matrix, like NumPy's `cond`. General
eigenvalues come back as `Complex`, sorted like `polynomialRoots`.

```ts
import { eigenvalues, leastSquares, singularValues, symmetricEigenvalues } from '@arki/math/linear-algebra';
import { orThrow } from '@arki/failure';

symmetricEigenvalues([
  [2, 1],
  [1, 2],
]); // [1.0000000000000002, 3]   ascending
orThrow(
  eigenvalues([
    [0, -1],
    [1, 0],
  ]),
).map(String); // ['-i', 'i']   a rotation
singularValues([
  [3, 0],
  [4, 5],
]); // [6.708203932499369, 2.23606797749979]
leastSquares(
  [
    [1, 1],
    [1, 2],
    [1, 3],
  ],
  [1, 2, 2],
); // [0.666…, 0.5]   intercept, slope
```

The factors themselves come from the `…Decompose` functions. `luDecompose`
gives `P·A = L·U` (`permutation` and its `sign`) and never throws for a
singular matrix: `upper` then has a zero or tiny diagonal entry.
`qrDecompose` gives the thin `A·P = Q·R` with a non-negative diagonal in `R`
and the numerical `rank`; `{ pivoting: false }` factors `A` itself.
`symmetricEigenDecompose` gives ascending `values` with orthonormal `vectors`
(`A = V·Λ·Vᵀ`, `V = transpose(vectors)`). `singularValueDecompose` gives the
thin `A = U·Σ·Vᵀ`: `transpose(left)` is `U` and `right` is `Vᵀ` (NumPy's `Vh`).
Each vector's sign is fixed so its largest-magnitude entry is positive, so
results are reproducible.

```ts
import { luDecompose, qrDecompose, singularValueDecompose, symmetricEigenDecompose } from '@arki/math/linear-algebra';
import { orThrow } from '@arki/failure';

luDecompose([
  [1, 2],
  [3, 4],
]); // { lower: [[1, 0], [0.333…, 1]], upper: [[3, 4], [0, 0.666…]], permutation: [1, 0], sign: -1 }
qrDecompose([
  [1, 2],
  [2, 4],
  [3, 6],
]).rank; // 1   the columns are parallel
symmetricEigenDecompose([
  [2, 1],
  [1, 2],
]); // { values: [1.0000000000000002, 3], vectors: [[0.707…, -0.707…], [0.707…, 0.707…]] }
orThrow(
  singularValueDecompose([
    [3, 0],
    [4, 5],
  ]),
).values; // [6.708203932499369, 2.2360679774997894]
```
