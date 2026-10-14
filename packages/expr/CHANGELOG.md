# @arki/expr

## 0.0.1

Core (RFC `2026-10-14-arki-expr` §21 step 1). Not published yet.

- Hand-written single-pass lexer: number literals (`.5`, `1e-7`, `2e+1`), Greek names, the aliases `× · ÷ − π √`, and decimal-comma syntax.
- Recursive-descent parser with the precedence and implicit-multiplication rules of RFC §4.2–4.3, absolute-value bars, `√`, postfix `!`, warnings for `1/2x` and `2^3x` readings.
- AST version 1 with spans, `walk`, `children`, `names`; `print` in `canonical` and `display` styles; `fromJSON` with full validation.
- `defineLanguage` and the built-in `scientific` language; `canonical` and `decimalComma` syntax presets, `defineSyntax`, `syntaxFor`.
- `ParseError` and `ExprLimitError`; length, token, depth and node budgets.
