---
'@arki/queue': minor
---

A job whose handler throws now follows the job's retry like any thrown error, so `backoff().upTo(2)` runs it up to 3 times; a returned failure is still retried only when `.while(...)` selects it, and a throw is still reported as `UnexpectedDefect`. A job name with a character a queue name cannot hold (such as `:`) now throws `ARKI_QUEUE_E020` when the job is declared; use letters, digits, `_`, `-`, `.` and `/`, for example `orders.ship`. Faultline imports `@arki/queue` and keeps `.while(UnexpectedDefect)` on its `documents.deliver` retry (`demos/faultline/backend/src/worker/deliver.ts`): it is still valid and now redundant, because a thrown error already follows `upTo(2)`; its job name has no `:`. Drop Studio is not affected: no demo impact, it does not import `@arki/queue`.
