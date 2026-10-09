# @arki/math

## 0.0.3

Correctness and performance pass after an independent review.

Fixed:

- Distribution quantiles converge on probability, not on an absolute `x`
  tolerance: `chiSquare(0.1).cdf(inv(0.05))` is `0.05` again (was `0.175`).
  Discrete `inv(p)` is exactly "smallest `k` with `cdf(k) ≥ p`".
- Non-central t: density no longer cancels to `0` near `x = 0`; the far tail
  (`cdf(1e200)`) is `1`, not `Φ(−1)`.
- `Rational#toNumber()` rounds in binary to the nearest double (ties to
  even), including subnormals; it used to round through 20 decimal digits.
- `divmod` on large safe integers is exact (the intermediate product could
  exceed 2^53).
- `mean`/`percentile`/`variance` no longer overflow to `NaN`/`Infinity` for
  values near `1e308` when the result is representable.
- Digit limits can no longer be bypassed through exponents, bigint inputs or
  `times`; `pow10` memory is bounded.
- `formatNumber` of a Decimal beyond Intl's range throws `NumericRangeError`
  instead of printing `∞`; the exact-string Intl probe now discriminates.
- `spellNumber` thresholds return the value intact (`'0.0001'`, not `'0'`);
  oversized inputs are rejected before any work; Spanish `dosmilésimo`.
- `num()` validates operands (`num(2).dividedBy(Infinity)` throws).
- `decimal-math`: `log` of a padded exact power no longer exhausts guard
  digits; convergence errors name the operation and scale.

Added: `Decimal.compare` (sort comparator), `quantile(values, q)` on 0–1,
`.quantile(p)` and `.sf(x)` on distributions, `NumberWordsLocale.maxGroups`.
Renamed with deprecated aliases: `SpreadOptions` → `VarianceOptions`,
`PrecisionOptions` → `DecimalMathOptions`.

Faster: `Decimal.sum` (single accumulator), `Rational` add/multiply
(Knuth GCD / cross-cancellation), `sum()` (no copies), `formatCurrency`
(~4×, bound formatters ~8×), `parseNumber` (~9×). `scripts/bench.mjs`
tracks 30 cases.

## 0.0.2

- `@arki/math/distributions` — normal, Student t, non-central t, chi-square,
  F, exponential, uniform, binomial, Poisson (`pdf`/`pmf`, `cdf`, `inv`,
  `mean`, `variance`) plus `erf`, `erfc`, `erfInv`, `gammaLn`,
  `regularizedGammaP`, `regularizedBeta`. Verified against jstat and numerical
  integration.
- `@arki/math/decimal-math` — correctly rounded `sqrt`, `cbrt`, `nthRoot`,
  `exp`, `ln`, `log10`, `log2`, `log`, fractional `pow`, `PI(scale)`,
  `E(scale)` on `Decimal`, differential-tested against decimal.js.
- `@arki/math/words` — `spellNumber`, `spellOrdinal`, `formatOrdinal` with
  English built in (`en`, `enGB`) and opt-in locales `@arki/math/words/ro`,
  `/de`, `/fr`, `/es`, `/it` carrying real grammar (gender agreement,
  Romanian `de`, French `soixante-dix`, Spanish apocope, Italian and German
  single-word compounds).

## 0.0.1

Rebuilt from scratch as a zero-dependency library. The previous `./number`,
`./fractions` and `./stat` entry points (thin re-exports of mathjs) are gone.

- `@arki/math/decimal` — exact `Decimal` on `bigint` with retained scale,
  exact-or-throw division, eight rounding modes.
- `@arki/math/rational` — exact `Rational`, repeating-decimal parsing,
  `approximate(maxDenominator)`.
- `@arki/math/number` — `clamp`, `lerp`, `inverseLerp`, `remap`, `inRange`,
  `round` (rounds the number you typed), `roundTo`, `approxEqual`.
- `@arki/math/integer` — `gcd`, `lcm`, `divmod` for `number` and `bigint`.
- `@arki/math/stats` — compensated `sum`, `mean`, `median`, `mode`,
  `percentile` (R‑7), `variance`/`stddev` (sample by default), `minMax`,
  `correlation`, `linearRegression`.
- `@arki/math/format` — `Intl.NumberFormat`-backed `formatNumber`,
  `formatCurrency`, `formatPercent`, `formatCompact`, `formatFileSize`,
  `createFormatter`; exact `Decimal` input; cached formatters; no global locale.
- `@arki/math/parse` — locale-aware `parseNumber` / `parseDecimal`.
- `@arki/math/random` — seeded xoshiro128\*\* or crypto-backed generators:
  `int`, `float`, `bool`, `pick`, `shuffle`, `sample`, `gaussian`.
- `@arki/math/fluent` — `num()` immutable wrapper.
- `@arki/math/errors`, `@arki/math/rounding` — shared error hierarchy and
  `RoundingMode`.
- Runs in Node 22+, Bun, Deno, browsers and React Native (Hermes);
  `bun run test:runtimes` smoke-tests the built package in each runtime.
