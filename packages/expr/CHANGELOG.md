# @arki/expr

## Unreleased

Float domain and LaTeX (RFC `2026-10-14-arki-expr` §21 step 2).

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
