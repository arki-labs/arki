Back to the [README](../../README.md#documentation).

# @arki/math/decimal-math

Transcendental results are never exact, so these take an explicit `scale`
(the same `ScaleOptions` as `Decimal#dividedBy`: **fraction digits**, not significant digits) and
round **correctly** — the result is the true value rounded once at that
scale, computed with guard digits and bigint arithmetic. Default rounding
here is `halfEven`. `sqrt`, `cbrt` and `nthRoot` without options stay
exact-or-throw like the rest of `Decimal`.

```ts
import { exp, ln, log10, PI, pow, sqrt } from '@arki/math/decimal-math';

sqrt('2.25').toString(); // '1.5'        exact
sqrt(2); // throws RoundingNecessaryError
sqrt(2, { scale: 30 }).toString(); // '1.414213562373095048801688724210'
exp(1, { scale: 20 }).toString(); // '2.71828182845904523536'
ln(10, { scale: 15 }).toString(); // '2.302585092994046'
pow(2, '0.5', { scale: 10 }).toString(); // '1.4142135624'
pow('1.5', 2).toString(); // '2.25'      integer exponents stay exact
PI(50).toString(); // '3.14159265358979323846264338327950288419716939937511'
```
