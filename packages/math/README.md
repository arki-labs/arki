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
`@arki/math` re-exports it all except `linear-algebra`, whose short names
(`plus`, `times`, `norm`, `inverse`) would clash at the root.

| Import                      | What it gives you                                                                                                                                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@arki/math/decimal`        | `decimal()`, `Decimal` — exact decimals with retained scale                                                                                                                                                                                  |
| `@arki/math/rational`       | `ratio()`, `Rational` — exact fractions on `bigint`                                                                                                                                                                                          |
| `@arki/math/number`         | `clamp`, `lerp`, `inverseLerp`, `remap`, `inRange`, `round`, `roundTo`, `roundToSignificant`, `significantDigits`, `approxEqual`, `range`, `linspace`                                                                                        |
| `@arki/math/integer`        | `gcd`, `lcm`, `divmod`, `factorial`, `combinations`, `permutations`, `isPrime`, `primeFactors`, `divisors`, `modPow`, `modInverse`, `fibonacci`, `toBase`, `fromBase`                                                                        |
| `@arki/math/stats`          | `sum`, `mean`, `median`, `mode`, `percentile`, `variance`, `stddev`, `minMax`, `correlation`, `zScore`, `confidenceInterval`, `sampleSize`, linear/exponential/logarithmic/power/polynomial regression; `mean`…`stddev` exact on `Decimal[]` |
| `@arki/math/units`          | `convert`, `convertExact`, `formatUnit` — 22 categories, exact ratios                                                                                                                                                                        |
| `@arki/math/finance`        | `payment`, `amortizationSchedule`, `futureValue`, `netPresentValue`, `internalRateOfReturn`, … — on `Decimal`; `finance/float` has the same verbs on `number`                                                                                |
| `@arki/math/distributions`  | `normal`, `studentT`, `noncentralT`, `chiSquare`, `fisherF`, `exponential`, `uniform`, `binomial`, `poisson`, `erf`, `erfInv`, `gamma`, `gammaLn`, `beta`, …                                                                                 |
| `@arki/math/geometry`       | `solveTriangle(s)`, `circle`, `circleSector`, `ellipse`, `regularPolygon`, solids, `distance`, `polygonArea`, `pythagoreanTriples`                                                                                                           |
| `@arki/math/linear-algebra` | `solve`, `inverse`, `determinant`, LU, pivoted QR, Cholesky, SVD, `leastSquares`, `pseudoInverse`, `conditionNumber`, `rank`, eigenvalues and eigenvectors — on plain arrays (subpath only)                                                  |
| `@arki/math/complex`        | `complex()`, `Complex` — arithmetic, polar form, `exp`, `ln`, `sqrt`, `pow`, `nthRoots`, `sin`…`atanh`                                                                                                                                       |
| `@arki/math/polynomial`     | `evaluatePolynomial`, `polynomialDerivative`, `quadraticRoots`, `cubicRoots`, `polynomialRoots`                                                                                                                                              |
| `@arki/math/decimal-math`   | `sqrt`, `cbrt`, `nthRoot`, `exp`, `ln`, `log10`, `log2`, `log`, `pow`, `PI`, `E` — correctly rounded, on `Decimal`                                                                                                                           |
| `@arki/math/words`          | `spellNumber`, `spellOrdinal`, `formatOrdinal`; locales `en`, `enGB` built in, `words/ro`, `/de`, `/fr`, `/es`, `/it` opt-in                                                                                                                 |
| `@arki/math/format`         | `formatNumber`, `formatCurrency`, `formatPercent`, `formatCompact`, `formatFileSize`, `createFormatter`                                                                                                                                      |
| `@arki/math/parse`          | `parseNumber`, `parseDecimal` — locale-aware, the parser `Intl` never shipped                                                                                                                                                                |
| `@arki/math/random`         | `createRandom(seed)`, `randomInt`, `shuffle`, `sample`, `pick`, …                                                                                                                                                                            |
| `@arki/math/fluent`         | `num()` — immutable fluent wrapper for plain numbers                                                                                                                                                                                         |
| `@arki/math/rounding`       | `RoundingMode`, `ROUNDING_MODES`, `isRoundingMode`                                                                                                                                                                                           |
| `@arki/math/roots`          | `findRoot` (Brent), `bisect`, `newton`, `findRoots` — with an error estimate                                                                                                                                                                 |
| `@arki/math/integrate`      | `integrate` — adaptive Gauss–Kronrod and tanh-sinh, infinite intervals                                                                                                                                                                       |
| `@arki/math/differentiate`  | `derivative` (Ridders), `limit` (Richardson) — numerical estimates with an error estimate                                                                                                                                                    |
| `@arki/math/errors`         | `MathError` and its subclasses                                                                                                                                                                                                               |

Deliberately **not** here: expression parsing and symbolic algebra (they are
languages with their own security surface; they are planned as sibling packages
built on this one), sparse matrices, and arbitrary-precision trigonometry.
`geometry`, `linear-algebra`, `complex`, `polynomial`, `roots`, `integrate` and
`differentiate` work on plain `number` (float64), like the rest of the numeric
layer.

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

`coefficient × 10^-scale`, immutable: methods never modify their operands and
fields are `readonly`. Instances are not frozen (freezing every result costs 5–7×
in hot loops, and no peer library does it); the shared constants are. Inputs: `string` (strict ASCII
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
d + 1; // throws TypeError — a Decimal never silently becomes a float
+d; // throws, and so does '' + d; only `${d}` and String(d) work

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

## Rational

A reduced fraction of two `bigint`s; the denominator is always positive and
zero is always `0/1`.

```ts
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

