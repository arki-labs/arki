# @arki/money

## 0.2.0

### Minor Changes

- b5cc408: Parsers return, builders throw. `Money.parse`, `Money.fromJSON`, `parseMoney`, `createMoneyParser(...).parse`, `fromProviderUnits` and `fromStripeAmount` return the value or an `@arki/failure` value instead of throwing on bad outside input. New doors `Currency.parse(code, currencies?)` and `Currency.parseNumeric(numeric)` read currency codes from outside. Failures, listed once in `MONEY_FAILURES` and carrying no input text: `InvalidMoneyText` (`money.invalid_text`, 400), `InvalidMoneyShape` (`money.invalid_shape`, 400), `UnknownCurrency` (`money.unknown_currency`, 400), `RoundingNecessary` (`money.rounding_necessary`, 400), `AmountOutOfRange` (`money.out_of_range`, 400), `InputTooLarge` (`money.input_too_large`, 413), `UnsupportedLocale` (`money.unsupported_locale`, 400) and `ProviderAmount` (`money.provider_amount`, 422). `createMoneyParser` and `parseMoney` return `UnsupportedLocale` for a locale tag `Intl` rejects.

  Breaking: `MoneyParser#tryParse` is removed; `parse` now returns failures. Builders (`money`, `Money.of`, `Money.fromMinor`, `Currency.of`, `Currency.fromNumeric`, `stripeRule`, `toProviderUnits`, `toStripeAmount`) and arithmetic still throw. A provider rule with a step below 1 or a bad scale now throws `InvalidArgumentError` (a zero step used to throw a bare `RangeError`). A `bigint` product past about 10 000 digits throws `ResourceLimitError` before it is built, instead of crashing Hermes. Drizzle columns still throw on bad stored values, so a query rejects instead of returning a wrong amount. `@arki/failure` is now a runtime dependency. See `docs/upgrades/0.1.0-to-0.2.0.md`.

- c55a254: More doors for outside values return failures instead of throwing (T08 fix lane).

  Breaking: `RationalMoney.fromJSON` now returns `InvalidMoneyShape`, `UnknownCurrency`, `InvalidMoneyText` (also for a zero denominator) or `InputTooLarge`, like `Money.fromJSON`, instead of throwing `InvalidArgumentError`, `NumberFormatError` or `UnknownCurrencyError`. Check `isMoneyFailure(result)` before using it.

  New door `parseRates(table)` in `@arki/money/exchange` reads a rate table from a feed and returns `UnknownCurrency`, `InvalidMoneyText`, `AmountOutOfRange`, `InputTooLarge` or the new `InvalidExchangeRate` (`money.invalid_rate`, 400) for a rate of 0 or less, or a currency to itself that is not 1. `ratesFrom` stays the throwing builder for tables in your code. `MONEY_FAILURES` gains `InvalidExchangeRate`.

  `convert` and `Converter#convert` check `options.scale` first and throw `InvalidArgumentError` for a scale outside 0 to 100, instead of a raw `RangeError` from building a huge bigint. `fromProviderUnits` and `fromStripeAmount` return `InputTooLarge` for a near-limit bigint that would pass the digit cap when moved to the currency's scale, instead of throwing `ResourceLimitError`.

  no docs impact: README, llms.txt, AGENTS.md and the agent guide are updated in this change. no demo impact: no demo reads rational JSON or rate feeds.

### Patch Changes

- Updated dependencies [d2faf8f]
- Updated dependencies [f9ecefb]
- Updated dependencies [e6b9330]
- Updated dependencies [a1b64e6]
  - @arki/math@0.2.0
  - @arki/failure@0.3.0

## 0.1.0

### Minor Changes

- 1668156: Money-only errors carry stable codes `ARKI_MONEY_E001` to `E004` (exported as `MONEY_ERROR_CODES`) and a `remediation`. Breaking: `UnknownCurrencyError.code` held the bad currency text; that is now `currencyCode`, and `code` is the stable error code. `MoneyError` is now abstract.

### Patch Changes

- 9bfddf3: Faster `allocate`: whole-number ratios skip decimal parsing, parts are computed with plain number arithmetic while they stay safe integers, and the largest-remainder sort is skipped when every remainder is equal (about 2× faster for `allocate([1, 1, 1])`).
- 7922fb5: Docs standard: README reordered with install, quick start, limits and failure behaviour; `AGENTS.md`, `llms.txt` and `docs/agent-guide.md` added; the four money error codes carry `@fix` and `@verify` tags; doc examples compile under `test:docs`.

  no demo impact: documentation and doc-example changes only, runtime behaviour unchanged

- @arki/math@0.1.0

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
