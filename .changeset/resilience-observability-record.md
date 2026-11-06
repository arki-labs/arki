---
"@arki/resilience": patch
---

The README now has an `## Observability` section: every `resilience.*` span with when it starts and what it records, the three metrics, and what is left uninstrumented. A new test proves that inside a Dot app a preset run by a usecase opens `resilience.execute` under the usecase's span.
