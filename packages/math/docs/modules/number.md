Back to the [README](../../README.md#documentation).

# @arki/math/number

Plain-number helpers for UI, geometry and charts: fast float math with the sharp edges filed off.

```ts
import { clamp, inRange, lerp, round, roundTo } from '@arki/math/number';

round(1.005, 2); // 1.01  — rounds the number you typed, not its binary approximation
round(2.5, 0, 'halfEven'); // 2
roundTo(127.3, 5); // 125
clamp(105, 0, 100); // 100
lerp(0, 10, 0.5); // 5
inRange(5, 0, 5); // false — default bounds are [min, max)
```