## Statistics

Inputs may be any iterable and are never mutated. Over plain numbers,
`sum` uses compensated (Neumaier) summation, so `sum([0.1, 0.2, 0.3])` is
exactly `0.6`. Give `mean`, `median`, `minMax`, `variance` or `stddev` an
iterable of `Decimal` and you get an exact `Decimal` back
(`mean([decimal('0.1'), decimal('0.2')])` is `0.15`; a mean that does not
terminate needs `{ scale, rounding }`, like division; `stddev` is correctly
rounded at the scale you ask for). `sum` is number-only — `Decimal.sum` is
the exact sum, and an empty list has no way to say which kind it wanted. `variance`/`stddev` default to the **sample** statistic
(`ddof: 1`, like Python and Excel's `STDEV`); pass `{ ddof: 0 }` for
population. `percentile(values, p)` takes `p` in `0–100` and uses R‑7 linear
interpolation (Excel `PERCENTILE.INC`, numpy's default). Empty input throws
`EmptyDataError`; a non-finite element throws `InvalidArgumentError`.

```ts
import {
  linearRegression,
  mean,
  median,
  percentile,
  percentileRank,
  quantile,
  quartiles,
  stddev,
} from '@arki/math/stats';

mean([1, 2, 3, 4]); // 2.5
median([3, 1, 2]); // 2
percentile([1, 2, 3, 4], 25); // 1.75   p on 0–100
quantile([1, 2, 3, 4], 0.25); // 1.75   same thing, q on 0–1
quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.25, { method: 'weibull' }); // 2.75   Excel PERCENTILE.EXC
quartiles([1, 2, 3, 4, 5, 6, 7, 8], { method: 'tukey' }); // { q1: 2.5, q2: 4.5, q3: 6.5 }   box-plot hinges
percentileRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 7); // 65
stddev([2, 4, 4, 4, 5, 5, 7, 9], { ddof: 0 }); // 2
linearRegression([1, 2, 3], [2, 4, 6]).slope; // 2
```

`quantile` and `percentile` take `{ method }` for all nine Hyndman–Fan
definitions (R types 1–9, named as in NumPy: `'inverseCdf'` is nearest rank,
`'weibull'` is Excel `PERCENTILE.EXC`, `'linear'` the default). `quartiles`
adds two hinge rules for odd counts: `'tukey'` keeps the median in both
halves (R `fivenum`), `'medianExcluded'` leaves it out (TI-83, Moore & McCabe).
`pooledVariance`/`pooledStddev` combine groups, given as raw samples or as
`{ n, stddev }` / `{ n, variance }` summaries. `polynomialRegression` centers
x before solving, so year-scale x (2015…2024) fits; `predict` evaluates in the
centered basis, because the power-basis `coefficients` lose digits there. The linear fit also reports `adjustedR2`, `residualStandardError` and
the slope/intercept standard errors; these are `undefined` when no degrees of
freedom are left (a line through two points).

Inference uses exact critical values from `distributions` (Student t by
default, `method: 'z'` for the normal). `sampleSize` rounds up.

```ts
import { confidenceInterval, polynomialRegression, sampleSize, zScore } from '@arki/math/stats';

confidenceInterval([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); // { mean: 5.5, lower: 3.33…, upper: 7.67…, … }  R t.test
sampleSize({ marginOfError: 0.03 }); // 1068   a ±3% poll at 95%
zScore(130, 100, 15); // 2
polynomialRegression([0, 1, 2, 3], [1, 2, 5, 10], 2).coefficients; // [1, 0, 1]  lowest degree first
```

Every fit (`linearRegression`, `exponentialRegression`, `logarithmicRegression`,
`powerRegression`, `polynomialRegression`) returns its coefficients, `r2` and
`predict(x)`. `r2` is measured on the original y values, also for the fits that
are solved on `ln y`.

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
formatCompact(1_250_000, { currency: 'USD' }); // '$1.3M'
formatFileSize(1536); // '1.5 kB'
formatFileSize(1536, { system: 'iec' }); // '1.5 KiB'
formatFileSize(1536, { system: 'jedec' }); // '1.5 KB'  — powers of 1024, KB/MB/GB labels

const ro = createFormatter({ locale: 'ro-RO', currency: 'RON' });
ro.formatCurrency(25); // '25,00 RON'
ro.formatPercent(0.07); // '7 %'
```

There is no global "current locale": the default is `en-US`, every call
takes `{ locale }`, and `createFormatter` binds defaults for an app or a
request without mutating shared state. That keeps SSR, tests, and
concurrent requests honest. To format like `toLocaleString()` does, in the
runtime's own locale, ask for it by name: `{ locale: 'default' }` (exported as
`RUNTIME_LOCALE`). A missing locale never means the runtime's.

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
parseNumber('1.234,56', { symbols: { decimal: ',', group: '.' } }); // 1234.56, no Intl needed
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

Each factory returns an immutable object with `cdf`, `quantile`
and `pdf` or `pmf`, plus `mean` and `variance` (`undefined` where the moment
does not exist, `Infinity` where it diverges). Parameters are validated up
front; nothing returns `NaN`.

```ts
import { binomial, chiSquare, fisherF, noncentralT, normal, poisson, studentT } from '@arki/math/distributions';

normal().quantile(0.975); // 1.959963984540054
normal(100, 15).cdf(130); // 0.9772498680518208
studentT(10).quantile(0.975); // 2.2281388519862744
chiSquare(1).quantile(0.95); // 3.841458820694124
fisherF(3, 10).cdf(3.708265); // ≈ 0.95
noncentralT(10, 1).cdf(2); // 0.8076115625 — power analysis without jstat
binomial(10, 0.5).pmf(5); // 0.24609375
poisson(3).cdf(2); // 0.42319008112684353
```

For p-values, use the survival function instead of `1 - cdf(x)` — the
subtraction loses the tail: `1 - normal().cdf(9)` is `0`, while
`normal().sf(9)` is `1.13e-19`. Discrete `quantile(p)` is exactly "the
smallest `k` with `cdf(k) ≥ p`".

The special functions underneath — `erf`, `erfc`, `erfInv`, `gamma`, `gammaLn`, `beta`, `betaLn`,
`regularizedGammaP`, `regularizedBeta` — are exported too. Every one of them, and every
distribution method, is measured against mpmath far into the tails; the bounds are in
[Accuracy](#accuracy).

## Decimal math

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
one file against that contract. Locales are objects you import rather than
`Intl`-style strings so that a bundle only carries the languages it uses.

Thresholds: a number is spelled when `after < |value| ≤ until`; outside
that window it comes back as locale-formatted digits with its value intact
(`spellNumber('0.0001', { after: 1 })` → `'0.0001'`). Each locale has a
magnitude limit (`maxGroups`, in base-1000 groups) beyond which it throws
`NumericRangeError` before doing any work.

## Money

Money lives in its own package, [`@arki/money`](../money/README.md). It builds on
this one: same rounding modes, same error family, and it accepts `Decimal` and
`Rational` as amounts.

## Units

Twenty-two categories (length, mass, area, volume, temperature, time, speed,
data, energy, pressure, angle, power, frequency, force, torque, fuel economy,
data rate, electric current, illuminance, radioactivity, dynamic and kinematic
viscosity, solid angle) with every factor stored as an exact
rational, so `convert(1, 'in', 'cm')` is exactly `2.54` and
`convert(100, 'C', 'F')` is exactly `212`. `convertExact` returns the
`Rational`; only conversions through π (radians) refuse to be exact. Fuel
economy mixes distance-per-volume and volume-per-distance units:
`l/100km` is the reciprocal of `km/l`, so `convert(30, 'mpg', 'l/100km')` is
`7.84…`, and converting `0` to or from `l/100km` throws.

```ts
import { convert, convertExact, formatUnit, joinUnits, splitUnits, unitsOf } from '@arki/math/units';

convert(5, 'km', 'mi'); // 3.1068559611866697
convert(1, 'GiB', 'GB'); // 1.073741824
convertExact(1, 'mi', 'km').toString(); // '25146/15625'
convert(1, 'm', 'kg'); // throws InvalidArgumentError: length → mass
formatUnit(5, 'km', { display: 'long' }); // '5 kilometers'
unitsOf('pressure'); // ['Pa', 'kPa', 'MPa', 'bar', 'atm', 'psi', 'mmHg', 'Torr']
splitUnits(67, 'in', ['ft', 'in']); // [{ unit: 'ft', value: 5 }, { unit: 'in', value: 7 }]
splitUnits(71.99, 'in', ['ft', 'in'], { scale: 0 }); // 6 ft 0 in   rounds once, then carries
joinUnits(
  [
    { unit: 'ft', value: 5 },
    { unit: 'in', value: 7 },
  ],
  'in',
); // 67
```

## Finance

Spreadsheet-shaped (Excel `PMT`, `NPV`, `IRR`, `FV`, `PV`, `EFFECT`,
`NOMINAL`) but exact on `Decimal`: rates are per-period fractions, every
intermediate stays exact and the result is rounded once at the scale you
ask for. `payment` returns a positive number for a positive loan.

```ts
import { amortizationSchedule, futureValue, netPresentValue, payment } from '@arki/math/finance';

payment(200_000, 0.005, 360, { scale: 2, rounding: 'halfEven' }).toString(); // '1199.10'
futureValue(1000, 0.05, 10).toString(); // exact: '1628.89462677744140625000'
netPresentValue(0.1, [100, 100, 100], { scale: 2 }).toString(); // '248.69'
amortizationSchedule(1000, 0.01, 12, { scale: 2 }).at(-1)?.balance.toString(); // '0.00'
```

`futureValue` and `presentValue` take `{ payment, timing }` for annuities
(Excel `FV`/`PV` with a payment, `timing: 'begin'` for type 1). Results are
balances, so `futureValue(pv, r, n, { payment })` is `-FV(r, n, payment, pv)`.

`@arki/math/finance/float` has the same functions, names and sign rules on
`number`, for what the exact layer cannot do: fractional or negative periods,
horizons whose exact powers pass the digit limit, and tight loops. `(1+r)^n`
goes through `log1p`/`expm1`, so tiny rates stay accurate and rate `0` is
exact. `periodsToReach` (in both paths; it needs a logarithm, so it is always
float) takes `{ payment }` like Excel `NPER`.

```ts
import { futureValue, payment, periodsToReach } from '@arki/math/finance/float';

payment(200_000, 0.05 / 12, 360); // 1073.6432460242777
futureValue(1000, 0.05, 7.5); // 1441.8488753719537   fractional periods
periodsToReach(5000, 0, 0.18 / 12, { payment: -200 }); // 31.56…   months to pay off a card
```

## Integers

Number theory with `number` and `bigint` overloads; the `number` form throws
`NumericRangeError` the moment a result leaves the safe range, so switch to
`bigint` for big values. `isPrime` is deterministic Miller–Rabin below
2⁶⁴; `primeFactors` adds Pollard's rho for large cofactors.

```ts
import { combinations, fibonacci, isPrime, modPow, primeFactors } from '@arki/math/integer';

combinations(52, 5); // 2598960
isPrime(9_007_199_254_740_881); // true
primeFactors(360); // [2, 2, 2, 3, 3, 5]
modPow(2n, 10n, 1000n); // 24n
fibonacci(90); // 2880067194370816120n
toBase(255, 16); // 'ff'
fromBase('zz', 36); // 1295n   always bigint, exact past 2^53
```

Bigint `factorial`, `permutations` and `combinations` allow results up to
100 000 digits (`factorial` up to n = 25 205; 10 000! takes about 1.5 ms).
For a float factorial past the safe range, use `gamma(n + 1)` from
`distributions`.

## Geometry

Radians by default; pass `{ angleUnit: 'deg' }` (any angle unit from
`units`) to work in degrees. `solveTriangles` takes any three parts that fix a
triangle and returns every triangle they describe: SSA can give 0, 1 or 2.
`solveTriangle` returns the one triangle and throws when there are none or two.
Areas use stable formulas (Kahan's Heron), so needle-thin triangles stay accurate.

```ts
import { circle, polygonArea, solveTriangle, solveTriangles, sphere } from '@arki/math/geometry';

solveTriangle({ a: 3, b: 4, c: 5 }).area; // 6
solveTriangles({ a: 7, b: 10, A: 30 }, { angleUnit: 'deg' }).length; // 2   the ambiguous case
circle(2).area; // 12.566370614359172
sphere(1).volume; // 4.1887902047863905
polygonArea([
  [0, 0],
  [4, 0],
  [4, 3],
]); // 6
```

## Linear algebra

Dense float64 on plain arrays (`number[]`, `number[][]`): no wrapper class, so
values go to JSON and other libraries as they are, and results never share
memory with inputs. `solve`, `inverse` and `determinant` use LU with partial
pivoting. A matrix singular to working precision throws `SingularMatrixError`
(pivot at or below `n·ε·‖A‖∞`; `{ tolerance }` overrides). Import it from its
subpath; the root does not re-export it.

```ts
import { determinant, inverse, solve } from '@arki/math/linear-algebra';

solve(
  [
    [2, 1, 1],
    [4, -6, 0],
    [-2, 7, 2],
  ],
  [5, -2, 9],
); // [1, 1, 2]
determinant([
  [2, 1, 1],
  [4, -6, 0],
  [-2, 7, 2],
]); // -16
inverse([
  [1, 2],
  [3, 4],
]); // [[-2, 1], [1.5, -0.5]]
```

Decompositions follow LAPACK's algorithms: pivoted Householder QR, Cholesky
(`NotPositiveDefiniteError` when it fails), SVD (Golub–Kahan–Reinsch), and
eigenvalues — symmetric by Householder tridiagonalization and implicit QL,
general by balancing, Hessenberg reduction and Francis double-shift QR.
`leastSquares` uses pivoted QR and returns the minimum-norm solution when `A`
is rank-deficient. `rank` counts singular values above `max(m, n)·ε·σ₁` (NumPy's
rule); `{ method: 'elimination' }` uses LU instead. `conditionNumber` is
`Infinity` for an exactly singular matrix, like NumPy's `cond`. General
eigenvalues come back as `Complex`, sorted like `polynomialRoots`.

```ts
import { eigenvalues, leastSquares, singularValues, symmetricEigenvalues } from '@arki/math/linear-algebra';

symmetricEigenvalues([
  [2, 1],
  [1, 2],
]); // [1.0000000000000002, 3]   ascending
eigenvalues([
  [0, -1],
  [1, 0],
]).map(String); // ['-i', 'i']   a rotation
singularValues([
  [3, 0],
  [4, 5],
]); // [6.708203932499369, 2.23606797749979]
leastSquares(
  [
    [1, 1],
    [1, 2],
    [1, 3],
  ],
  [1, 2, 2],
); // [0.666…, 0.5]   intercept, slope
```

## Complex numbers

Immutable `Complex` with the same verbs as `Decimal`. Principal branches for
`sqrt`, `ln` and `pow`; division by zero throws instead of giving `NaN`.
`toString()` prints `3 + 4i` and parses back exactly.

```ts
import { complex } from '@arki/math/complex';

complex(1, 1).pow(2).toString(); // '2i'
complex('3+4i').abs(); // 5
complex(-1).sqrt().toString(); // 'i'
complex(1).nthRoots(3).length; // 3
complex(1, 1).sin().toString(); // '1.2984575814159773 + 0.6349639147847361i'
complex(2).asin().toString(); // '1.5707963267948966 - 1.3169578969248166i'
```

`sin`, `cos`, `tan`, their inverses and the hyperbolic functions use principal
branches (C99 Annex G). The library has no `-0`, so a point exactly on a branch
cut takes Kahan's counter-clockwise rule, like `sqrt` and `ln` and like mpmath
and Mathematica; C and NumPy pick the other side on half of the cuts.
Measured within 3.1 ulp of a 700-digit reference from 1e-300 to 1e300.

## Roots, integrals and derivatives

Every result carries an error estimate, and a method that misses its tolerance
throws a `ConvergenceError` subclass holding its best estimate (`.best`) instead
of returning a wrong number. A function that returns `NaN` or `Infinity` throws
`NumericRangeError` naming the point. `derivative` and `limit` are numerical
estimates, not proofs.

```ts
import { derivative, limit } from '@arki/math/differentiate';
import { integrate } from '@arki/math/integrate';
import { findRoot } from '@arki/math/roots';

findRoot(x => x ** 3 - 2 * x - 5, [2, 3]).root; // 2.094551481542327   Brent, bracket must change sign
integrate(x => Math.exp(-x * x), [0, Infinity]).value; // 0.886226925452758   √π/2
integrate(x => 1 / Math.sqrt(x), [0, 1], { method: 'tanhSinh' }).value; // 2   endpoint singularity
derivative(Math.sin, 0).value; // 1
limit(x => Math.sin(x) / x, 0).value; // 1
```

## Polynomials

Coefficient arrays, highest degree first (like NumPy's `polyval` and `roots`):
`[1, -6, 11, -6]` is x³ − 6x² + 11x − 6. Roots come back tagged, so you know
whether you got real numbers or `Complex` values. `quadraticRoots` avoids
cancellation; `polynomialRoots` handles any degree.

```ts
import { cubicRoots, evaluatePolynomial, polynomialRoots, quadraticRoots } from '@arki/math/polynomial';

evaluatePolynomial([1, -6, 11, -6], 4); // 6
quadraticRoots(1, -3, 2); // { kind: 'real', roots: [1, 2], discriminant: 1 }   b² − 4ac, error-compensated
quadraticRoots(1, 0, 1).kind; // 'complex'
cubicRoots(1, -6, 11, -6).roots; // [1, 2, 3]
polynomialRoots([1, 0, 0, 0, -1]).length; // 4
```

## Errors

Every error has a stable `code` (`ARKI_MATH_E001` to `E011`, also exported as `MATH_ERROR_CODES`) and a one-sentence `remediation`. Match on the code, never on the message. Wrong runtime types still throw the built-in `TypeError`.

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

| Code             | Error                      | When                                                                                                                                                                             |
| ---------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ARKI_MATH_E001` | `NumberFormatError`        | a string is not a number in the accepted syntax                                                                                                                                  |
| `ARKI_MATH_E002` | `InvalidArgumentError`     | reversed bounds, negative step, p out of range, …                                                                                                                                |
| `ARKI_MATH_E003` | `DivisionByZeroError`      | division by zero, zero to a negative power                                                                                                                                       |
| `ARKI_MATH_E004` | `RoundingNecessaryError`   | an exact result needs rounding and no mode was given                                                                                                                             |
| `ARKI_MATH_E005` | `NumericRangeError`        | non-finite, unsafe integer, overflow or underflow                                                                                                                                |
| `ARKI_MATH_E006` | `EmptyDataError`           | a statistic of an empty (or too small) data set                                                                                                                                  |
| `ARKI_MATH_E007` | `ResourceLimitError`       | more than 10 000 digits, or an exponent beyond ±10 000                                                                                                                           |
| `ARKI_MATH_E008` | `UnsupportedFeatureError`  | the runtime's `Intl` lacks a feature the call relies on                                                                                                                          |
| `ARKI_MATH_E009` | `SingularMatrixError`      | `solve`/`inverse` met a matrix singular to working precision                                                                                                                     |
| `ARKI_MATH_E010` | `ConvergenceError`         | an iterative method did not converge (`polynomialRoots`, eigenvalues, SVD; `RootConvergenceError`, `IntegrationConvergenceError`, `ExtrapolationConvergenceError` carry `.best`) |
| `ARKI_MATH_E011` | `NotPositiveDefiniteError` | `choleskyDecompose` met a matrix that is not positive definite                                                                                                                   |

## Runtime support

- **Node 22+, Bun, Deno, browsers**: everything, verified by the test suite
  and a smoke run of the built package in each runtime (`bun run test:runtimes`).
- **React Native (Hermes V1)**: everything runs; `bun run test:runtimes`
  checks it when `HERMES_BIN` points at a Hermes binary. Two `Intl` gaps
  shape formatting and parsing:
  - Hermes formats decimal text through a double. `Decimal` values are
    rounded exactly first, so anything up to 15 shown digits (every normal
    amount) prints exactly; more throws `UnsupportedFeatureError` instead of
    printing a wrong digit. Compact notation accepts whole numbers only.
  - Hermes on iOS has no `formatToParts`, so locale parsing throws
    `UnsupportedFeatureError`; pass `symbols` to parse without `Intl`.
  - A non-default `rounding` mode throws `UnsupportedFeatureError`.
- Pure ESM, no runtime-specific globals; the lint config rejects any
  `node:*`/`bun:*` import or `process`/`Buffer` use in library code.

## Limits

Every `Decimal` and `Rational` — input or result — has at most 10 000 digits
(integer digits plus scale) and an exponent magnitude of at most 10 000;
anything larger throws `ResourceLimitError`, early from an estimate and exactly
on the result. Internal guard digits do not count, so `PI(9999)` is the largest
π, and every value the library returns parses back from its own `toString()`.
Bigint `factorial`, `permutations` and `combinations` allow results up to
100 000 digits; `fibonacci` and `fromBase` keep 10 000. These are resource
guards against hostile input, not precision settings — within them, arithmetic
is exact.

## Accuracy

Every row below is checked by a test. The tests compare against independent
reference data in [`test/reference/`](./test/reference). That folder is for
development and is not published. The references are mpmath (arbitrary
precision) for `decimal-math`, the special functions and the distributions, and
the [NIST StRD](https://www.itl.nist.gov/div898/strd/) certified values for
statistics and regression. Seeded generator scripts rebuild the data.

The guarantees come in three kinds:

- **Exact.** No rounding happens unless you ask for it: `Decimal` and `Rational`
  arithmetic, `convertExact`, exact `finance`, and integer functions.
- **Correctly rounded.** The result is the true value rounded once, in the mode
  you chose. The tests compare digit for digit, and
  [`test/reference/ERROR-ANALYSIS.md`](./test/reference/ERROR-ANALYSIS.md) has the
  proof.
- **Float bounds.** These are the largest error seen over every reference point,
  tails included. They are measured, not proven. A change that exceeds one fails
  the build.

### Decimal math (`@arki/math/decimal-math`)

Each case runs in all 8 rounding modes, at scales from 0 to 100. In
`unnecessary` mode, an inexact value must throw.

- **Near-tie cases** sit within `10^-(scale+14)` to `10^-(scale+90)` of a
  rounding boundary. They force the Ziv loop to retry with 20, 40, 80 and 160
  guard digits.
- **Exact cases** are roots that land exactly on a tie, and logarithms or powers
  with exact results.

| Function            | Guarantee                                                            | Evidence: cases (random / near-tie / exact)             |
| ------------------- | -------------------------------------------------------------------- | ------------------------------------------------------- |
| `sqrt`              | correctly rounded; exact or `RoundingNecessaryError` without options | 120 / 12 / 12                                           |
| `cbrt`              | correctly rounded; negative input gives a negative root              | 80 / 12 / 12                                            |
| `nthRoot` (n 4–12)  | correctly rounded                                                    | 80 / 12 / 12                                            |
| `exp`               | correctly rounded                                                    | 120 / 32 / —                                            |
| `ln`                | correctly rounded                                                    | 120 / 32 / —                                            |
| `log10`, `log2`     | correctly rounded; exact results detected                            | 159 / 64 / 24                                           |
| `log` (any base)    | correctly rounded; exact results detected                            | 60 / — / 24                                             |
| `pow` (non-integer) | correctly rounded; exact results detected                            | 114 / 32 / 30                                           |
| `PI`, `E`           | correctly rounded (half-even)                                        | Machin and Taylor kernels audited in the error analysis |

### Special functions and distributions (`@arki/math/distributions`)

The error is relative: `|got − want| / |want|`. The noncentral t is the
exception, measured in absolute error. One ulp is about 1.1e-16 to 2.2e-16. The
reference values go down to about 1e-300. Quantiles are tested at `p` from 1e-300
up to `1 − 1e-15`.

| Function                             | Max error                                        | Points | Range covered                                            |
| ------------------------------------ | ------------------------------------------------ | -----: | -------------------------------------------------------- |
| `erf`                                | 4e-16 (2 ulp)                                    |    180 | \|x\| from 1e-300 to 6                                   |
| `erfc`                               | 5e-16 (3 ulp)                                    |    149 | x from −6 to 26.5 (values down to 6e-296)                |
| `erfInv`                             | 5e-16 (2 ulp)                                    |    186 | p from 1e-300 to `1 − 1e-15`                             |
| `gamma`                              | 3e-13                                            |     75 | x from 1e-300 to 171.6, and negative non-integers        |
| `gammaLn`                            | 1e-13                                            |    180 | x from 1e-300 to 1e300                                   |
| `beta`, `betaLn`                     | 2e-12, 5e-13                                     |    336 | a, b from 1e-3 to 1e3                                    |
| `regularizedGammaP`                  | 1e-12                                            |    271 | a from 0.01 to 1000, x from a/1000 to 10a                |
| `regularizedBeta`                    | 2e-11                                            |    800 | a, b from 0.1 to 1000, x from 0.001 to 0.999             |
| `normal` cdf, sf / pdf               | 3e-13 / 2e-13                                    |    570 | z from −37 to 37                                         |
| `normal` quantile                    | 5e-16 (2 ulp)                                    |     68 | p from 1e-300 to `1 − 1e-15`                             |
| `studentT` cdf, sf / pdf             | 5e-12 / 1e-12                                    |  1 560 | df from 1 to 1000, \|t\| up to 1e8                       |
| `studentT` quantile                  | 3e-12                                            |    224 | p from 1e-100 to `1 − 1e-12`                             |
| `chiSquare` cdf, sf, pdf             | 2e-12                                            |    836 | df from 1 to 1000, x from df/10⁴ to 50·df                |
| `chiSquare` quantile                 | 2e-12                                            |    224 | p from 1e-100 to `1 − 1e-12`                             |
| `fisherF` cdf, sf, pdf               | 3e-13                                            |    693 | (df1, df2) from (1, 1) to (100, 100), x from 1e-4 to 1e4 |
| `fisherF` quantile                   | 3e-12                                            |    175 | p from 1e-60 to `1 − 1e-10`                              |
| `noncentralT` cdf                    | 2e-14 **absolute**                               |    174 | df from 5 to 50, ncp from −2 to 10                       |
| `exponential` cdf, sf, pdf, quantile | correctly rounded at every point (bound 2.3e-16) |    211 | x from 1e-10 to 316; p down to 1e-300                    |
| `binomial` pmf, cdf, sf              | 2e-12                                            |  1 022 | n up to 1000, p from 0.01 to 0.9, the whole support      |
| `poisson` pmf, cdf, sf               | 8e-12                                            |  1 558 | λ from 0.5 to 1000, out to λ + 40√λ + 40                 |
| `binomial`, `poisson` quantile       | exact (the smallest k with cdf(k) ≥ p)           |    360 | random p                                                 |

The noncentral t (AS 243) is accurate in absolute terms. Where its cdf is at
least 1e-3, the relative error is at most 1.2e-12. Far down the lower tail, the
relative error grows: 4e-7 where the cdf is 1e-8. For comparison, scipy (Boost)
is off by up to 1.7e-8 relative on the same points.

### Statistics and regression (NIST StRD)

The figures are digits of agreement with the certified values, out of the 15
that NIST certifies. Higher is better. The measure is the log relative error,
LRE = −log₁₀(relative error).

| Dataset (difficulty)                                     | Function                                                                     | Digits on `number` | On `Decimal`                 |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- | -----------------: | ---------------------------- |
| PiDigits, Lottery, Lew, NumAcc1 (lower)                  | `mean`, `stddev`                                                             |             15, 15 | equal to the certified value |
| Mavro, Michelso (lower)                                  | `mean` / `stddev`                                                            |          15 / ≥ 13 | equal to the certified value |
| NumAcc2 (average)                                        | `mean` / `stddev`                                                            |        15 / ≥ 14.5 | equal to the certified value |
| NumAcc3 (average), NumAcc4 (higher)                      | `mean` / `stddev`                                                            |      15 / ≥ 9, ≥ 8 | equal to the certified value |
| Norris (lower)                                           | `linearRegression`: slope, intercept, their standard errors, residual SD, r² |             ≥ 12.5 | —                            |
| Pontius (lower, quadratic)                               | `polynomialRegression`                                                       |             ≥ 11.5 | —                            |
| Filip (higher, degree 10)                                | `polynomialRegression`                                                       |             ≥ 13.5 | —                            |
| Wampler1–5 (higher, degree 5)                            | `polynomialRegression`                                                       | ≥ 9, 12, 9, 9, 7.5 | —                            |
| Longley (higher, 6 predictors); NoInt1, NoInt2 (average) | `leastSquares`                                                               |       ≥ 10.5; ≥ 14 | —                            |

On `Decimal` input, `mean` is exact and `stddev` is correctly rounded. Both
reproduce every certified value digit for digit.

On `number` input, NumAcc3 and NumAcc4 are limited by the data, not by the
algorithm: values such as `10000000.2` are not exact doubles. Against the exact
standard deviation of the binary inputs, `stddev` keeps at least 14 digits on
every dataset.

The polynomial and least-squares rows hold on both V8 and JavaScriptCore.

<!-- bench:start -->

## Benchmarks

Speed of `@arki/math` against the libraries most people reach for: decimal.js, big.js and bignumber.js for decimal arithmetic; fraction.js for exact fractions; simple-statistics and jstat for descriptive statistics; jstat for probability distributions; simple-statistics and regression (regression-js) for curve fitting; ml-matrix and mathjs for linear algebra; complex.js and mathjs for complex numbers; mathjs for polynomial roots. Each table only ranks libraries that returned the same result on every checked input. The published tables come from a publish run on an idle machine and keep every case, including the ones where `@arki/math` is slower.

Node v22.13.1 on Apple M2 Max, 2026-10-13. Median time per operation, lower is better.

### Decimal plus (1234.5678 + 98.76)

| Library      | Time / op | vs fastest |
| ------------ | --------: | ---------: |
| @arki/math   |  102.0 ns |    fastest |
| decimal.js   |  388.5 ns |      3.81× |
| big.js       |  386.0 ns |      3.78× |
| bignumber.js |  268.1 ns |      2.63× |

### Decimal times

| Library      | Time / op | vs fastest |
| ------------ | --------: | ---------: |
| @arki/math   |   98.7 ns |    fastest |
| decimal.js   |  664.9 ns |      6.73× |
| big.js       |  332.4 ns |      3.37× |
| bignumber.js |  502.8 ns |      5.09× |

### Decimal divide, 10 places, half-even

Every library rounds the quotient to 10 decimal places, half-even. The other libraries divide at a working precision first and round after; `@arki/math` rounds once, exactly.

| Library                                   | Time / op | vs fastest |
| ----------------------------------------- | --------: | ---------: |
| @arki/math dividedBy({ scale, rounding }) |  673.5 ns |    fastest |
| decimal.js div + toDecimalPlaces          |  11.21 µs |     16.65× |
| big.js div + round                        |   4.12 µs |      6.11× |
| bignumber.js dividedBy + decimalPlaces    |  13.34 µs |     19.81× |

### Decimal parse a string

| Library              | Time / op | vs fastest |
| -------------------- | --------: | ---------: |
| @arki/math decimal() |  476.1 ns |    fastest |
| decimal.js           |  712.0 ns |      1.50× |
| big.js               |  699.4 ns |      1.47× |
| bignumber.js         |  911.6 ns |      1.91× |

### Decimal toString (30 integer digits, 9 decimals)

| Library      | Time / op | vs fastest |
| ------------ | --------: | ---------: |
| @arki/math   |  336.6 ns |      1.00× |
| decimal.js   |  460.7 ns |      1.37× |
| big.js       |   2.06 µs |      6.13× |
| bignumber.js |  336.3 ns |    fastest |

### Rational plus (355/113 + 22/7)

| Library          | Time / op | vs fastest |
| ---------------- | --------: | ---------: |
| @arki/math ratio |  235.6 ns |    fastest |
| fraction.js      |  441.5 ns |      1.87× |

### Rational times

| Library          | Time / op | vs fastest |
| ---------------- | --------: | ---------: |
| @arki/math ratio |  619.0 ns |      1.77× |
| fraction.js      |  349.4 ns |    fastest |

### Mean of 1,000 numbers

| Library           | Time / op | vs fastest |
| ----------------- | --------: | ---------: |
| @arki/math        |  34.69 µs |     12.80× |
| simple-statistics |   2.71 µs |    fastest |

### Standard deviation of 1,000 numbers (population)

| Library                             | Time / op | vs fastest |
| ----------------------------------- | --------: | ---------: |
| @arki/math                          |  14.85 µs |      5.85× |
| simple-statistics standardDeviation |   2.54 µs |    fastest |

### 90th percentile of 1,000 numbers

Both interpolate linearly between ranks, so results agree to rounding.

| Library                    | Time / op | vs fastest |
| -------------------------- | --------: | ---------: |
| @arki/math percentile      | 304.59 µs |     61.28× |
| simple-statistics quantile |   4.97 µs |    fastest |

### Normal distribution cdf at 1.96

| Library                 | Time / op | vs fastest |
| ----------------------- | --------: | ---------: |
| @arki/math normal().cdf |  470.7 ns |      2.34× |
| jstat normal.cdf        |  201.3 ns |    fastest |

### Normal distribution quantile at 0.975

| Library                      | Time / op | vs fastest |
| ---------------------------- | --------: | ---------: |
| @arki/math normal().quantile |   1.28 µs |    fastest |
| jstat normal.inv             |   2.39 µs |      1.88× |

### Student t (10 degrees of freedom) quantile at 0.975

`@arki/math` solves the quantile until |cdf(x) − p| ≤ 1e-12 and rejects bad input; jstat uses a looser fixed approximation with no input checks.

| Library                          | Time / op | vs fastest |
| -------------------------------- | --------: | ---------: |
| @arki/math studentT(10).quantile |   4.90 µs |      5.03× |
| jstat studentt.inv               |  974.2 ns |    fastest |

Read the rows with the contracts in mind:

- `@arki/math` Decimal is exact: it stores a bigint plus a scale and never rounds unless you ask. Division throws when the result does not terminate, so every divide case below passes an explicit `{ scale, rounding }`.
- decimal.js and bignumber.js round to a working precision on every operation (here 40 significant digits for decimal.js, 20 decimal places for bignumber.js and big.js). They are fast because they give up exactness; `@arki/math` gives up some speed to keep it.
- Rational is exact and always reduced to lowest terms, as in fraction.js.
- Statistics functions in `@arki/math` check every element is a finite number, copy the input, sum with Neumaier compensation (so the total is accurate) and sort the full array for percentiles. simple-statistics skips the checks and the copy, uses plain summation and selects the percentile without a full sort. That is why they are much faster on 1,000 numbers: `@arki/math` trades speed for validated input and accurate sums.

Reproduce with `bun run bench` in the package directory; regenerate this section with `bun run bench --write-readme`.
<!-- bench:end -->

## License

MIT
