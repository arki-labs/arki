Back to the [README](../../README.md#documentation).

# @arki/math/integrate

Adaptive Gauss-Kronrod and tanh-sinh integration, with infinite intervals. Every result carries an error estimate, and a method that misses its tolerance returns `NotConverged` (`math.not_converged`), whose `cause` is an `IntegrationConvergenceError` holding its best estimate (`.best`). A function that returns `NaN` or `Infinity` throws `NumericRangeError` naming the point.

```ts
import { integrate } from '@arki/math/integrate';
import { orThrow } from '@arki/failure';

orThrow(integrate(x => Math.exp(-x * x), [0, Infinity])).value; // 0.886226925452758   √π/2
orThrow(integrate(x => 1 / Math.sqrt(x), [0, 1], { method: 'tanhSinh' })).value; // 2   endpoint singularity
```
