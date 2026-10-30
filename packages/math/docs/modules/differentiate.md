Back to the [README](../../README.md#documentation).

# @arki/math/differentiate

`derivative` (Ridders) and `limit` (Richardson) are numerical estimates with an error estimate, not proofs. A method that misses its tolerance returns `NotConverged` (`math.not_converged`), whose `cause` is an `ExtrapolationConvergenceError` holding its best estimate (`.best`).

```ts
import { derivative, limit } from '@arki/math/differentiate';

derivative(Math.sin, 0).value; // 1
limit(x => Math.sin(x) / x, 0).value; // 1
```
