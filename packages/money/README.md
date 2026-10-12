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

## Errors

Every deliberate failure extends `MathError` from `@arki/math`, so one `instanceof` catches both libraries. Money-only errors extend `MoneyError`: `CurrencyMismatchError`, `UnknownCurrencyError`. Shared ones: `RoundingNecessaryError`, `DivisionByZeroError`, `InvalidArgumentError`, `NumberFormatError`, `NumericRangeError`, `ResourceLimitError`, `EmptyDataError`, `UnsupportedFeatureError`.

## Entry points

| Import                 | Contents                                                                       |
| ---------------------- | ------------------------------------------------------------------------------ |
| `@arki/money`          | `Money`, `money`, `Currency`, `factor`, `sum`, `average`, `min`, `max`, errors |
| `@arki/money/currency` | `Currency` alone                                                               |
| `@arki/money/format`   | `formatMoney`, `formatMoneyToParts`, `createMoneyFormatter`                    |
| `@arki/money/exact`    | `toDecimal`, `toRational` bridges to `@arki/math`                              |
| `@arki/money/errors`   | Error classes                                                                  |

## Performance

`bun run bench` compares against dinero.js v1, currency.js, big.js and the old `@arki/math/money`. Node 22, Apple Silicon, ns/op:

| Operation                                   | @arki/money | dinero.js v1 | currency.js | big.js |
| ------------------------------------------- | ----------: | -----------: | ----------: | -----: |
| add                                         |         3.5 |          457 |         470 |     67 |
| × 1.0825, round half-even (prepared factor) |          37 |          680 |         347 |    267 |
| allocate into 3                             |         172 |         1244 |        1045 |      — |
| compare                                     |         5.7 |         11.8 |           — |   13.6 |
| format en-US                                |         557 |        20725 |         674 |      — |

Amounts past 2^53 switch to `bigint` and stay exact; adding them costs about 29 ns.

## Runtime support

Node 20+, Bun, Deno, modern browsers and React Native (Hermes with `BigInt`). `bun run test:runtimes` builds the package and runs the same checks under Node, Bun, Deno and headless Chromium.

## License

MIT
