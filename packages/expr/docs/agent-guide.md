# @arki/expr agent guide

Read `llms.txt` first for the map. When this guide and `AGENTS.md` disagree, `AGENTS.md` wins.

## The model

1. `parse(text)` returns a typed AST with source spans, or a failure (`InvalidExpression`, `ExpressionOverBudget`). It never evaluates.
2. `print(ast)` returns the canonical text. Store that, not the user's text.
3. A domain entry (`float`, `decimal`, `rational`, `complex`) compiles an AST into a function. Each domain picks the value type.
4. The language decides which names exist. Anything else is `unknown-name` or `not-a-function`.
5. Every input is bounded. Text over a budget returns `ExpressionOverBudget`; a compile over a budget throws `ExprLimitError`.

## Task map

### Evaluate what a user typed

1. Parse with `parse(text, { variables })`. Pass the variable names so `x(y+1)` reads as a product.
2. Compile with the domain you need: `float` for plots, `decimal` for money-like numbers, `rational` for exact fractions.
3. Call the function with a scope. Check `isFailure(result)` after `parse`; `result.cause` is the `ParseError` with the span. `compile` throws only for bugs; let math errors reach the boundary.

```ts
import { parse } from '@arki/expr';
import { compile } from '@arki/expr/decimal';
import { orThrow } from '@arki/failure';

const total = compile(orThrow(parse('base * (1 + rate)')), {
  variables: ['base', 'rate'],
  scale: 2,
  rounding: 'halfEven',
});
total({ base: '19.99', rate: '0.19' }).toString(); // '23.7881'
```

### Store and reload a formula

1. Save `print(ast)` of a parsed tree, or the JSON of the AST.
2. Reload with `parse` or `fromJSON`. Both enforce the budgets and return a failure for a bad value.

### Show a formula

1. Call `print(ast, { style: 'display' })` for plain text.
2. Call `toLatex(ast)` from `@arki/expr/latex` for LaTeX.

### Plot a formula

1. Compile in `float` with `variables: ['x']`.
2. Fill a `Float64Array` with `f.sample(xs, out)`. `NaN` marks a gap.

## Rules that bite

- `1/2x` parses as `(1/2)x` and adds a warning. Print it back and show the hint.
- `parse` needs `variables` to read `x(y+1)` as a product.
- Decimal division that does not terminate throws until you pass a rounding mode.
- `sin` and `i` do not exist in the Decimal and Rational domains.
- `cbrt` and `nthRoot` do not exist in the Complex domain.

## Errors

| Error                                                                | Meaning                                | What to do                                       |
| -------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------ |
| `InvalidExpression` returned (`cause.code`: `unexpected-token`, ...) | The text is not an expression          | Show the user `cause.span` and `cause.expected`  |
| `ExpressionOverBudget` returned, or `ExprLimitError` thrown          | An input went over a budget            | Reject the input, or raise the budget on purpose |
| `DivisionByZeroError`, `InvalidArgumentError`, `NumericRangeError`   | The value has no result                | Show a message; do not retry                     |
| `RoundingNecessaryError`                                             | A Decimal or Rational step would round | Pass a `rounding` mode, or accept the throw      |

## Verify

```sh
bun run test:docs
bun run typecheck
bun run test
```
