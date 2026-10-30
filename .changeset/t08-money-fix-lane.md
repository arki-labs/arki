---
'@arki/money': minor
---

More doors for outside values return failures instead of throwing (T08 fix lane).

Breaking: `RationalMoney.fromJSON` now returns `InvalidMoneyShape`, `UnknownCurrency`, `InvalidMoneyText` (also for a zero denominator) or `InputTooLarge`, like `Money.fromJSON`, instead of throwing `InvalidArgumentError`, `NumberFormatError` or `UnknownCurrencyError`. Check `isMoneyFailure(result)` before using it.

New door `parseRates(table)` in `@arki/money/exchange` reads a rate table from a feed and returns `UnknownCurrency`, `InvalidMoneyText`, `AmountOutOfRange`, `InputTooLarge` or the new `InvalidExchangeRate` (`money.invalid_rate`, 400) for a rate of 0 or less, or a currency to itself that is not 1. `ratesFrom` stays the throwing builder for tables in your code. `MONEY_FAILURES` gains `InvalidExchangeRate`.

`convert` and `Converter#convert` check `options.scale` first and throw `InvalidArgumentError` for a scale outside 0 to 100, instead of a raw `RangeError` from building a huge bigint. `fromProviderUnits` and `fromStripeAmount` return `InputTooLarge` for a near-limit bigint that would pass the digit cap when moved to the currency's scale, instead of throwing `ResourceLimitError`.

no docs impact: README, llms.txt, AGENTS.md and the agent guide are updated in this change. no demo impact: no demo reads rational JSON or rate feeds.
