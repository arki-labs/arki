# @arki/math agent guide

Read `llms.txt` first for the map. When this guide and `AGENTS.md` disagree, `AGENTS.md` wins.

## The model

1. `Decimal` (`coefficient × 10^-scale`) and `Rational` (a `bigint` fraction) are exact. They are immutable and never become floats by accident.
2. The plain-number modules (`number`, `stats`, `geometry`, `roots`, `linear-algebra`, and others) are float64 with an honest error estimate.
3. Rounding is always explicit. The modes are `up`, `down`, `ceiling`, `floor`, `halfUp`, `halfDown`, `halfEven` and `unnecessary`.
4. Failure is a typed error. Nothing returns `NaN` or `null` to signal it.
5. Every module is its own subpath, and each has a page in `docs/modules/`.

## Task map

### Add exact amounts

1. Import `decimal` from `@arki/math/decimal`.
2. Build values from strings: `decimal('19.99')`.
3. Use `plus`, `minus`, `times`. They never round.
4. Round once, at the end, with `toScale(2, 'halfEven')`.

```ts
import { decimal } from '@arki/math/decimal';

const total = decimal('19.99').times(3).plus('0.30');
total.toString(); // '60.27'
total.times('0.19').toScale(2, 'halfEven').toString(); // '11.45'
```

### Divide without losing digits

1. Use `ratio(a, b)` from `@arki/math/rational` when the answer is a fraction.
2. Use `decimal(1).dividedBy(3, { scale: 4, rounding: 'halfEven' })` when you need a decimal.

### Format and parse numbers

1. Show with `formatNumber`, `formatCurrency` or `formatPercent` from `@arki/math/format`.
2. Read locale text with `parseNumber` or `parseDecimal` from `@arki/math/parse`. They return the value or a failure (`InvalidNumber`, `NumberOutOfRange`); check with `isFailure` from `@arki/failure`.

### Statistics, distributions and roots

1. Use `stats` for `mean`, `median`, `stddev`, regression. `mean` to `stddev` are exact on `Decimal[]`.
2. Use `distributions` for `normal`, `studentT`, `erf`, `gamma`.
3. Use `roots.findRoot(f, [a, b])` with a bracket that changes sign.

### Money

Use `@arki/money`. It builds on this package.

## Rules that bite

- Parsers return, builders throw. Outside text goes through `parseNumber`, `parseDecimal`, `parseComplex` or `fromBase`, which return `InvalidNumber` or `NumberOutOfRange`. `decimal('…')`, `ratio('…')` and `complex('…')` throw.
- `decimal(0.1 + 0.2)` is already wrong. Build from strings.
- `decimal(1).dividedBy(3)` throws `RoundingNecessaryError`. Pass a scale and a mode.
- `d.toScale(1)` throws when it would drop a non-zero digit. Pass a mode.
- A `Decimal` over 10 000 digits throws `ResourceLimitError`.
- Hermes on iOS has no `formatToParts`: locale parsing throws `UnsupportedFeatureError`. Pass `symbols`.
- `linear-algebra` is not re-exported from the root.

## Errors

| Code             | Error                      | What to do                                             |
| ---------------- | -------------------------- | ------------------------------------------------------ |
| `ARKI_MATH_E001` | `NumberFormatError`        | Pass plain ASCII decimal text                          |
| `ARKI_MATH_E002` | `InvalidArgumentError`     | Fix the argument named in the message                  |
| `ARKI_MATH_E003` | `DivisionByZeroError`      | Check the divisor                                      |
| `ARKI_MATH_E004` | `RoundingNecessaryError`   | Pass a scale and a rounding mode                       |
| `ARKI_MATH_E005` | `NumericRangeError`        | Use `bigint` or `Decimal`, or stay in the finite range |
| `ARKI_MATH_E006` | `EmptyDataError`           | Check the data length first                            |
| `ARKI_MATH_E007` | `ResourceLimitError`       | Stay within 10 000 digits                              |
| `ARKI_MATH_E008` | `UnsupportedFeatureError`  | Pass `symbols`, or use another runtime                 |
| `ARKI_MATH_E009` | `SingularMatrixError`      | Use `leastSquares` or `pseudoInverse`                  |
| `ARKI_MATH_E010` | `ConvergenceError`         | Read `.best`; widen the tolerance or the bracket       |
| `ARKI_MATH_E011` | `NotPositiveDefiniteError` | Use LU or QR instead of Cholesky                       |

## Verify

```sh
bun run test:docs
bun run typecheck
bun run test
```
