# @arki/math

Math toolkit for TypeScript, whose one dependency is `@arki/failure`. Exact where it must be, fast
where it can be, and honest about which is which. Runs unchanged in Node 22+,
Bun, Deno, browsers, and React Native (Hermes).

## Install

```sh
bun add @arki/math
# or: npm install @arki/math
# or: deno add npm:@arki/math
```

## Quick start

Total an invoice exactly. Only the tax step rounds, and it says how.

```ts from="examples/exact-invoice.ts#invoice"
import { decimal } from '@arki/math/decimal';

type InvoiceLine = { readonly price: string; readonly quantity: number };

/** Totals an invoice exactly. Only the tax step rounds, and it says how. */
export function invoiceTotals(lines: readonly InvoiceLine[], taxRate: string) {
  const subtotal = lines.reduce((total, line) => total.plus(decimal(line.price).times(line.quantity)), decimal(0));
  const tax = subtotal.times(taxRate).toScale(2, 'halfEven');
  return { subtotal: subtotal.toString(), tax: tax.toString(), total: subtotal.plus(tax).toString() };
}

invoiceTotals(
  [
    { price: '19.99', quantity: 3 },
    { price: '0.10', quantity: 3 },
  ],
  '0.19',
);
// { subtotal: '60.27', tax: '11.45', total: '71.72' }
```

Float math gives `60.269999999999996` here. `Decimal` gives `60.27`.

## When not to use this

- You need symbolic algebra or expression parsing. Use `@arki/expr` and `@arki/cas`, built on this package.
- You need money with a currency. Use `@arki/money`. It builds on this package: same rounding modes, same error family, and it accepts `Decimal` and `Rational` as amounts.
- You need sparse matrices or big numerical linear algebra. `linear-algebra` works on plain arrays of float64.
- You need arbitrary-precision trigonometry. `complex`, `geometry` and the rest of the numeric layer are float64.
- You only add and compare small integers. Plain `number` is enough.

## Runtime support

- **Node 22+, Bun, Deno, browsers**: everything, verified by the test suite and a smoke run of the built package in each runtime (`bun run test:runtimes`).
- **React Native (Hermes V1)**: everything runs; `bun run test:runtimes` checks it when `HERMES_BIN` points at a Hermes binary. Two `Intl` gaps shape formatting and parsing:
  - Hermes formats decimal text through a double. `Decimal` values are rounded exactly first, so anything up to 15 shown digits (every normal amount) prints exactly; more throws `UnsupportedFeatureError` instead of printing a wrong digit. Compact notation accepts whole numbers only.
  - Hermes on iOS has no `formatToParts`, so locale parsing throws `UnsupportedFeatureError`; pass `symbols` to parse without `Intl`.
  - A non-default `rounding` mode throws `UnsupportedFeatureError`.
- Pure ESM, no runtime-specific globals; the lint config rejects any `node:*`/`bun:*` import or `process`/`Buffer` use in library code.

<!-- runtimes:start -->

| Runtime | Result  | Version tested        | Date (UTC) |
| ------- | ------- | --------------------- | ---------- |
| node    | pass    | v26.11.1              | 2026-10-17 |
| bun     | pass    | 1.4.2                 | 2026-10-17 |
| deno    | pass    | 2.9.7                 | 2026-10-17 |
| browser | pass    | Chromium 156.0.8078.4 | 2026-10-17 |
| hermes  | not run | -                     | 2026-10-17 |

<!-- runtimes:end -->

## Public imports

Everything is a subpath import, tree-shakeable by concern. The root `@arki/math` re-exports it all except `linear-algebra`, whose short names (`plus`, `times`, `norm`, `inverse`) would clash at the root.

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

Deliberately **not** here: expression parsing and symbolic algebra (they are languages with their own security surface; they live in the sibling packages `@arki/expr` and `@arki/cas`), sparse matrices, and arbitrary-precision trigonometry.
`geometry`, `linear-algebra`, `complex`, `polynomial`, `roots`, `integrate` and
`differentiate` work on plain `number` (float64), like the rest of the numeric
layer.

## Failure behaviour

Every error has a stable `code` (`ARKI_MATH_E001` to `E011`, also exported as `MATH_ERROR_CODES`) and a one-sentence `remediation`. Match on the code, never on the message. Wrong runtime types still throw the built-in `TypeError`.

```ts
import { decimal } from '@arki/math/decimal';
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

Parsers return, builders throw. Outside text (a form field, a query string,
an import) goes through `parseNumber`, `parseDecimal`, `parseComplex` or
`fromBase`. Each returns the value or a typed failure from `@arki/failure`,
and never throws for bad text:

| Code                       | Failure            | When                                                                                       |
| -------------------------- | ------------------ | ------------------------------------------------------------------------------------------ |
| `math.invalid_number`      | `InvalidNumber`    | the text is not a number in the parser's syntax, locale or base                            |
| `math.number_out_of_range` | `NumberOutOfRange` | past 10 000 digits, an exponent or scale past ±10 000, or past the float range of a number |

```ts
import { isFailure } from '@arki/failure';
import { parseDecimal } from '@arki/math/parse';

