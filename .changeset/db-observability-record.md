---
"@arki/db": patch
---

The README now has an `## Observability` section that lists every `db.*` span and the `db.operations` and `db.operation.duration` metrics. It replaces the old "Transaction observability" note, which wrongly said transaction spans were still missing. The agent guide and the local-runtime upgrade note no longer say so either. A new test proves that inside a Dot app a transaction a usecase opens runs in `db.transaction.once` under the usecase's span.
