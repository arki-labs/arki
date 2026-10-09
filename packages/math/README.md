# @arki/math

Zero-dependency math toolkit for TypeScript. Exact where it must be, fast
where it can be, and honest about which is which. Runs unchanged in Node 22+,
Bun, Deno, browsers, and React Native (Hermes).

## Installation

```sh
npm install @arki/math
# or
bun add @arki/math
# or
deno add npm:@arki/math
```

## Two layers, by design

**Exact types** for money, measurements, calculators — anything where
`0.1 + 0.2 !== 0.3` is a bug:

```ts
import { decimal } from '@arki/math/decimal';
import { ratio } from '@arki/math/rational';

decimal('0.1').plus('0.2').toString(); // '0.3'
decimal('19.99').times(3).toString(); // '59.97'  (scale is kept: 1.10 × 3 = 3.30)
decimal(1).dividedBy(8).toString(); // '0.125'  (exact, so no rounding needed)
decimal(1).dividedBy(3); // throws RoundingNecessaryError — say how to round:
decimal(1).dividedBy(3, { scale: 4, rounding: 'halfEven' }).toString(); // '0.3333'

ratio(1, 3).plus(ratio(1, 6)).toString(); // '1/2'
ratio('0.(3)').eq(ratio(1, 3)); // true  — repeating decimals parse
ratio('3.14159265').approximate(1000).toString(); // '355/113'
```

**Plain-number helpers** for UI, geometry, charts — fast float math with
the sharp edges filed off:

```ts
import { clamp, inRange, lerp, round, roundTo } from '@arki/math/number';

round(1.005, 2); // 1.01  — rounds the number you typed, not its binary approximation
round(2.5, 0, 'halfEven'); // 2
roundTo(127.3, 5); // 125
clamp(105, 0, 100); // 100
lerp(0, 10, 0.5); // 5
inRange(5, 0, 5); // false — default bounds are [min, max)
```

Nothing in this package returns `NaN` or `null` to signal failure. Every
deliberate failure is a typed error under `MathError`; wrong runtime types
throw `TypeError`.

## Modules

Everything is a subpath import, tree-shakeable by concern. The root
`@arki/math` re-exports it all.

| Import                     | What it gives you                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `@arki/math/decimal`       | `decimal()`, `Decimal` — exact decimals with retained scale                                                                                 |
| `@arki/math/rational`      | `ratio()`, `Rational` — exact fractions on `bigint`                                                                                         |
| `@arki/math/number`        | `clamp`, `lerp`, `inverseLerp`, `remap`, `inRange`, `round`, `roundTo`, `approxEqual`                                                       |
| `@arki/math/integer`       | `gcd`, `lcm`, `divmod` — `number` and `bigint` overloads                                                                                    |
| `@arki/math/stats`         | `sum`, `mean`, `median`, `mode`, `percentile`, `variance`, `stddev`, `minMax`, `correlation`, `linearRegression`                            |
| `@arki/math/distributions` | `normal`, `studentT`, `noncentralT`, `chiSquare`, `fisherF`, `exponential`, `uniform`, `binomial`, `poisson`, `erf`, `erfInv`, `gammaLn`, … |
| `@arki/math/decimal-math`  | `sqrt`, `cbrt`, `nthRoot`, `exp`, `ln`, `log10`, `log2`, `log`, `pow`, `PI`, `E` — correctly rounded, on `Decimal`                          |
| `@arki/math/words`         | `spellNumber`, `spellOrdinal`, `formatOrdinal`; locales `en`, `enGB` built in, `words/ro`, `/de`, `/fr`, `/es`, `/it` opt-in                |
| `@arki/math/format`        | `formatNumber`, `formatCurrency`, `formatPercent`, `formatCompact`, `formatFileSize`, `createFormatter`                                     |
| `@arki/math/parse`         | `parseNumber`, `parseDecimal` — locale-aware, the parser `Intl` never shipped                                                               |
| `@arki/math/random`        | `createRandom(seed)`, `randomInt`, `shuffle`, `sample`, `pick`, …                                                                           |
| `@arki/math/fluent`        | `num()` — immutable fluent wrapper for plain numbers                                                                                        |
| `@arki/math/rounding`      | `RoundingMode`, `ROUNDING_MODES`, `isRoundingMode`                                                                                          |
| `@arki/math/errors`        | `MathError` and its subclasses                                                                                                              |

