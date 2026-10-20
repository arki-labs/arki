---
"@arki/offline": minor
---

Return exact canonical enqueue failures and preserve typed queue/token identities with the existing secure 21-character representation. `queue.enqueue` and `useOfflineMutation().mutate` now return a receipt or an exact failure; receipt status distinguishes queued, sent and dead-lettered writes. The hook exposes pending and failure state.

Unconfirmed persistence carries the original identity for reconciliation. Corrupt persisted data is preserved instead of silently discarded; replay does not repeat an already accepted RPC after local cleanup fails in the same runtime. Enqueue tracing inherits application context and cannot alter execution, including when reporters reject asynchronously.


Drain, queue/dead-letter storage and retry/discard now return exact canonical failures instead of rejecting operationally. Consumers must narrow these results with `isFailure`. Queue status and hooks expose background failures; devtools displays returned failures. Unknown RPC adapter defects halt instead of blindly retrying; known transport outages use `QueueTransportUnavailable`. Explicit drains resume authentication halts. Storage, actor, dead-letter and drain operations are instrumented by default.
