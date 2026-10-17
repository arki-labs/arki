Back to the [README](../../README.md#documentation).

# @arki/math/fluent

`num()` is the float-side counterpart of `str()` from `@arki/string`:
immutable, every call returns a new wrapper, extract with `.value()`.

```ts
import { num } from '@arki/math/fluent';

num(127.3).clamp(0, 100).roundTo(5).value(); // 100
num(1234.5678).round(2).formatCurrency('EUR'); // '€1,234.57'
num(0.1).toDecimal().plus('0.2').toString(); // '0.3'
```
