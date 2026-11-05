---
"@arki/payments": minor
---

A returned failure now sets the span attribute `failure.code`, the name every `@arki/*` package uses, instead of `payments.failure_code`. The span status for a returned failure (a declined card) stays unset; a throw still sets it to error. Migration: dashboards and alerts that group on `payments.failure_code` group on `failure.code`.

Docs: README `## Observability` lists every `payments.*` span and the `payments.operations` counter.
