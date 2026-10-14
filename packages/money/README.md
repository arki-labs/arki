# @arki/money

Exact, fast money for every JavaScript runtime.

- **Exact.** Amounts are whole numbers of units: `19.99 EUR` is `1999` units at 2 decimals. Nothing rounds unless you pass a rounding mode.
- **Fast.** Units are a plain `number` up to 2^53 and a `bigint` only beyond that. Adding two amounts takes about 4 ns, against 350–550 ns in currency.js and dinero.js.
- **Safe types.** `Money<'EUR'>` cannot be added to `Money<'USD'>`. The compiler stops it, and the runtime throws `CurrencyMismatchError` too.
- **Same answer everywhere.** The ISO 4217 table ships with the package (178 currencies, published 2026-09-17). `Intl` is only used for display, so a value has the same decimals on every device.
- **Runs everywhere.** Pure ESM with web-standard globals only. Tested on Node, Bun, Deno and Chromium; built for React Native (Hermes).

```ts
import { factor, money, sum } from '@arki/money';

const price = money('19.99', 'EUR');
const total = sum([price, money('5.01', 'EUR')]); // 25.00 EUR
price.times(3); // 59.97 EUR
price.times('1.19'); // throws RoundingNecessaryError: 23.7881 does not fit
price.times('1.19', 'halfEven'); // 23.79 EUR
money(100, 'EUR').allocate([1, 1, 1]); // [33.34, 33.33, 33.33] — adds back to 100.00
money(1, 'EUR').plus(money(1, 'USD')); // compile error, and CurrencyMismatchError at run time
```

## Creating money

| Call                                                | Result                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `money('19.99', 'EUR')`                             | From major units. Strings are the safest input.                                       |
| `money(19.99, 'EUR')`                               | A number is read as written. `0.1 + 0.2` arrives as `0.30000000000000004` and throws. |
| `money('1.005', 'EUR', { rounding: 'halfEven' })`   | Extra digits need a rounding mode.                                                    |
| `money('0.1234', 'EUR', { scale: 4 })`              | Keep more decimals, for unit prices.                                                  |
| `Money.fromMinor(1999, 'EUR')`                      | From cents. Also takes a `bigint` or an integer string, as databases return `BIGINT`. |
| `Money.zero('EUR')`                                 | Zero.                                                                                 |
| `Money.parse('19.99 EUR')` / `Money.fromJSON(json)` | Reads what `toString()` / `toJSON()` write.                                           |
| `Money.of(m, 'EUR')`                                | Checks a `Money<string>` is EUR and narrows its type to `Money<'EUR'>`.               |

`money()` also accepts a `Decimal` or a `Rational` from `@arki/math`.

## Rounding

Rounding modes: `up`, `down`, `ceiling`, `floor`, `halfUp`, `halfDown`, `halfEven`, `unnecessary`.

There is no default mode. `times`, `dividedBy`, `percentage`, `toScale` and `roundToStep` return the exact result when it fits, and throw `RoundingNecessaryError` when it does not and no mode was given. `plus`, `minus`, `allocate`, `split` and `sum` are always exact.

Cash rounding is a step, because it is set by each country's law, not by the currency:

```ts
money('1.025', 'CHF', { scale: 3 }).roundToStep('0.05', 'halfUp'); // 1.050 CHF
```

For a calculation with several steps, round once at the end through `@arki/math`:

```ts
import { ratio } from '@arki/math/rational';
import { toRational } from '@arki/money/exact';

const share = toRational(price).times(ratio(1, 3)).plus(ratio(1, 7));
money(share, 'EUR', { rounding: 'halfEven' });
```

## Splitting

`allocate(ratios, { remainder })` and `split(parts, { remainder })` always add back to the whole. Leftover units go to the parts whose exact share lost the most (`'largest'`, the default), or from the start (`'first'`) or end (`'last'`). A zero ratio never receives a unit. Ratios may be decimals: `allocate(['0.5', '0.25', '0.25'])`.

## Currencies

```ts
import { Currency } from '@arki/money';

Currency.of('EUR'); // { code: 'EUR', numeric: '978', scale: 2, iso: true }
Currency.fromNumeric('978'); // EUR
Currency.of('ZZZ'); // throws UnknownCurrencyError (Intl would accept it)
const btc = Currency.custom({ code: 'BTC', scale: 8 });
money('0.00012', btc); // 0.00012000 BTC
```

Custom currencies are not registered globally. Keep the object and pass it where you would pass a code. Codes that ISO defines without decimals (gold `XAU`, test code `XTS`) use 0.

## Output

