---
'@arki/cas': minor
---

Verbs that take a string read outside text, so they now return failures instead of throwing: `derivative`, `derivation`, `simplify`, `expand`, `collect`, `rationalize`, `gcd`, `polynomialIn` and `factor`. Text that does not parse returns expr's own `expr.invalid_text` or `expr.over_budget`; a `CasError` returns `cas.unsupported_text`, a `CasLimitError` returns `cas.over_budget`, and a value error such as `x/0` returns `cas.no_value` (the thrown error is the failure's `cause`). The list is `CAS_TEXT_FAILURES` and the type `CasTextFailure`. An `Expr` the caller built keeps result-or-throw, and a bad `variable`, a bad option or an aborted signal still throw. `rationalize` now has the exported result type `Rationalized`. Callers of these verbs with a string must handle the failure first.
