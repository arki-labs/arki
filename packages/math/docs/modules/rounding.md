Back to the [README](../../README.md#documentation).

# @arki/math/rounding

One vocabulary everywhere — `Decimal`, `Rational`, the float helpers, and
formatting all take the same `RoundingMode`:

| Mode          | Meaning                                           | 2.5 → | −2.5 → |
| ------------- | ------------------------------------------------- | ----- | ------ |
| `up`          | away from zero                                    | 3     | −3     |
| `down`        | toward zero                                       | 2     | −2     |
| `ceiling`     | toward +∞                                         | 3     | −2     |
| `floor`       | toward −∞                                         | 2     | −3     |
| `halfUp`      | nearest, ties away from zero (school rounding)    | 3     | −3     |
| `halfDown`    | nearest, ties toward zero                         | 2     | −2     |
| `halfEven`    | nearest, ties to even (banker's rounding)         | 2     | −2     |
| `unnecessary` | throw `RoundingNecessaryError` if digits are lost | —     | —      |

Defaults follow intent: **display-shaped calls** (`round`, `roundTo`,
`Decimal.round`, `toFixed`, formatting) default to `halfUp`, which is what
people expect to see. **Precision-shaped calls** (`dividedBy`, `toScale`,
`toDecimal`) default to `unnecessary`, so precision is never lost without
you asking.

Note that JavaScript's own `Math.round(-2.5)` is `-2` (ties toward +∞) —
none of the modes above, and one of the reasons this package exists.
