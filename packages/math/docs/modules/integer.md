Back to the [README](../../README.md#documentation).

# @arki/math/integer

Number theory with `number` and `bigint` overloads; the `number` form throws
`NumericRangeError` the moment a result leaves the safe range, so switch to
`bigint` for big values. `isPrime` is deterministic Miller–Rabin below
2⁶⁴; `primeFactors` adds Pollard's rho for large cofactors.

```ts
import { combinations, fibonacci, fromBase, isPrime, modPow, primeFactors, toBase } from '@arki/math/integer';

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