| Call                                                     | Result                                                  |
| -------------------------------------------------------- | ------------------------------------------------------- |
| `toString()`                                             | `'19.99 EUR'`, locale-free                              |
| `toJSON()`                                               | `{ amount: '19.99', currency: 'EUR' }`                  |
| `toDecimalString()`                                      | `'19.99'`, for `NUMERIC` columns                        |
| `toMinorUnits()` / `toMinorBigInt()` / `toMinorNumber()` | `1999`, for `BIGINT` columns and payment APIs           |
| `toNumber()`                                             | Nearest float, for charts only                          |
| `+price`                                                 | Throws. A `Money` never turns into a float by accident. |

```ts
import { createMoneyFormatter, formatMoney } from '@arki/money/format';

formatMoney(money('1234.5', 'EUR'), { locale: 'de-DE' }); // '1.234,50 €'
formatMoney(money(-5, 'USD'), { accounting: true }); // '($5.00)'
const de = createMoneyFormatter({ locale: 'de-DE' }); // binds options once, for loops
```

Formatting passes the amount to `Intl` as exact text, so digits past 2^53 survive. If the runtime lacks a feature you asked for (Hermes on iOS lacks some), it throws `UnsupportedFeatureError` instead of printing something else.

## Reading what people type

```ts
import { createMoneyParser, parseMoney } from '@arki/money/parse';

parseMoney('1.234,56 €', 'EUR', { locale: 'de-DE' }); // 1234.56 EUR
parseMoney('₹1,23,456.78', 'INR', { locale: 'en-IN' }); // 123456.78 INR
parseMoney('($1,234.56)', 'USD'); // -1234.56 USD
parseMoney('$10', 'CAD'); // 10.00 CAD — you say which currency, so '$' is never guessed
parseMoney('1,23,4', 'USD'); // throws NumberFormatError: grouping does not match the locale

const form = createMoneyParser('EUR', { locale: 'de-DE' }); // reads the locale once
form.tryParse('12,505 €'); // undefined — too many decimals, for form validation
```

Separators, digits, minus sign and currency symbols come from `Intl` for the locale. Parsing is strict: wrong grouping, the other locale's decimal separator, two signs, mixed digit scripts or a different currency's symbol throw instead of being guessed. Text without grouping (`'1234.5'`) is always accepted. On runtimes without `formatToParts` (Hermes on iOS), pass `symbols: { decimal: ',', group: '.' }` instead of a locale.

## Converting currencies

```ts
import { convert, createConverter, exchangeRate, ratesFrom } from '@arki/money/exchange';

const rates = ratesFrom({ base: 'EUR', rates: { USD: '1.0832', GBP: '0.8571' } });
const fx = createConverter(rates, { inverse: true, via: 'EUR' });
fx.convert(money('1234.56', 'USD'), 'GBP', { rounding: 'halfEven' }); // 976.87 GBP, USD → EUR → GBP rounded once
fx.rate('USD', 'GBP').toString(); // 'USD/GBP 8571/10832'

convert(money(100, 'EUR'), exchangeRate('EUR', 'USD', '1.0832')); // 108.32 USD
```

Rates are exact fractions, never floats, so inverse and cross rates add no error. A conversion rounds once, at the end; converting in two rounded steps above would give 976.86. Reversed rates (`inverse`) and routing through a base currency (`via`) are opt-in, because a bid rate reversed is not an ask rate. There is no network code: fetch rates from wherever you trust and pass them in.

## Payment providers

```ts
import { fromStripeAmount, toStripe, toStripeAmount } from '@arki/money/stripe';

toStripe(money('10.99', 'EUR')); // { amount: 1099, currency: 'eur' }
toStripeAmount(money(5, 'ISK')); // 500 — Stripe sends ISK with two decimals that are always 00
toStripeAmount(money('10.50', 'MGA')); // throws ProviderAmountError — MGA is zero-decimal at Stripe
toStripeAmount(money('10.45', 'HUF'), 'payout'); // throws — HUF payouts must be whole forints
fromStripeAmount(1099, 'usd'); // 10.99 USD
```

Rules come from docs.stripe.com/currencies, checked on 2026-10-12 (`STRIPE_RULES_VERSION`). Stripe documents no rule for currencies with 3 or 4 decimals, so those throw instead of being guessed. For other providers, describe their units with `toProviderUnits(money, { scale, step })` and `fromProviderUnits` from `@arki/money/provider`.

## Exact steps and several currencies

```ts
import { MoneyBag } from '@arki/money/bag';
import { RationalMoney } from '@arki/money/rational';

const third = RationalMoney.of(100, 'EUR').dividedBy(3); // '100/3 EUR', no rounding yet
third.plus(third).plus(third).toMoney(); // 100.00 EUR — three rounded thirds would give 99.99
third.times('1.19').toMoney({ rounding: 'halfEven' }); // 39.67 EUR, rounded once

const wallet = MoneyBag.of(money('1.07', 'USD'), money('1.06', 'GBP')); // two balances, never one fake total
wallet.convert(fx, 'EUR', { rounding: 'halfEven' }); // 2.22 EUR; rounding each balance first gives 2.23
```

