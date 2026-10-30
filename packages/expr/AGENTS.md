AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/expr: Laws

A safe expression language for user-typed formulas. Read these before you change or use the package.

## Laws

1. The root entry holds no numeric code. Evaluation lives in the domain entries (`float`, `decimal`, `rational`, `complex`). Do not import a domain from the root.
2. No `eval`, no `new Function`, no regular expressions in the lexer. Names resolve through private `Map`s, so `constructor` and `__proto__` are unknown names.
3. Every input has a budget (`length`, `tokens`, `depth`, `nodes`, `steps`, `digits`). A check runs before the costly work. `parse`, `parseEquation` and `fromJSON` return `ExpressionOverBudget` (the `ExprLimitError` is the `cause`); `compile` throws `ExprLimitError`.
4. A stored AST is untrusted. `fromJSON` re-validates it field by field against the same budgets and returns `InvalidExpression` for a bad tree.
5. Errors, not `NaN`. Only `f.sample` may return `NaN`, to mark a plot gap.
6. The Decimal domain defaults to rounding `'unnecessary'`. A step that would round throws until the caller picks a mode. Never add a silent default rounding.
7. A domain never falls back to float. A function with no exact meaning is `not-in-domain` at compile time.
8. The canonical text from `print` is the storage form. Do not store the user's raw text as the formula.
9. Every public error carries a stable `code`. Apps translate messages by that code, never by the message.
10. Types are written once and inferred everywhere. No `any`, no `@ts-ignore`, no unsafe casts.

## Changing this package

- A new function goes into the language table first, then into each domain table. The types require an implementation in every domain that lists it.
- A change to a budget changes the `Limits` table in `README.md` in the same commit.
- A change to the AST shape bumps the AST version and needs a `fromJSON` migration test.
- Doc examples live in `README.md` and `docs/`. Run them with `bun run test:docs`.
- Keep bundle sizes inside the `size-limit` budgets. `bun run test` checks them.

## Verify

```sh
bun run test:docs
bun run typecheck
bun run test
bun run lint
bun ../../tooling/library/src/llms.ts --check
```
