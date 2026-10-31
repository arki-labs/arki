# @arki/expr

## Unreleased

- `toLatex` puts a signed operand after `+`, `-`, `\cdot` or another sign in parentheses: `x + -1` is `x + \left(-1\right)`, `--x` is `-\left(-x\right)`.

Complex domain (RFC `2026-10-14-arki-expr` §21 step 4).

- `@arki/expr/complex`: `compile`, `compileEquation`, `evaluate` on `@arki/math/complex`'s `Complex`. Float64, never exact (`f.detailed()` reports `exact: false`). Principal branches (`sqrt(-4) = 2i`, `ln(-1) = πi`, `i^i = e^(-π/2)`); on the real axis every function returns the float domain's value wherever float has one. `i` is a constant (a variable `i` is `name-conflict` in this domain only). `cbrt nthRoot sign ceil floor round fix mod factorial gamma` are `not-in-domain`. `angle: 'deg'` takes and returns real angles only. Scope values: `Complex`, finite numbers, or `{ re, im }`.
- The shared exact-domain compiler takes an `approximate` domain flag; its `not-in-domain` message for a missing function no longer says "no exact result". The float domain builds its angle-free table on first use, so a bundle that imports only the trigonometry table leaves it out.
- `size-limit` entries for the complex domain; a Complex-against-float property test on `+ - * / ^int` trees.

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

## 0.1.0

### Minor Changes

- a1b64e6: Parsers of outside values return, builders throw. `evaluate(text)` in every domain returns `InvalidExpression` (`expr.invalid_text`), `ExpressionOverBudget` (`expr.over_budget`) or `NoValue` (`expr.no_value`, for example `0^i`) with the thrown error as `cause`, instead of throwing; the list is `EVALUATE_FAILURES`. `syntaxFor` returns `InvalidLocale` (`expr.invalid_locale`) for a rejected tag and reads the decimal mark with `format`, so Hermes without `formatToParts` no longer throws. New `parseSyntax` returns `InvalidSyntax` (`expr.invalid_syntax`) for stored settings; `defineSyntax` stays the throwing builder. `@arki/failure` is a new runtime dependency. `parse`, `parseEquation` and `fromJSON` also return `InvalidExpression` or `ExpressionOverBudget` (the list is `PARSE_FAILURES`; the `ParseError` or `ExprLimitError`, with the span for the caret, is the `cause`) instead of throwing, so `compile(parse(text))` needs the failure handled first. `compile`, `compileEquation` and compiled functions take trees code built and keep throwing. `fromJSON` now throws `InvalidArgumentError`, not `ParseError`, for a language `defineLanguage` did not build. See `docs/upgrades/0.0.2-to-0.1.0.md`.

### Patch Changes

- e132ad3: Hand-written object guards now come from `@arki/schema` (`is(value, recordSchema)` or `plainObjectSchema`), per A-39. Replaced: the `isRecord`/`isPlainObject`/`isObject` helpers in `dot`, `cli`, `http`, `expr`, `lock`, `mail`, `embeddings` (its internal `isRecord`, not a public export), `testing` and `payments`, plus inline `typeof x === 'object' && x !== null` checks on unknown values. Behaviour is the same, except that the inline checks and `lock`'s guard no longer let arrays through. `@arki/expr` and `@arki/lock` now depend on `@arki/schema`.
- Updated dependencies [d2faf8f]
- Updated dependencies [f9ecefb]
- Updated dependencies [e6b9330]
- Updated dependencies [a1b64e6]
  - @arki/math@0.2.0
  - @arki/failure@0.3.0
  - @arki/schema@0.3.0

## 0.0.2

### Patch Changes

- 7922fb5: Docs standard: README reordered with install, quick start, limits and failure behaviour; `AGENTS.md`, `llms.txt` and `docs/agent-guide.md` added; doc examples compile under `test:docs`.

  no demo impact: documentation and doc-example changes only, runtime behaviour unchanged

- b6d2b8a: Initial public release of `@arki/expr` (safe formula parsing, printing and evaluation in float, decimal, rational and complex domains, with LaTeX output) and `@arki/cas` (bounded computer algebra on expr: exact polynomials and rational functions with π and e as symbols, `simplify`, `derivative` with a rule-by-rule `derivation`, `factor` over ℚ and closed-form roots).
- @arki/math@0.1.0

## 0.0.1

Core (RFC `2026-10-14-arki-expr` §21 step 1). Not published yet.

- Hand-written single-pass lexer: number literals (`.5`, `1e-7`, `2e+1`), Greek names, the aliases `× · ÷ − π √`, and decimal-comma syntax.
- Recursive-descent parser with the precedence and implicit-multiplication rules of RFC §4.2–4.3, absolute-value bars, `√`, postfix `!`, warnings for `1/2x` and `2^3x` readings.
- AST version 1 with spans, `walk`, `children`, `names`; `print` in `canonical` and `display` styles; `fromJSON` with full validation.
- `defineLanguage` and the built-in `scientific` language; `canonical` and `decimalComma` syntax presets, `defineSyntax`, `syntaxFor`.
- `ParseError` and `ExprLimitError`; length, token, depth and node budgets.