const amount = parseDecimal('1.234,56', { locale: 'de-DE' });
const shown = isFailure(amount) ? `rejected: ${amount.code}` : amount.toString(); // '1234.56'
```

Builders (`decimal('1.5')`, `ratio('1/3')`, `complex('3+4i')`) take text you
control and throw. Arithmetic throws the documented errors below.

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

## Limits

Every `Decimal` and `Rational` — input or result — has at most 10 000 digits
(integer digits plus scale) and an exponent magnitude of at most 10 000;
anything larger throws `ResourceLimitError`, early from an estimate and exactly
on the result. Internal guard digits do not count, so `PI(9999)` is the largest
π, and every value the library returns parses back from its own `toString()`.
No bigint the library builds passes 18 000 digits (60 000 bits), on every
runtime: Hermes V1 (React Native) throws `Maximum BigInt size exceeded` past
about 19 690 digits (measured 2026-10-30 on 250829098.0.17), so the cap is the
same everywhere. Every operation checks its intermediate from an estimate before
building it and throws `ResourceLimitError`. In practice two 10 000-digit
operands cannot be multiplied, roots reach about 9 000 digits (`sqrt(2, { scale:
8998 })` is the last), `exp`, `ln`, `log` and non-integer `pow` about 8 900, and
bigint `factorial` (up to n = 5 450), `permutations`, `combinations` and `lcm`
allow results up to 18 000 digits; `fibonacci` and `fromBase` keep 10 000. These
are resource guards against hostile input, not precision settings — within
them, arithmetic is exact.

Boundary example: a `Decimal` with 10 000 digits is the largest allowed. One more digit throws `ResourceLimitError`.

```ts run
import { decimal } from '@arki/math/decimal';
import { ResourceLimitError } from '@arki/math/errors';

decimal('9'.repeat(10_000)); // the largest allowed
let limited = false;
try {
  decimal('9'.repeat(10_001));
} catch (error) {
  limited = error instanceof ResourceLimitError;
}
if (!limited) throw new Error('10 001 digits must throw ResourceLimitError');
```

## Documentation

One page per module, with the full reference and examples. The accuracy claims and their evidence are in [Accuracy](docs/accuracy.md).

| Module                      | Page                                             |
| --------------------------- | ------------------------------------------------ |
| `@arki/math/complex`        | [complex](docs/modules/complex.md)               |
| `@arki/math/decimal`        | [decimal](docs/modules/decimal.md)               |
| `@arki/math/decimal-math`   | [decimal-math](docs/modules/decimal-math.md)     |
| `@arki/math/differentiate`  | [differentiate](docs/modules/differentiate.md)   |
| `@arki/math/distributions`  | [distributions](docs/modules/distributions.md)   |
| `@arki/math/finance`        | [finance](docs/modules/finance.md)               |
| `@arki/math/fluent`         | [fluent](docs/modules/fluent.md)                 |
| `@arki/math/format`         | [format](docs/modules/format.md)                 |
| `@arki/math/geometry`       | [geometry](docs/modules/geometry.md)             |
| `@arki/math/integer`        | [integer](docs/modules/integer.md)               |
| `@arki/math/integrate`      | [integrate](docs/modules/integrate.md)           |
| `@arki/math/linear-algebra` | [linear-algebra](docs/modules/linear-algebra.md) |
| `@arki/math/number`         | [number](docs/modules/number.md)                 |
| `@arki/math/parse`          | [parse](docs/modules/parse.md)                   |
| `@arki/math/polynomial`     | [polynomial](docs/modules/polynomial.md)         |
| `@arki/math/random`         | [random](docs/modules/random.md)                 |
| `@arki/math/rational`       | [rational](docs/modules/rational.md)             |
| `@arki/math/roots`          | [roots](docs/modules/roots.md)                   |
| `@arki/math/rounding`       | [rounding](docs/modules/rounding.md)             |
| `@arki/math/stats`          | [stats](docs/modules/stats.md)                   |
| `@arki/math/units`          | [units](docs/modules/units.md)                   |
| `@arki/math/words`          | [words](docs/modules/words.md)                   |

- [Accuracy](docs/accuracy.md): what is exact, what is correctly rounded, and the reference data behind each claim.
- [Agent guide](docs/agent-guide.md): the model, the task map and the rules.
- [llms.txt](llms.txt): the short index for agents.
- [CHANGELOG](CHANGELOG.md): what changed in each version.

## Support

Report a bug or ask a question in the [Arki issue tracker](https://github.com/arki-labs/arki/issues). Include the module, the input and the error `code`.

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

## Accuracy

Every claim is checked by a test against independent reference data: mpmath for `decimal-math`, the special functions and the distributions, and the NIST StRD certified values for statistics and regression. The guarantees come in three kinds: exact, correctly rounded, and accurate to a stated bound. The table of every row, with its evidence, is in [Accuracy](docs/accuracy.md).

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
