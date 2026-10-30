# @arki/money agent guide

Read `llms.txt` first for the map. When this guide and `AGENTS.md` disagree, `AGENTS.md` wins.

## The model

1. `Money` has three fields: `units`, `scale` and an interned `currency`. `units` is a `number` while safe, a `bigint` beyond 2^53.
2. Methods are math verbs on the class (`plus`, `times`, `allocate`). Aggregates are functions (`sum`, `average`, `min`, `max`).
3. Nothing rounds unless you pass a rounding mode.
4. The ISO 4217 table ships with the package. Decimals do not depend on the device.
5. Parsing, formatting, conversion, providers, Zod and Drizzle are separate subpaths. You pay in bytes only for what you import.

## Task map

### Do arithmetic without losing a cent

1. Build amounts from strings: `money('19.99', 'EUR')`.
2. Use `plus`, `minus`, `sum`, `allocate` and `split`. They are always exact.
3. Pass a rounding mode to `times`, `dividedBy`, `percentage`, `toScale` and `roundToStep`.

```ts
import { money } from '@arki/money';

const net = money('19.99', 'EUR');
const gross = net.times('1.19', 'halfEven'); // 23.79 EUR
const parts = gross.allocate([1, 1, 1]); // adds back to 23.79
```

### Read and show money

1. Read user text with `parseMoney(text, currency, { locale })` from `@arki/money/parse`. You choose the currency; it is never guessed. It returns the `Money` or a failure: check `isMoneyFailure(result)` and show `result.remediation`.
2. Show it with `formatMoney` from `@arki/money/format`.

### Convert currencies

1. Build rates with `ratesFrom({ base, rates })` from `@arki/money/exchange`.
2. Make a converter with `createConverter(rates, { inverse?, via? })`.
3. Call `convert(money, 'GBP', { rounding })`. It rounds once.

### Charge through Stripe

1. Call `toStripe(money)` for `{ amount, currency }` from `@arki/money/stripe`.
2. Call `fromStripeAmount(amount, currency)` to read a Stripe amount back. It returns `UnknownCurrency` or `ProviderAmount` instead of throwing.

### Store money

1. Pick a column: `moneyMinor` (bigint cents), `moneyDecimal` (numeric) or `moneyJson` (any currency), from `@arki/money/drizzle/pg`, `/mysql` or `/sqlite`.
2. Validate input with `moneySchema('EUR')` from `@arki/money/zod`.

## Rules that bite

- `money(0.1 + 0.2, 'EUR')` throws. A number is read as written. Use strings.
- `price.times('1.19')` throws `RoundingNecessaryError`. Pass a mode.
- `Currency.of('ZZZ')` throws `UnknownCurrencyError`. For a code from outside use `Currency.parse(code)`, which returns `UnknownCurrency`.
- Parsers return, builders throw. `Money.parse`, `Money.fromJSON`, `parseMoney`, `fromStripeAmount` and `fromProviderUnits` return a failure; never pass outside text to `money()` or `Money.of`.
- Two values read from data can hold different currencies: `a.plus(b)` then throws `CurrencyMismatchError`. Compare `a.currency.code` first.
- Do not mutate a `Money`. It is not frozen.
- Convert in one step. Converting in two rounded steps drifts by a cent.
- On Hermes for Apple platforms, `parseMoney` with a `locale` throws. Pass `symbols`.

## Errors

| Code              | Error                   | What to do                                                |
| ----------------- | ----------------------- | --------------------------------------------------------- |
| `ARKI_MONEY_E001` | `CurrencyMismatchError` | Convert both amounts to one currency first                |
| `ARKI_MONEY_E002` | `UnknownCurrencyError`  | Use an ISO 4217 code or a custom currency object          |
| `ARKI_MONEY_E003` | `ExchangeRateError`     | Pass a rate for the pair, or opt in to `inverse` or `via` |
| `ARKI_MONEY_E004` | `ProviderAmountError`   | Round to the provider's step or choose another currency   |
| `ARKI_MATH_*`     | Shared math errors      | `RoundingNecessaryError`: pass a mode. See `@arki/math`   |

Returned failures (from the `parse*` doors) are listed in `MONEY_FAILURES`, codes `money.*`; the README's "Failure behaviour" has the table.

## Verify

```sh
bun run test:docs
bun run typecheck
bun run test
```
