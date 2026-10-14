# @arki/math

## 0.0.10

Proof and the numerical core.

Added:

- **Accuracy evidence.** Reference tests against mpmath (1 163 decimal-math cases, 160 near rounding boundaries; 9 852 distribution and special-function points down to 1e-300 tails) and the 20 NIST StRD datasets; an error analysis proving `decimal-math`'s rounding bound; the README "Accuracy" table lists each function's guarantee and evidence.
- **Property tests and differential fuzzing** (fast-check, dev-only): algebraic laws, rounding against a BigInt oracle, Decimal vs decimal.js at 60 digits, Rational vs fraction.js, hostile input always ends in a `MathError`.
- `linear-algebra`: eigenvalues and eigenvectors (`symmetricEigenvalues`, `symmetricEigenDecompose`, `eigenvalues`, `eigenDecompose`), pivoted QR (`qrDecompose`), Cholesky (`choleskyDecompose`, `choleskySolve`, `NotPositiveDefiniteError`), SVD (`singularValues`, `singularValueDecompose`), `leastSquares`, `pseudoInverse`, `conditionNumber`.
- `@arki/math/roots` (Brent `findRoot`, `bisect`, safeguarded `newton`, `findRoots`), `@arki/math/integrate` (adaptive Gauss–Kronrod G7–K15 and tanh-sinh, infinite intervals), `@arki/math/differentiate` (Ridders `derivative`, Richardson `limit`). Results carry error estimates; failures throw `ConvergenceError` subclasses with `.best`.
- `Complex`: `sin`, `cos`, `tan`, `sinh`, `cosh`, `tanh` and their inverses; principal branches, Kahan's counter-clockwise rule on cuts; within 3.1 ulp of a 700-digit reference.

Changed:

- **Breaking:** `rank` counts singular values by default (NumPy's rule); `{ method: 'elimination' }` keeps the LU count.
- **Breaking:** one digit cap for every `Decimal`/`Rational` result (10 000 digits, guard digits excluded): `PI(10000)`, `E(10000)`, `sqrt(2, { scale: 10000 })`, products and sums past the cap now throw `ResourceLimitError`; `decimal(3).pow(-20000)` throws `RoundingNecessaryError`.
- `polynomialRegression` solves by pivoted QR instead of the normal equations: up to five orders of magnitude more accurate at degree 10–18.
- LU-based `solve`, `determinant` and `inverse` about 2× faster.

Fixed:

- Far-tail quantiles of `studentT`, `chiSquare`, `fisherF` and `noncentralT` were badly wrong (`studentT(100).quantile(1 − 1e-12)` gave 68 instead of 8.03); they now hold 1e-12 relative error. `normal.quantile` near 0.5 is 2 ulp (was 1e-9 relative).
- `eigenDecompose` returned wrong eigenvectors on badly scaled matrices; balancing now follows LAPACK `dgebal` (residual 4.0 → 1e-100 on the worst case).
- `Complex#sqrt` of a subnormal number threw; `Decimal`/`Rational` products ran away instead of stopping at the digit limit; `pow` with a huge integer exponent threw `InvalidArgumentError`; `Decimal#pow` refused results that fit (`2^14000`, `1^20000`); `nominalRate` hit the cap early; a scale-10000 value below 1 did not parse back from its own text.

## 0.0.9

Speed: fastest against decimal.js, big.js, bignumber.js, fraction.js, complex.js, ml-matrix, mathjs, jstat, simple-statistics and regression-js in nearly every benchmark group.

Changed:

- **Breaking:** `Decimal`, `Rational` and `Complex` instances are no longer frozen (`Object.isFrozen` is `false`). Methods still never modify their operands and fields stay `readonly`. Freezing every result cost 5–7× in hot loops, because a frozen result cannot be optimized away; no peer library freezes. Shared constants (`Complex.ZERO`/`ONE`/`I`, the `1` returned by `pow(0)` and `exp(0)`, the Rational zero) stay frozen.
- Exponential, logarithmic, power and polynomial fits compute `r2` and the other diagnostics on first read (2–3× faster when unread; identical values). Fit fields are `readonly`.

Faster (identical results, checked against the previous build):

- Linear algebra: `multiply` about 7×, `inverse` 2×, `solve` and `determinant` about 1.5× (i-k-j loops on `Float64Array` rows; cheap validation).
- `linearRegression` about 7× (one fused pass for plain arrays); `powerRegression` about 2.5×.
- `sum`, `mean` and the statistics built on them: compensated summation on four independent streams, same accuracy.
- `Complex` `times`, `dividedBy`, `sqrt`, `pow`, `ln`; `Decimal#toString` for coefficients in the safe-integer range.

Fixed:

- `Complex#dividedBy` follows Baudin & Smith (2012): `(1e308 + 1e308i) / (1e308 + 1e308i)` is 1 instead of a range error, and all ten hard cases from the paper are correctly rounded.
- `Complex#abs` and `toPolar` threw nothing and returned `Infinity` past the float range; they now throw `NumericRangeError`. `ln`, `log`, `sqrt`, `pow`, `nthRoots` and `approxEqual` work for |z| beyond `Number.MAX_VALUE`.

## 0.0.8

General math a calculators app still needed: composite units, quartile and pooled-variance variants, and two fixes.

Added:

- `units` — `splitUnits`/`joinUnits` for composite values (5 ft 7 in, 1 h 30 min); a negative value carries its sign on the first non-zero part. Units `dm`, `fathom`, `pc`, `ct`, `ton_us`, `ton_uk`, `kcal/h`, `GJ`, `ft*lbf`, `PB`, `EB`, `PiB`, `EiB`.
- `stats` — `quartiles` method `'medianExcluded'`; `pooledVariance`/`pooledStddev` accept `{ n, stddev }` / `{ n, variance }` summaries (`SampleSummary`).
- `polynomial` — `quadraticRoots` results carry an error-compensated `discriminant`, and its sign decides real vs complex.

Fixed:

- `polynomialRegression` threw "ill-conditioned" for x far from zero (years); it now solves on centered, scaled x.
- `round`, `roundTo` and `roundToSignificant` threw on floats past 2^53 (`round(1e20, 2)`); they round them as typed.

## 0.0.7

Float finance, more statistics and units, and a faster `round`.

Added:

- `@arki/math/finance/float` — the finance functions on `number` with the same names and sign rules: fractional and negative periods, no digit limit, fast in loops; `log1p`/`expm1` keep tiny rates accurate.
- `finance` — `futureValue`/`presentValue` take `{ payment, timing }` (Excel `FV`/`PV` with a payment); `periodsToReach` takes `{ payment, timing }` (Excel `NPER`).
- `stats` — `quantile`/`percentile` `{ method }` for all nine Hyndman–Fan definitions (NumPy names, `QUANTILE_METHODS`); `quartiles` (incl. Tukey hinges); `percentileRank`; `pooledVariance`, `pooledStddev`; the linear fit reports `adjustedR2`, `residualStandardError`, `slopeStandardError`, `interceptStandardError`, the polynomial fit `adjustedR2`, `residualStandardError`.
- `distributions` — `gamma`, `beta`, `betaLn`.
- `units` — electric current, illuminance, radioactivity, dynamic and kinematic viscosity, solid angle (22 categories); `nm`, `µm`, `au`, `ly`, `cm3`, `in3`, `ft3`, `yd3`, imperial volumes, `month`, `year` (Julian), `ft/s`, `MJ`, `BTU`, `eV`, `MPa`, `Torr`, `arcmin`, `arcsec`, `kbit`…`Gibit`.
- `format` — `formatCompact` takes `currency`; `locale: 'default'` (`RUNTIME_LOCALE`) formats in the runtime's locale.

Changed:

- `round`/`roundTo` are about 15–20× faster through a float fast path; results are identical (checked against the exact path on 1.6M seeded cases in all rounding modes).
- Bigint `factorial`, `permutations` and `combinations` allow results up to 100 000 digits (was 10 000); `factorial` and `permutations` use product splitting.
- `quantile` treats a position within 4 ulps of a whole number as whole, as R does.
- `AngleUnit`, `UnitCategory` and `Unit` gained members, so exhaustive `Record<AngleUnit, …>` code must add them.

## 0.0.6

Four new modules and the general math a calculator site needs.

Added:

- `@arki/math/geometry` — `solveTriangles`/`solveTriangle` from any three parts (SSA returns 0–2 triangles), `circle`, `circleSector`, `ellipse`, `regularPolygon`, volumes and surfaces of sphere, cylinder, cone, frustum, square pyramid, cube, cuboid and torus, `distance`, `midpoint`, `polygonArea`/`signedPolygonArea`, `isPythagoreanTriple`, `pythagoreanTriples`.
- `@arki/math/linear-algebra` (subpath only) — vectors and dense matrices on plain arrays: `dot`, `cross`, `norm`, `normalize`, `angleBetween`, `projection`, `plus`, `minus`, `times`, `matrix`, `identity`, `transpose`, `trace`, `multiply`, `luDecompose`, `determinant`, `solve`, `inverse`, `rank`.
- `@arki/math/complex` — immutable `Complex`/`complex()`: arithmetic, polar form, `exp`, `ln`, `log`, `sqrt`, `pow`, `nthRoots`, strict parsing of `'3+4i'`.
- `@arki/math/polynomial` — coefficient arrays highest degree first: `evaluatePolynomial`, `polynomialDerivative`, `addPolynomials`, `multiplyPolynomials`, `quadraticRoots`, `cubicRoots`, `polynomialRoots` (any degree).
- `stats` — `zScore`, `standardError`, `marginOfError`, `confidenceInterval`, `sampleSize`; `exponentialRegression`, `logarithmicRegression`, `powerRegression`, `polynomialRegression`.
- `units` — power, frequency, force, torque, fuel economy (`l/100km` as the reciprocal of `km/l`) and data rate: 17 categories.
- `integer` — `toBase`, `fromBase` (bases 2–36, `bigint`-exact).
- `number` — `roundToSignificant`, `significantDigits`; `Decimal#roundToSignificant`.
- `errors` — `SingularMatrixError`, `ConvergenceError`.

Changed:

- `linearRegression` now also returns `r2` and `predict(x)`, like the other fits.

## 0.0.5

React Native support, and money leaves the package.

Removed:

- `@arki/math/money` and `CurrencyMismatchError`. Money lives in its own package, `@arki/money` (exact amounts on whole units, a shipped ISO 4217 table, no default rounding).

Fixed (found by the new Hermes V1 runtime check, React Native 0.86):

- Importing the package crashed on React Native: English ordinals built an `Intl.PluralRules` at load time, which Hermes lacks. The suffix is now plain arithmetic.
- `median`, `percentile`, `mode`, `divisors` and the number-word helpers used `toSorted`/`toReversed`, which Hermes lacks. Lint now forbids them.
- Locale parsing without `Intl.NumberFormat#formatToParts` threw a raw `TypeError`; it now throws `UnsupportedFeatureError`. New `symbols` option (`{ decimal, group, minusSign?, digits? }`) parses without `Intl`.
- Formatting a `Decimal` or decimal string on Hermes always threw, because Hermes formats text through a double. The value is now rounded exactly first; up to 15 shown digits print exactly, more still throw `UnsupportedFeatureError`.
- `test:runtimes` gains a Hermes leg (`HERMES_BIN`).

## 0.0.4

Coherence pass plus four new modules. The 0.0.x track carries no
compatibility promise; renames below are not aliased.

Added:

- `@arki/math/money` — `Money`/`money()`: a `Decimal` pinned to the currency's `Intl` minor-unit scale; exact-or-throw construction, banker's rounding for `times`/`dividedBy`, lossless `allocate`, `toMinorUnits`, `parse`/`toString` round-trip, `format` via `formatCurrency`, `CurrencyMismatchError`; unknown ISO codes are rejected via `Intl.supportedValuesOf`.
- `@arki/math/units` — `convert`, `convertExact` (returns `Rational`), `formatUnit`, `unitCategory`, `unitsOf`, `isUnit` over 11 categories with exact rational factors.
- `@arki/math/finance` — `payment`, `amortizationSchedule`, `futureValue`, `presentValue`, `netPresentValue`, `internalRateOfReturn`, `effectiveRate`, `nominalRate`, `compoundInterest`, `simpleInterest`, `periodsToReach` on `Decimal`, exact intermediates rounded once at the requested scale (integer periods only; `nominalRate` carries a guard-digit caveat).
- `@arki/math/integer` — `factorial`, `combinations`, `permutations`, `isPrime` (deterministic below 2⁶⁴), `primeFactors` (trial division + Pollard's rho), `divisors`, `modPow`, `modInverse`, `isEven`, `isOdd`, `digitSum`, `fibonacci`.
- `@arki/math/stats` — `mean`, `median`, `minMax`, `variance`, `stddev` accept `Iterable<Decimal>` and return exact `Decimal` results (`stddev` is correctly rounded at the requested scale); `sum` stays number-only — use `Decimal.sum`. Mixed inputs throw `TypeError`.
- `@arki/math/number` — `range(start, end, step)` and `linspace(start, end, count)` computed without accumulation drift; capped at 10 million elements.
- `Decimal#roundTo(step, rounding)`.
- Integer results (`factorial`, `combinations`, `permutations`, `fibonacci`) honour the 10,000-digit limit like `Decimal` and `Rational`.
- `ratio('4 1/2')` parses mixed numbers.
- `Decimal`, `Rational`, `NumberValue` and `Money` print as `Decimal(1.5)` etc. in Node, Bun and Deno consoles.

Changed:

- One options type: `ScaleOptions` (`{ scale, rounding }`) everywhere, including decimal-math. `DecimalMathOptions` and `PrecisionOptions` are gone.
- Distributions: `quantile(p)` is the one name; the `inv(p)` alias is gone.
- `SpreadOptions` is gone; use `VarianceOptions`.
- `assertFinite` is no longer exported from `@arki/math/number`.

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
