---
"@arki/http": patch
---

The README now has an `## Observability` section: the `http.request`, `http.idempotency` and `http.webhook.*` spans, what each records, and what is left to the runtime's fetch instrumentation. A new test proves that inside a Dot app a webhook signed by a usecase nests under the usecase's span, and the usecase under `http.request`.
