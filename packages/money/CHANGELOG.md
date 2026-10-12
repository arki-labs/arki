# @arki/money

## 0.0.2

Added:

- `@arki/money/parse` — `parseMoney`, `createMoneyParser`: strict locale parsing from `Intl.NumberFormat#formatToParts` (separators, local digits, minus sign, the currency's own and English symbols). Wrong grouping, the other locale's decimal separator, two signs, mixed digit scripts and foreign currency symbols throw `NumberFormatError`. `symbols` option for runtimes without `formatToParts`. `tryParse` for forms.
- `@arki/money/exchange` — exact `ExchangeRate` (fraction, `inverse`, `chain`), `exchangeRate`, `ratesFrom`, `convert`, and `Converter` with opt-in `inverse` and `via` routing. Conversion rounds once; resolved rates are cached.
- `@arki/money/provider` — `toProviderUnits`, `fromProviderUnits` for any payment provider's integer units; never rounds.
- `@arki/money/stripe` — Stripe's units as documented on 2026-10-12: zero-decimal list (including MGA), ISK and UGX as two decimals in whole units, HUF and TWD whole-unit payouts. Currencies with 3 or 4 decimals throw, since Stripe documents no rule for them.
- `ExchangeRateError`, `ProviderAmountError`.

## 0.0.1

First release: `Money` on whole units (number, bigint past 2^53), shipped ISO 4217 table, exact-or-throw rounding, allocation, aggregates, JSON, `./format`, `./exact`.
