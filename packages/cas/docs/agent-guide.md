# @arki/cas agent guide

Read `llms.txt` first for the map. When this guide and `AGENTS.md` disagree, `AGENTS.md` wins.

## The model

1. Input is a string or an `@arki/expr` AST. Output is a canonical expr AST with its printed `source`.
2. Every verb returns `{ result, conditions }` or a verb-specific shape. `conditions` lists every restriction the rewrite lost.
3. Coefficients live in ℚ[π, e]. The zero test assumes π and e are independent. That is a convention.
4. Everything ranges over the reals.
5. Every verb is bounded by budgets and by fuel.

## Task map

### Simplify an expression

1. Import `simplify` from `@arki/cas/simplify`.
2. Pass assumptions about variables when the answer depends on them: `{ assume: { x: 'nonnegative' } }`.
3. Show `conditions` next to the result.

```ts
import { simplify } from '@arki/cas/simplify';

const { result, conditions } = simplify('sqrt(x^2)', { assume: { x: 'nonnegative' } });
// result.source is 'x'; conditions holds x >= 0 (assumed)
```

### Differentiate and show the steps

1. Call `derivative(input, variable)` from `@arki/cas/derivative` for the answer.
2. Call `derivation(input, variable)` from `@arki/cas/derivation` for the steps. Translate `template.key`; render `params`.

### Expand, collect, factor or find roots

1. Import from `@arki/cas/polynomial`: `expand`, `collect`, `rationalize`, `gcd`, `factor`.
2. Call `polynomialIn(input, variable)` first when the input may not be a polynomial. It reports `kind: 'other'` with a reason instead of throwing.
3. Pass a `kind: 'polynomial'` result to `exactRoots`. Parts it cannot solve exactly come back as `numeric`.

## Rules that bite

- `expand('0.02*x')` gives rationals (`x / 50`). Pass `{ numbers: 'decimal' }` to keep decimals.
- `factor` and `gcd` throw `unsupported-constant` for `sqrt(2)`, `ln(2)` and `exp(1/2)`. Replace them with a name.
- A result can have more cases than the input. Always render `conditions`.
- `x^1000` trips the `digits` budget before the `degree` budget. Raise budgets on purpose, through options.
- The root entry holds types and errors only. Import verbs from their subpath.

## Errors

| Error                                       | Meaning                                     | What to do                                       |
| ------------------------------------------- | ------------------------------------------- | ------------------------------------------------ |
| `CasError` `unsupported-function`           | A function the verb has no rule for         | Remove it or compute numerically                 |
| `CasError` `not-differentiable`             | The input is not differentiable there       | Differentiate where it is                        |
| `CasError` `not-in-domain`                  | A value outside the reals                   | Remove the value at `span`                       |
| `CasError` `bad-variable`                   | The variable is a constant or function name | Pass another name                                |
| `CasError` `not-rational`, `not-polynomial` | The input has the wrong shape               | Pass a rational function or a polynomial         |
| `CasError` `unsupported-constant`           | A constant cas cannot zero-test             | Replace it with a name                           |
| `CasLimitError`                             | A budget was exceeded                       | Reject the input, or raise the budget on purpose |

## Verify

```sh
bun run test:docs
bun run typecheck
bun run test
```