A `RationalMoney` is an exact fraction of major units that keeps its currency, so EUR and USD still cannot mix halfway through a calculation. A `MoneyBag` holds one exact balance per currency and drops zeros.

## Validation and databases

```ts
import { anyMoneySchema, moneyInputSchema, moneySchema } from '@arki/money/zod';

const order = z.object({ total: moneySchema('EUR', { min: money(0, 'EUR') }) });
order.parse({ total: { amount: '19.99', currency: 'EUR' } }).total; // Money<'EUR'>
moneyInputSchema('EUR', { locale: 'de-DE' }).parse('1.234,56 €'); // form field
```

```ts
import { moneyDecimal, moneyJson, moneyMinor } from '@arki/money/drizzle/pg'; // or /drizzle/mysql, /drizzle/sqlite

const prices = pgTable('prices', {
  total: moneyMinor('total', { currency: 'EUR' }), // bigint of cents ↔ Money<'EUR'>
  unit: moneyDecimal('unit', { currency: 'EUR', scale: 4 }), // numeric(19, 4)
  price: moneyJson('price'), // jsonb { amount, currency } ↔ Money in any currency
});
```

| Column         | Postgres        | MySQL / MariaDB | SQLite                               |
| -------------- | --------------- | --------------- | ------------------------------------ |
| `moneyMinor`   | `bigint`        | `bigint`        | `integer`                            |
| `moneyDecimal` | `numeric(p, s)` | `decimal(p, s)` | `text` (SQLite has no exact decimal) |
| `moneyJson`    | `jsonb`         | `json`          | `text`                               |

SQLite drivers usually return numbers, which are exact up to 2^53 minor units. A bigger stored amount throws on read instead of turning into a wrong value; switch the driver to big integers to read it (libSQL `intMode: 'bigint'`, better-sqlite3 `safeIntegers()`).

The schemas take the JSON shape as input, so tRPC and oRPC clients infer what to send. The columns read text from every driver, so no value passes through a float, and writing another currency or a value that needs rounding throws. `zod` (4.x) and `drizzle-orm` (1.x) are optional peer dependencies, used only by their subpaths.

## Errors

Every deliberate failure extends `MathError` from `@arki/math`, so one `instanceof` catches both libraries. Money-only errors extend `MoneyError`: `CurrencyMismatchError`, `UnknownCurrencyError`, `ExchangeRateError`, `ProviderAmountError`. Each has a stable `code` and a `remediation`; match on the code, never on the message. The money-only codes are `ARKI_MONEY_E001` (`CurrencyMismatchError`), `E002` (`UnknownCurrencyError`; the bad text is `currencyCode`), `E003` (`ExchangeRateError`) and `E004` (`ProviderAmountError`), also exported as `MONEY_ERROR_CODES`. Shared ones keep their `ARKI_MATH_*` codes: `RoundingNecessaryError`, `DivisionByZeroError`, `InvalidArgumentError`, `NumberFormatError`, `NumericRangeError`, `ResourceLimitError`, `EmptyDataError`, `UnsupportedFeatureError`.

## Entry points

| Import                                        | Contents                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| `@arki/money`                                 | `Money`, `money`, `Currency`, `factor`, `sum`, `average`, `min`, `max`, errors |
| `@arki/money/currency`                        | `Currency` alone                                                               |
| `@arki/money/format`                          | `formatMoney`, `formatMoneyToParts`, `createMoneyFormatter`                    |
| `@arki/money/exact`                           | `toDecimal`, `toRational` bridges to `@arki/math`                              |
| `@arki/money/errors`                          | Error classes                                                                  |
| `@arki/money/parse`                           | `parseMoney`, `createMoneyParser`                                              |
| `@arki/money/exchange`                        | `exchangeRate`, `ratesFrom`, `convert`, `createConverter`, `Converter`         |
| `@arki/money/provider`                        | `toProviderUnits`, `fromProviderUnits`                                         |
| `@arki/money/rational`                        | `RationalMoney`, `isRationalMoney`                                             |
| `@arki/money/bag`                             | `MoneyBag`                                                                     |
| `@arki/money/zod`                             | `moneySchema`, `anyMoneySchema`, `moneyInputSchema`, `currencyCodeSchema`      |
| `@arki/money/drizzle/pg`, `/mysql`, `/sqlite` | `moneyMinor`, `moneyDecimal`, `moneyJson`                                      |
| `@arki/money/stripe`                          | `toStripe`, `toStripeAmount`, `fromStripeAmount`, `stripeRule`                 |

## Performance

