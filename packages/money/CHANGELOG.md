# @arki/money

## 0.0.4

Changed:

- `@arki/money/drizzle` is now `@arki/money/drizzle/pg`. No alias (pre-1.0).

Added:

- `@arki/money/drizzle/mysql` (`bigint`, `decimal`, `json`) and `@arki/money/drizzle/sqlite` (`integer`, `text`, `text`), sharing one set of conversions with Postgres. An integer a driver already rounded past 2^53 throws on read. MySQL round trip tested on MySQL 8 (`MONEY_TEST_MYSQL_URL`), SQLite on libSQL.
- Hermes V1 (React Native 0.86) leg in `test:runtimes`.

Fixed:

- Locale parsing and `MoneyBag` used `Array#toSorted`, which Hermes lacks, and crashed on React Native. Lint now forbids `toSorted`, `toReversed` and `toSpliced`.

## 0.0.3

Added:

- `@arki/money/rational` — `RationalMoney`: an exact fraction of major units that keeps its currency; mixes with `Money`; `toMoney()` rounds once.
- `@arki/money/bag` — `MoneyBag`: one exact balance per currency, zeros dropped; `convert()` converts every balance exactly and rounds the total once.
- `@arki/money/zod` — `moneySchema(currency)` (typed `Money<C>`), `anyMoneySchema()`, `moneyInputSchema()` for locale form text, `currencyCodeSchema`. Optional peer `zod` 4.
- `@arki/money/drizzle` — Postgres columns `moneyMinor` (bigint ↔ `Money<C>`), `moneyDecimal` (numeric), `moneyJson` (jsonb, any currency); text codecs, no floats; wrong currency or needed rounding throws on write. Optional peer `drizzle-orm` 1.x. Round trip tested on PGlite, including 2^62.
- `bun run size`: per-entry gzip budgets.

## 0.0.2

Added:

- `@arki/money/parse` — `parseMoney`, `createMoneyParser`: strict locale parsing from `Intl.NumberFormat#formatToParts` (separators, local digits, minus sign, the currency's own and English symbols). Wrong grouping, the other locale's decimal separator, two signs, mixed digit scripts and foreign currency symbols throw `NumberFormatError`. `symbols` option for runtimes without `formatToParts`. `tryParse` for forms.
- `@arki/money/exchange` — exact `ExchangeRate` (fraction, `inverse`, `chain`), `exchangeRate`, `ratesFrom`, `convert`, and `Converter` with opt-in `inverse` and `via` routing. Conversion rounds once; resolved rates are cached.
- `@arki/money/provider` — `toProviderUnits`, `fromProviderUnits` for any payment provider's integer units; never rounds.
- `@arki/money/stripe` — Stripe's units as documented on 2026-10-12: zero-decimal list (including MGA), ISK and UGX as two decimals in whole units, HUF and TWD whole-unit payouts. Currencies with 3 or 4 decimals throw, since Stripe documents no rule for them.
- `ExchangeRateError`, `ProviderAmountError`.

## 0.0.1

First release: `Money` on whole units (number, bigint past 2^53), shipped ISO 4217 table, exact-or-throw rounding, allocation, aggregates, JSON, `./format`, `./exact`.
