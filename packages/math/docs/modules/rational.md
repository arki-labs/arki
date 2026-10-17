Back to the [README](../../README.md#documentation).

# @arki/math/rational

A reduced fraction of two `bigint`s; the denominator is always positive and
zero is always `0/1`.

```ts
import { decimal } from '@arki/math/decimal';
import { ratio } from '@arki/math/rational';

ratio(6, 4).toString(); // '3/2'
ratio('4 1/2').toString(); // '9/2'   mixed numbers parse too
ratio('7/2').toMixed(); // { whole: 3n, fraction: 1/2 }
ratio('0.1(6)').toString(); // '1/6'
ratio(0.75).toString(); // '3/4'
ratio(decimal('0.5')); // 1/2

ratio(2, 3).times(ratio(3, 4)).toString(); // '1/2'
ratio(2, 3).dividedBy(2).toString(); // '1/3'
ratio(2, 3).inverse().toString(); // '3/2'
ratio(2, 3).pow(-2).toString(); // '9/4'

ratio(3, 8).toDecimal().toString(); // '0.375'
ratio(1, 3).toDecimal(); // throws RoundingNecessaryError
ratio(1, 3).toDecimal({ scale: 2, rounding: 'halfUp' }).toString(); // '0.33'
ratio(1, 3).toNumber(); // 0.3333333333333333
```

`approximate(maxDenominator)` finds the closest fraction with a bounded
denominator — the "0.333 → ⅓" step every calculator needs.
