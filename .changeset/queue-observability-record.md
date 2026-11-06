---
"@arki/queue": patch
---

The README now has an `## Observability` section: the `queue.enqueue`, `queue.flow.enqueue` and `queue.execute` spans, what each records, and how the producer context reaches the worker. A new test against a real Redis proves that inside a Dot app a job enqueued by a usecase opens `queue.enqueue` under the usecase's span.
