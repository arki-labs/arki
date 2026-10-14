# Error analysis: `ERROR_BOUND = 2n` in `src/decimal-math.ts`

`decimal-math` promises correct rounding: the digits returned are the true value
rounded once at `scale`. For roots the proof is direct (exact integer roots). For
`exp`, `ln`, `log`, `pow`, `PI` and `E` it rests on one claim, written as
`ERROR_BOUND = 2n`:

> every fixed-point approximation `A = approximateAt(p)` satisfies
> `|v · 10^p − A| < 2`, where `v` is the true value.

This file checks that claim kernel by kernel. **Verdict: it holds, with margin.**
Every kernel is within `1 + 10⁻⁵` units of its last digit, so no fix was needed.

Notation: a "unit" is `10⁻ᵖ` at the precision `p` being asked for. "Truncation"
is bigint division, which rounds toward zero and so errs by less than 1 unit.

## Why the bound is enough (Ziv's loop, `roundApproximation`)

The true value lies in the open interval `(A − 2, A + 2) · 10⁻ᵖ`. Every rounding
mode is a monotone function of its argument. So if both ends of that interval
round to the same result, the true value rounds to that result too. When they
differ, the true value is within 2 units of a rounding boundary. The loop then
doubles the guard digits (10, 20, 40 … 2560) and tries again.

- `exp(x)` for rational `x ≠ 0` and `ln(x)` for rational `x ≠ 1` are
  transcendental (Lindemann–Weierstrass). A rounding boundary is a rational
  number, so the true value never sits on one, and the loop always finishes.
- `log_b(x)` is either rational or transcendental (Gelfond–Schneider). The
  rational case is caught: when the ends disagree, the nearest decimal with
  `scale + 1` digits is checked exactly with `x^q = b^p`.
- `pow(x, y)` with non-integer `y = p/q` is rational only when `x` is a perfect
  `q`-th power. That needs `q ≤` the bit size of `x`, and `pow` checks it with an
  exact root before it approximates anything.
- If the value is within about `10^-(scale + 2550)` of a boundary, the loop stops
  with `ResourceLimitError`. It never returns a wrong digit.

## Kernel by kernel

### Constants `π`, `e`, `ln 2`, `ln 10` (`cachedConstant`)

Each constant is computed at `d + g` digits, where `g = 10 + len(d)`.

- The series sum `N ≈ d/1.4` terms or fewer. Each term adds at most 2 units of
  truncation error.
- The worst multiplier in the formulas is 18 (in `ln 2`).
- So the error at `d + g` digits is at most `36N + 8 < 10^g`.
- Dividing by `10^g` gives a value within `1 + 10⁻⁹` units at `d` digits.
- Serving a smaller precision truncates once more: at most `0.1 + 1` units.

**Bound: below 1.2 units.**

### `lnFixed(x, p)`

`ln x = 2·atanh((r − 1)/(r + 1)) + j·ln 2 + k·ln 10`, with `r ∈ [0.75, 1.5)`.
It works at `q = p + e` digits, where `e = 10 + len(|k| + 1) + len(p)`.

The errors at `q` digits:

| step                      | error at `q` digits (units)                          |
| ------------------------- | ---------------------------------------------------- |
| mantissa `m` truncated    | ≤ 1 (relative `10⁻q`, so `≤ 1` in `ln`)              |
| `r = m >> j`              | ≤ 1 / 0.75 = 1.34                                    |
| `z = (r − 1)/(r + 1)`     | ≤ 1 × d(2 atanh z)/dz ≤ 2.1                          |
| series, `N ≤ 0.72q` terms | ≤ 2 × 2.1N (each term: product and `/k` truncations) |
| `j·ln 2` (`j ≤ 3`)        | ≤ 3 × 1.2                                            |
| `k·ln 10`                 | ≤ 1.2·\|k\|                                          |

The total is under `3.1q + 1.2|k| + 10`. That is less than `10^-9 · 10^e`,
because `10^e ≥ 10^10 · p · (|k| + 1)`. Dividing by `10^e` and truncating gives
`< 1 + 10⁻⁹`.

**Bound: below `1 + 10⁻⁹` units.**

### `logFixed(x, b, p)` = `ln x / ln b`

Both logarithms are computed at `q = p + dₓ + 2·d_b + 3` digits:

- `|ln x| ≤ 10^dₓ` (`lnMagnitudeDigits`);
- `|ln b| ≥ 10^-d_b` (`lnSmallnessDigits`, using `|ln(1 + t)| ≥ |t|/1.1` for
  `|t| < 0.1`).

