Back to the [README](../../README.md#documentation).

# @arki/math/distributions

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
