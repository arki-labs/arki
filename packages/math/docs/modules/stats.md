Back to the [README](../../README.md#documentation).

# @arki/math/stats

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
`standardError` is `stddev / √n`, from the data (sample `stddev` unless you
pass `ddof`) or from a known `{ stddev, n }`.

```ts
import { confidenceInterval, polynomialRegression, sampleSize, standardError, zScore } from '@arki/math/stats';

confidenceInterval([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); // { mean: 5.5, lower: 3.33…, upper: 7.67…, … }  R t.test
sampleSize({ marginOfError: 0.03 }); // 1068   a ±3% poll at 95%
zScore(130, 100, 15); // 2
standardError({ stddev: 15, n: 25 }); // 3
polynomialRegression([0, 1, 2, 3], [1, 2, 5, 10], 2).coefficients; // [1, 0, 1]  lowest degree first
```

Every fit (`linearRegression`, `exponentialRegression`, `logarithmicRegression`,
`powerRegression`, `polynomialRegression`) returns its coefficients, `r2` and
`predict(x)`. `r2` is measured on the original y values, also for the fits that
are solved on `ln y`.
