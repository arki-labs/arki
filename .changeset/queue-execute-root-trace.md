---
"@arki/queue": minor
---

`queue.execute` now starts a new trace when the message carries no producer trace. Before, it fell back to the active context, so in a Dot app every such job nested under the ended `dot.unit.start` span and looked like part of app startup. A message that carries the producer's trace still continues it. `queue.execute` is now a consumer span (`SpanKind.CONSUMER`), matching the producer `queue.enqueue` span.

Docs: README `## Observability`.
