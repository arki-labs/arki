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

symmetricEigenvalues([
  [2, 1],
  [1, 2],
]); // [1.0000000000000002, 3]   ascending
eigenvalues([
  [0, -1],
  [1, 0],
]).map(String); // ['-i', 'i']   a rotation
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
