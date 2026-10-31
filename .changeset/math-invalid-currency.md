---
'@arki/math': minor
---

Breaking: `formatCurrency`, the formatter's `formatCurrency`, `num().formatCurrency` and `formatCompact` with `currency` return `string | InvalidCurrencyFailure` (`math.invalid_currency`) for a currency code that is not three ASCII letters, instead of throwing the `RangeError` from `Intl`. Check with `InvalidCurrency.is(result)`. `formatCompact` without `currency` still returns `string`. Docs updated in the format module page, the agent guide and the README failure table. Demo impact: none.
