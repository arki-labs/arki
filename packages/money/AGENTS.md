AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/money: Laws

Exact money for every JavaScript runtime, on top of `@arki/math`. Read these before you change or use it.

## Laws

1. Storage is hybrid. `units` is a `number` while it is a safe integer, and a `bigint` beyond that. That is the canonical form, and `-0` never occurs. Do not add a second representation.
2. There is no default rounding. `times`, `dividedBy`, `percentage`, `toScale` and `roundToStep` throw `RoundingNecessaryError` when the result is inexact and no mode was given. Never add a global or implicit rounding mode.
3. Currency decimals come from the shipped ISO 4217 table, never from `Intl`. `Intl` is for display only, because it accepts codes like `ZZZ`.
4. Custom currencies are objects the caller passes in. There is no global currency registry.
5. `Money` is not frozen. Freezing costs more than the arithmetic. Document the rule instead.
6. A `Money<'EUR'>` cannot meet a `Money<'USD'>`. The compiler stops it, and the runtime throws `CurrencyMismatchError`.
7. A conversion rounds once, at the end. Rates are exact fractions, never floats. Inverse and cross rates are opt-in.
8. Money never turns into a float by accident. `+price` throws, and `toNumber()` is for charts only.
9. Parsers return, builders throw. A door for outside values (`Money.parse`, `Money.fromJSON`, `Currency.parse`, `Currency.parseNumeric`, `parseMoney`, `createMoneyParser` for the locale, `RationalMoney.fromJSON`, `parseRates`, `fromProviderUnits`, `fromStripeAmount`) returns a failure from `src/failures.ts`, listed once in `MONEY_FAILURES`, carrying no input text. Builders and arithmetic throw errors that extend `MathError`, with a stable `code` and a `remediation`. Match on the code, never on the message.
10. A wrong amount never passes silently. Bad stored values throw from a Drizzle column (a `fromDriver` has no failure channel), and a `bigint` product past about 10 000 digits throws `ResourceLimitError` before it is built.
11. `zod` and `drizzle-orm` are optional peers used only by their subpaths. The core imports neither.
12. Types are written once and inferred everywhere. No `any`, no `@ts-ignore`, no unsafe casts.

## Changing this package

- A new rounding rule belongs to `@arki/math`. Money reuses its mode names.
- A new money error needs a `MONEY_ERROR_CODES` entry with `@fix` and `@verify` tags, a `remediation`, and a test.
- A new returned failure is one `defineFailure` in `src/failures.ts` with `@fix` and `@verify` tags and a `remediation`, added to `MONEY_FAILURES` and to `failureToError` in `src/internal/raise.ts`, with a test.
- A change to the ISO table comes from `scripts/generate-iso4217.mjs` (SIX list-one), not by hand.
- Stripe rules are checked against docs.stripe.com. Update `STRIPE_RULES_VERSION` with the check date.
- Keep each entry point inside its `bun run size` budget.
- Never write benchmark numbers by hand. The README block comes from an idle `bun run bench` run.
- Doc examples live in `README.md` and `docs/`. Run them with `bun run test:docs`.

## Verify

```sh
bun run test:docs
bun run typecheck
bun run test
bun run lint
bun ../../tooling/library/src/llms.ts --check
```
