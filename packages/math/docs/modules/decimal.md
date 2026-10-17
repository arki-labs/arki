Back to the [README](../../README.md#documentation).

# @arki/math/decimal

`coefficient × 10^-scale`, immutable: methods never modify their operands and
fields are `readonly`. Instances are not frozen (freezing every result costs 5–7×
in hot loops, and no peer library does it); the shared constants are. Inputs: `string` (strict ASCII
decimal syntax, exponent allowed), `number` (read through its shortest
decimal spelling, so `decimal(0.1)` is exactly `1/10`; non-finite and
unsafe integers throw), `bigint`, or another `Decimal`.

```ts
import { Decimal, decimal } from '@arki/math/decimal';
import { formatNumber } from '@arki/math/format';

const prices = [decimal('2.50'), decimal('1.10')];
const d = decimal('1.10');
d.scale; // 2
d.plus('0.005').toString(); // '1.105'
d.minus(1).toString(); // '0.10'
d.times('3').toString(); // '3.30'
d.mod(0.25).toString(); // '0.10'
d.pow(2).toString(); // '1.2100'
d.pow(-1); // throws RoundingNecessaryError (1 / 1.1 does not terminate)

d.toScale(3).toString(); // '1.100'   adding digits is always allowed
decimal('1.15').toScale(1); // throws — would drop a non-zero digit
d.toScale(1, 'halfUp').toString(); // '1.1'
d.round(1).toString(); // '1.1'      round() = toScale() with halfUp default
d.toFixed(0); // '1'
d.trim().toString(); // '1.1'
d.roundTo('0.25').toString(); // '1.00'   nearest multiple of a step
formatNumber(d, { locale: 'de-DE' }); // '1,1'   display goes through @arki/math/format

d.eq('1.1'); // true — equality is numeric, scale does not matter
d.compareTo(2); // -1
d.lt(2) && d.gte(1); // true
d.isInteger(); // false
d.sign(); // 1

d.toNumber(); // 1.1
d.toBigInt(); // throws — not integral; round first
d.toRational().toString(); // '11/10'
JSON.stringify({ d }); // '{"d":"1.10"}'
`${d}`; // '1.10'
// d + 1 throws TypeError: a Decimal never silently becomes a float
// +d throws, and so does '' + d; only `${d}` and String(d) work

Decimal.sum(['0.1', '0.2', '0.3']).toString(); // '0.6'
Decimal.max('1.5', 2, '0.7').toString(); // '2'
prices.sort(Decimal.compare); // comparator for sorting
```

Scale is **retained** through `plus`/`minus` (larger of the two) and `times`
(sum of both). `dividedBy` without a scale returns the shortest exact
decimal; `'10.00' ÷ 4` is `'2.5'`. When a division does not terminate you
have two honest options: round it (`dividedBy(3, { scale, rounding })`) or
keep it exact as a fraction (`d.toRational().dividedBy(3)`).

Note that `Decimal#round(places)` takes `places ≥ 0` (it sets the scale),
while the float helper `round(x, -2)` rounds to hundreds.
