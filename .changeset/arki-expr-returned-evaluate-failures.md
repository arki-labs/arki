---
'@arki/expr': minor
---

Parsers of outside values return, builders throw. `evaluate(text)` in every domain returns `InvalidExpression` (`expr.invalid_text`), `ExpressionOverBudget` (`expr.over_budget`) or `NoValue` (`expr.no_value`, for example `0^i`) with the thrown error as `cause`, instead of throwing; the list is `EVALUATE_FAILURES`. `syntaxFor` returns `InvalidLocale` (`expr.invalid_locale`) for a rejected tag and reads the decimal mark with `format`, so Hermes without `formatToParts` no longer throws. New `parseSyntax` returns `InvalidSyntax` (`expr.invalid_syntax`) for stored settings; `defineSyntax` stays the throwing builder. `@arki/failure` is a new runtime dependency. See `docs/upgrades/0.0.2-to-0.1.0.md`.
