Back to the [README](../../README.md#documentation).

# @arki/math/polynomial

Coefficient arrays, highest degree first (like NumPy's `polyval` and `roots`):
`[1, -6, 11, -6]` is x³ − 6x² + 11x − 6. Roots come back tagged, so you know
whether you got real numbers or `Complex` values. `quadraticRoots` avoids
cancellation; `polynomialRoots` handles any degree.

```ts
import { cubicRoots, evaluatePolynomial, polynomialRoots, quadraticRoots } from '@arki/math/polynomial';

evaluatePolynomial([1, -6, 11, -6], 4); // 6
quadraticRoots(1, -3, 2); // { kind: 'real', roots: [1, 2], discriminant: 1 }   b² − 4ac, error-compensated
quadraticRoots(1, 0, 1).kind; // 'complex'
cubicRoots(1, -6, 11, -6); // { kind: 'real', roots: [1, 2, 3] }; one real root gives { kind: 'mixed', real, complex }
polynomialRoots([1, 0, 0, 0, -1]).length; // 4
```
