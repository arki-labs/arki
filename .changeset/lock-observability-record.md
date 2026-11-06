---
"@arki/lock": patch
---

The README now has an `## Observability` section: every `lock.*` and `lock.store.*` span with when it starts, the `lock.operations` counter, and what is left uninstrumented. A new test proves that inside a Dot app a lock taken by a usecase opens `lock.run` under the usecase's span.