Write `a = ln x · 10^q` and `c = ln b · 10^q`. Each has an error under 1.01.
The quotient's error is then:

```
10^p · (1.01/|c| + |a|·1.01/c²) ≤ 1.01 · 10^(p − q + d_b) · (1 + 10^(dₓ + d_b))
                                 = 1.01 · (10^-(dₓ + d_b + 3) + 10^-3) ≤ 0.0021
```

The final truncation adds less than 1.

**Bound: below 1.003 units.** The comment's "1.01" is conservative.

### `expFixed(v, p)`

`e^v = (e^(v/2^h))^(2^h)`, with `h = bits(v) + max(4, ⌈1.8√p⌉)`. So `y = v/2^h < 1/16`.
It works at `q = p + i + g` digits:

- `i = ⌈v·log₁₀e⌉ + 1` integer digits (0 when `v < 0`);
- `g = 8 + ⌈0.302h⌉ + len(p)`.

The steps:

- **Taylor sum.** `y` is truncated (1 unit). Each of the `N ≤ q/1.2` terms is
  truncated (1 unit), and the earlier errors shrink by `y < 1/16`. So
  `S₀ = e^y(1 + δ₀)` with `|δ₀| ≤ (N + 2)·10⁻q`.
- **Squaring `h` times.** Each squaring doubles the relative error and adds one
  truncation (at most `10⁻q` relative, since `Sᵢ ≥ 1`). So
  `|δ| ≤ 2^h (N + 3)·10⁻q`.
- **`v ≥ 0`.** The result is `S / 10^(i+g)`. The error is
  `e^v·2^h(N + 3) / 10^(i+g) + 1`. Since `e^v < 10^(i−1)` and
  `2^h < 10^(0.302h)`, this is `< (N + 3)·10^-(9 + len(p)) + 1`.
  `N` is at most `q`, about `3·10^4` at the package limits, so this is `< 1 + 10⁻⁵`.
- **`v < 0`.** The result is `10^(q+p) / S`, where `S ≈ e^|v|·10^q` and `q = p + g`.
  The error is `e^-|v|·10^p·1.01|δ| + 1 < 1 + 10⁻⁸`.

**Bound: below `1 + 10⁻⁵` units.**

### `pow(x, y)` = `exp(y · ln x)`

Write `t = y·ln x`. It is computed at `p' = p + i + 10` digits, where `i` covers
the result's integer digits, from `ln x` at `p' + d_y` digits (`|y| < 10^(d_y − 1)`).

- `t` is off by at most `|y|·(1 + 10⁻⁹)·10^-(p'+d_y) + 10^-p' < 1.1·10^-p'`.
- An error `ε` in `t` is a relative error `ε` in `x^y`.
- So the result is off by `x^y·10^p·1.1·10^-p' = 1.1·10^-10 · x^y/10^i ≤ 1.1·10⁻¹⁰` units.
- `expFixed` then adds its own `1 + 10⁻⁵`.

**Bound: below `1 + 10⁻⁵` units.**

### Roots: `sqrt`, `cbrt`, `nthRoot`

These do not use the bound. `⌊R^(1/n)⌋` is exact on bigints (Newton from above,
then checked `x^n ≤ R < (x+1)^n`). The work is at least one digit past `scale`,
and one "sticky" digit records whether anything was cut off. That is exactly
what every rounding mode needs.

## Measured

The internal kernels were run on random inputs at precisions 10–3000, 1 500
values in all, and compared with mpmath at `p + 120 + result digits`. The
largest error found, `|A − v·10^p|`:

| kernel     | max error (units) |
| ---------- | ----------------- |
| `lnFixed`  | 0.9971            |
| `logFixed` | 0.9994            |
| `expFixed` | 0.9922            |
| `π`        | 0.8979            |
| `e`        | 0.9377            |
| `ln 2`     | 0.7232            |
| `ln 10`    | 0.9405            |

How it was done: the kernels were exported from a scratch copy of the file,
because they are not public. This was a one-off check and is not part of the test suite.

The public functions are then checked end to end. `decimal-math.reference.test.ts`
runs 1 163 mpmath cases in all 8 rounding modes. Among them are 160 transcendental
cases within `10^-(scale + 14)` of a boundary, down to `10^-(scale + 90)`. Those
cases force the loop through 20, 40, 80 and 160 guard digits. Every one matches
exactly.
