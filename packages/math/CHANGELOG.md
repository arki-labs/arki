# @arki/math

## 0.1.0

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