`bun run bench` compares against dinero.js v1, currency.js, big.js and the old `@arki/math/money`. Node 22, Apple Silicon, ns/op:

| Operation                                   | @arki/money | dinero.js v1 | currency.js | big.js |
| ------------------------------------------- | ----------: | -----------: | ----------: | -----: |
| add                                         |         3.5 |          457 |         470 |     67 |
| × 1.0825, round half-even (prepared factor) |          37 |          680 |         347 |    267 |
| allocate into 3                             |         172 |         1244 |        1045 |      — |
| compare                                     |         5.7 |         11.8 |           — |   13.6 |
| format en-US                                |         557 |        20725 |         674 |      — |

Amounts past 2^53 switch to `bigint` and stay exact; adding them costs about 29 ns. Converting with a cached rate takes about 170 ns, parsing German input about 1.1 µs, and `toStripeAmount` about 80 ns.

## Size

`bun run size` bundles each entry point as an app would (minified, gzipped, `@arki/math` included) and fails past its budget. The core (`Money`, `Currency` with the full ISO table, errors) is 6.3 KB. Parsing adds 0.9 KB, conversion 0.6 KB, Stripe 0.1 KB, and `RationalMoney` 3.2 KB (the exact `Rational` type from `@arki/math`).

## Runtime support

Node 20+, Bun, Deno, modern browsers and React Native on Hermes V1 (React Native 0.86). `bun run test:runtimes` runs the same checks on all five; the Hermes leg needs a `hermes` binary (`HERMES_BIN`) and prints `INCOMPLETE` when it is missing.

On Hermes for Apple platforms, `Intl.NumberFormat` has no `formatToParts` and formats number strings through a float. So `parseMoney` with a `locale` throws `UnsupportedFeatureError` (pass `symbols` instead), `formatMoneyToParts` throws, and `formatMoney` is exact up to 15 significant digits and throws beyond. Arithmetic, allocation, conversion, Stripe units and JSON work everywhere.

<!-- bench:start -->
## Benchmarks

Speed of `@arki/money` against dinero.js v1 and currency.js, the two money libraries most projects use, with big.js as a plain decimal baseline.

Node v22.13.1 on Apple M2 Max, 2026-10-13. Median time per operation, lower is better.

### add

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/money | 11.4 ns | fastest |
| @arki/money (bigint, > 2^53) | 163.5 ns | 14.37× |
| dinero.js v1 | 2.89 µs | 254.24× |
| currency.js | 1.79 µs | 157.39× |
| big.js | 753.7 ns | 66.22× |

### multiply by 1.0825 and round half-even

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/money (prepared factor) | 98.2 ns | fastest |
| @arki/money (string factor) | 469.4 ns | 4.78× |
| dinero.js v1 | 6.10 µs | 62.18× |
| currency.js (half-up only) | 2.19 µs | 22.34× |
| big.js | 943.6 ns | 9.61× |

### allocate 100 into [1, 1, 1]

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/money | 869.6 ns | 4.25× |
| @arki/money split(3) | 204.6 ns | fastest |
| dinero.js v1 | 11.14 µs | 54.45× |
| currency.js distribute(3) | 6.41 µs | 31.31× |

### compare

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/money | 33.7 ns | fastest |
| dinero.js v1 (lessThan) | 46.2 ns | 1.37× |
| big.js | 220.4 ns | 6.54× |

### construct from a string

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/money | 367.3 ns | 4.18× |
| @arki/money fromMinor | 87.9 ns | fastest |
| dinero.js v1 (minor units only) | 1.74 µs | 19.84× |
| currency.js | 2.37 µs | 27.01× |

### sum of 1000

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/money sum() | 8.71 µs | fastest |
| @arki/money reduce(plus) | 34.65 µs | 3.98× |

### convert and round once

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/money direct EUR→USD | 1.23 µs | fastest |
| @arki/money cross USD→GBP via EUR | 2.08 µs | 1.70× |

### parse and payment units

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/money parse de-DE (bound parser) | 10.86 µs | 20.04× |
| @arki/money toStripeAmount | 542.0 ns | fastest |

### format en-US

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/money | 1.44 µs | fastest |
| dinero.js v1 | 37.99 µs | 26.43× |
| currency.js | 1.54 µs | 1.07× |

Read the rows with the contracts in mind:

- Contracts differ, so read rows with care.
- currency.js stores a float and rounds every result to 2 decimals.
- dinero.js v1 stores safe-integer cents and rounds multiplication by default.
- big.js is a decimal, not money: it has no currency and no allocation.
- `@arki/money` keeps a currency on every value, refuses to mix currencies, and uses bigint minor units, so amounts beyond 2^53 stay exact.

Reproduce with `bun run bench` in the package directory; regenerate this section with `bun run bench --write-readme`.
<!-- bench:end -->

## License

MIT
