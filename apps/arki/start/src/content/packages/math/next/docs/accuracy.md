Back to the [README](../README.md#documentation).

# Accuracy

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
