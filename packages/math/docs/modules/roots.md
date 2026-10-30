Back to the [README](../../README.md#documentation).

# @arki/math/roots

Every result carries an error estimate, and a method that misses its tolerance
returns `NotConverged` (`math.not_converged`) instead of a wrong number; its
`cause` is a `ConvergenceError` subclass holding the best estimate (`.best`). A function that returns `NaN` or `Infinity` throws
`NumericRangeError` naming the point. `derivative` and `limit` are numerical
estimates, not proofs.

The same page covers `@arki/math/roots`. For `integrate` see [integrate](integrate.md); for `derivative` and `limit` see [differentiate](differentiate.md).

```ts
import { findRoot } from '@arki/math/roots';

findRoot(x => x ** 3 - 2 * x - 5, [2, 3]).root; // 2.094551481542327   Brent, bracket must change sign
```