Deliberately **not** here: expression parsing, symbolic algebra, matrices,
complex numbers, units, and arbitrary-precision trigonometry. Those need
their own engines; reach for mathjs or a numerics library.

## Rounding

One vocabulary everywhere — `Decimal`, `Rational`, the float helpers, and
formatting all take the same `RoundingMode`:

| Mode          | Meaning                                           | 2.5 → | −2.5 → |
| ------------- | ------------------------------------------------- | ----- | ------ |
| `up`          | away from zero                                    | 3     | −3     |
| `down`        | toward zero                                       | 2     | −2     |
| `ceiling`     | toward +∞                                         | 3     | −2     |
| `floor`       | toward −∞                                         | 2     | −3     |
| `halfUp`      | nearest, ties away from zero (school rounding)    | 3     | −3     |
| `halfDown`    | nearest, ties toward zero                         | 2     | −2     |
| `halfEven`    | nearest, ties to even (banker's rounding)         | 2     | −2     |
| `unnecessary` | throw `RoundingNecessaryError` if digits are lost | —     | —      |

Defaults follow intent: **display-shaped calls** (`round`, `roundTo`,
`Decimal.round`, `toFixed`, formatting) default to `halfUp`, which is what
people expect to see. **Precision-shaped calls** (`dividedBy`, `toScale`,
`toDecimal`) default to `unnecessary`, so precision is never lost without
you asking.

Note that JavaScript's own `Math.round(-2.5)` is `-2` (ties toward +∞) —
none of the modes above, and one of the reasons this package exists.

## Decimal

`coefficient × 10^-scale`, immutable, frozen. Inputs: `string` (strict ASCII
decimal syntax, exponent allowed), `number` (read through its shortest
decimal spelling, so `decimal(0.1)` is exactly `1/10`; non-finite and
unsafe integers throw), `bigint`, or another `Decimal`.

```ts
const d = decimal('1.10');
d.scale; // 2
d.plus('0.005').toString(); // '1.105'
d.minus(1).toString(); // '0.10'
d.times('3').toString(); // '3.30'
d.mod(0.25).toString(); // '0.10'
d.pow(2).toString(); // '1.2100'
d.pow(-1); // throws RoundingNecessaryError (1 / 1.1 does not terminate)

d.toScale(3).toString(); // '1.100'   adding digits is always allowed
d.toScale(1); // throws — would drop a non-zero digit
d.toScale(1, 'halfUp').toString(); // '1.1'
d.round(1).toString(); // '1.1'      round() = toScale() with halfUp default
d.toFixed(0); // '1'
d.trim().toString(); // '1.1'

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
d + 1; // throws TypeError — a Decimal never silently becomes a float

Decimal.sum(['0.1', '0.2', '0.3']).toString(); // '0.6'
Decimal.max('1.5', 2, '0.7').toString(); // '2'
```

Scale is **retained** through `plus`/`minus` (larger of the two) and `times`
(sum of both). `dividedBy` without a scale returns the shortest exact
decimal; `'10.00' ÷ 4` is `'2.5'`.

## Rational

A reduced fraction of two `bigint`s; the denominator is always positive and
zero is always `0/1`.

```ts
ratio(6, 4).toString(); // '3/2'
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

## Statistics

Over plain numbers; inputs may be any iterable and are never mutated.
`sum` uses compensated (Neumaier) summation, so `sum([0.1, 0.2, 0.3])` is
exactly `0.6`. `variance`/`stddev` default to the **sample** statistic
(`ddof: 1`, like Python and Excel's `STDEV`); pass `{ ddof: 0 }` for
population. `percentile(values, p)` takes `p` in `0–100` and uses R‑7 linear
interpolation (Excel `PERCENTILE.INC`, numpy's default). Empty input throws
`EmptyDataError`; a non-finite element throws `InvalidArgumentError`.

```ts
import { linearRegression, mean, median, percentile, stddev } from '@arki/math/stats';

mean([1, 2, 3, 4]); // 2.5
median([3, 1, 2]); // 2
percentile([1, 2, 3, 4], 25); // 1.75
stddev([2, 4, 4, 4, 5, 5, 7, 9], { ddof: 0 }); // 2
linearRegression([1, 2, 3], [2, 4, 6]); // { slope: 2, intercept: 0 }
```

## Formatting

Built on `Intl.NumberFormat`, so every locale the runtime knows is
supported with no tables shipped. `Decimal` values are passed to `Intl` as
exact strings (ES2023 "NumberFormat v3") — a 30‑digit amount formats with
all 30 digits. Formatter instances are cached, which is where the speed is.

```ts
import {
  createFormatter,
  formatCompact,
  formatCurrency,
  formatFileSize,
  formatNumber,
  formatPercent,
} from '@arki/math/format';

formatNumber(1234567.891); // '1,234,567.891'
formatNumber(2.5, { maximumFractionDigits: 0, rounding: 'halfEven' }); // '2'
formatCurrency(1234.5, 'EUR', { locale: 'de-DE' }); // '1.234,50 €'
formatCurrency(-5, 'USD', { accounting: true }); // '($5.00)'
formatCurrency(decimal('0.1').plus('0.2'), 'USD'); // '$0.30' — exact in, exact out
formatPercent(0.125); // '12.5%'  — input is a fraction, as in Intl
formatCompact(1230000); // '1.2M'
formatCompact(1230000, { display: 'long' }); // '1.2 million'
formatFileSize(1536); // '1.5 kB'
formatFileSize(1536, { system: 'iec' }); // '1.5 KiB'

const ro = createFormatter({ locale: 'ro-RO', currency: 'RON' });
ro.formatCurrency(25); // '25,00 RON'
ro.formatPercent(0.07); // '7 %'
```

There is no global "current locale": the default is `en-US`, every call
takes `{ locale }`, and `createFormatter` binds defaults for an app or a
request without mutating shared state. That keeps SSR, tests, and
concurrent requests honest.

Ordinals and number‑to‑words are not included — `Intl` has no style for
them, and English suffix tables would be wrong everywhere else.

## Parsing

`Intl` can format in any locale but cannot parse. `parseNumber` and
`parseDecimal` derive the locale's digits, group, decimal and minus symbols
from `Intl.NumberFormat.formatToParts` and read input the way that locale
writes it.

```ts
import { parseDecimal, parseNumber } from '@arki/math/parse';

parseNumber('1,234.56'); // 1234.56
parseNumber('1.234,56', { locale: 'de-DE' }); // 1234.56
parseNumber('1 234,56', { locale: 'fr-FR' }); // 1234.56
parseNumber('−5', { locale: 'sv-SE' }); // -5   (U+2212 minus)
parseDecimal('1,234.56').toString(); // '1234.56'
parseNumber('abc'); // throws NumberFormatError
```

The locale decides what a dot means: `'1.234'` is 1.234 in `en-US` and 1234
in `de-DE`.

## Random

```ts
import { createRandom, randomInt, sample, shuffle } from '@arki/math/random';

randomInt(1, 6); // 1–6, both ends included, unbiased
shuffle([1, 2, 3, 4]); // a new array; the input is untouched
sample(['a', 'b', 'c', 'd'], 2); // two distinct picks

const rng = createRandom('level-7'); // seeded: the same sequence every run
rng.int(1, 100);
rng.gaussian(0, 1);
rng.pick(['rock', 'paper', 'scissors']);
```

Unseeded generators draw from `crypto.getRandomValues` when the runtime has
it (Node 19+, Bun, Deno, browsers) and fall back to `Math.random`. Seeded
generators use xoshiro128\*\*, deterministic across runtimes.

## Fluent

`num()` is the float-side counterpart of `str()` from `@arki/string`:
immutable, every call returns a new wrapper, extract with `.value()`.

```ts
import { num } from '@arki/math/fluent';

num(127.3).clamp(0, 100).roundTo(5).value(); // 100
num(1234.5678).round(2).formatCurrency('EUR'); // '€1,234.57'
num(0.1).toDecimal().plus('0.2').toString(); // '0.3'
```

## Distributions

Each factory returns an immutable object with `cdf`, `inv` (the quantile)
and `pdf` or `pmf`, plus `mean` and `variance` (`undefined` where the moment
does not exist, `Infinity` where it diverges). Parameters are validated up
front; nothing returns `NaN`.

```ts
import { binomial, chiSquare, fisherF, noncentralT, normal, poisson, studentT } from '@arki/math/distributions';

normal().inv(0.975); // 1.959963984540054
normal(100, 15).cdf(130); // 0.9772498680518208
studentT(10).inv(0.975); // 2.2281388519862744
chiSquare(1).inv(0.95); // 3.841458820694124
fisherF(3, 10).cdf(3.708265); // ≈ 0.95
noncentralT(10, 1).cdf(2); // 0.8076115625 — power analysis without jstat
binomial(10, 0.5).pmf(5); // 0.24609375
poisson(3).cdf(2); // 0.42319008112684353
```

The special functions underneath — `erf`, `erfc`, `erfInv`, `gammaLn`,
`regularizedGammaP`, `regularizedBeta` — are exported too. Accuracy: `cdf`
≈ 1e-15 for the normal, ≤ 1e-9 round-trip for t/χ²/F quantiles, 5e-13 for
the non-central t (verified by numerical integration).

## Decimal math

Transcendental results are never exact, so these take an explicit `scale`
and round **correctly** — the result is the true value rounded once at that
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

## Words

Numbers as words and ordinals, with real grammar per language. English is
built in; other languages are separate subpaths so you bundle only what you
use. Pass the rule object — there is no global locale.

```ts
import { enGB, formatOrdinal, spellNumber, spellOrdinal } from '@arki/math/words';
import { es } from '@arki/math/words/es';
import { fr } from '@arki/math/words/fr';
import { ro } from '@arki/math/words/ro';

spellNumber(1234); // 'one thousand two hundred thirty-four'
spellNumber(102, { locale: enGB }); // 'one hundred and two'
spellNumber('3.14'); // 'three point one four'
spellNumber(11, { until: 10 }); // '11'   Laravel-style thresholds
spellOrdinal(21); // 'twenty-first'
formatOrdinal(1001); // '1,001st'

spellNumber(21000, { locale: ro }); // 'douăzeci și una de mii'
spellNumber(2, { locale: ro, gender: 'feminine' }); // 'două'
spellOrdinal(2, { locale: ro, gender: 'feminine' }); // 'a doua'
formatOrdinal(21, { locale: ro }); // 'al 21-lea'
spellNumber(81, { locale: fr }); // 'quatre-vingt-un'
spellNumber(21000, { locale: es }); // 'veintiún mil'
```

Available: `en` (American), `enGB` (British "and"), `ro`, `de`, `fr`, `es`,
`it`. Each locale object implements `NumberWordsLocale`; adding a language is
one file against that contract.

## Errors

```ts
import { MathError, RoundingNecessaryError } from '@arki/math/errors';

try {
  decimal(1).dividedBy(3);
} catch (error) {
  if (error instanceof RoundingNecessaryError) {
    /* ask for a scale */
  }
  if (error instanceof MathError) {
    /* any failure from this package */
  }
}
```

| Error                     | When                                                    |
| ------------------------- | ------------------------------------------------------- |
| `NumberFormatError`       | a string is not a number in the accepted syntax         |
| `InvalidArgumentError`    | reversed bounds, negative step, p out of range, …       |
| `DivisionByZeroError`     | division by zero, zero to a negative power              |
| `RoundingNecessaryError`  | an exact result needs rounding and no mode was given    |
| `NumericRangeError`       | non-finite, unsafe integer, overflow or underflow       |
| `EmptyDataError`          | a statistic of an empty (or too small) data set         |
| `ResourceLimitError`      | more than 10 000 digits, or an exponent beyond ±10 000  |
| `UnsupportedFeatureError` | the runtime's `Intl` lacks a feature the call relies on |

## Runtime support

- **Node 22+, Bun, Deno, browsers**: everything, verified by the test suite
  and a smoke run of the built package in each runtime (`bun run test:runtimes`).
- **React Native (Hermes)**: arithmetic, statistics, random and the float
  helpers need only `bigint`. Formatting and parsing depend on the host's
  `Intl` build; when a feature is missing (exact string formatting, a
  non-default `roundingMode`), the call throws `UnsupportedFeatureError`
  rather than silently degrading.
- Pure ESM, no runtime-specific globals; the lint config rejects any
  `node:*`/`bun:*` import or `process`/`Buffer` use in library code.

## Limits

Inputs and intermediate results are capped at 10 000 digits and an exponent
magnitude of 10 000 (`ResourceLimitError`). These are resource guards against
hostile input, not precision settings — well within them, arithmetic is exact.

## License

MIT
