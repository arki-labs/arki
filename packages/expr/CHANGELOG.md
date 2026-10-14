# @arki/expr

## Unreleased

Decimal and Rational domains (RFC `2026-10-14-arki-expr` §21 step 3).

- `@arki/expr/decimal`: `compile`, `compileEquation`, `evaluate` on `Decimal`. `+ - *` and integer powers exact; `/` exact when it terminates, else rounded to `{ scale, rounding }` (default scale 20, rounding `'unnecessary'` → `RoundingNecessaryError`); `sqrt cbrt nthRoot exp ln log log10 log2`, non-integer powers, `pi`, `e` correctly rounded at `scale` through `@arki/math/decimal-math`; trigonometry and `i` are `not-in-domain` at compile. `f.detailed(scope)` returns `{ value, exact }`.
- `@arki/expr/rational`: the same verbs on `Rational`. Never rounds; roots and rational exponents only when the result is rational (`8^(2/3)` is 4), else `RoundingNecessaryError`; `exp`, logarithms, trigonometry, `pi`, `e`, `i` are `not-in-domain`.
- Both: literals read from their text, constant folding at compile, exact `factorial mod floor ceil round fix sign abs`, a `digits` budget (default 1 000) on literals and on estimated power and factorial results (`9^9^9`, `10000!` refused before any bigint work), and `{ signal }` checked before each operation on a value above 100 digits.
- `size-limit` entries for both domains; decimal benchmark cases against mathjs on BigNumber; domain-equivalence property tests (Decimal vs Rational, float's oracle pinned to the Rational domain).

Also unreleased: float domain and LaTeX (RFC `2026-10-14-arki-expr` §21 step 2).

- `@arki/expr/float`: `compile`, `compileEquation`, `evaluate`. Closure trees specialised per operator and arity; a checked tree for `f()` / `f.at()` that throws typed `@arki/math` errors, and a lazily built IEEE tree for `f.sample()` where `NaN` marks a gap. Degree mode, split-letter name resolution with `f.readings`, `split-after-division` warnings, static `steps` budget, `signal` checks in `sample`.
- `@arki/expr/latex`: `toLatex`.
- `Language` carries its function and constant names as type parameters, so `compile` requires host implementations by type. Function definitions take an optional `cost` (default 1) for the steps budget.
- `size-limit` budgets in `test`; benchmark suite against mathjs (pruned) and expr-eval.

## 0.0.1

Core (RFC `2026-10-14-arki-expr` §21 step 1). Not published yet.

- Hand-written single-pass lexer: number literals (`.5`, `1e-7`, `2e+1`), Greek names, the aliases `× · ÷ − π √`, and decimal-comma syntax.
- Recursive-descent parser with the precedence and implicit-multiplication rules of RFC §4.2–4.3, absolute-value bars, `√`, postfix `!`, warnings for `1/2x` and `2^3x` readings.
- AST version 1 with spans, `walk`, `children`, `names`; `print` in `canonical` and `display` styles; `fromJSON` with full validation.
- `defineLanguage` and the built-in `scientific` language; `canonical` and `decimalComma` syntax presets, `defineSyntax`, `syntaxFor`.
- `ParseError` and `ExprLimitError`; length, token, depth and node budgets.
