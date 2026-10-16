---
'@arki/queue': minor
---

New entry `@arki/queue/outbox`: transactional scheduling. `outbox({ tables }).runAfter(tx, job, args)` writes the job row in the caller's transaction, and `outboxRunner` runs it from the `@arki/journal` worker. It needs no Redis. `@arki/queue/dot` gains `outboxPlugin` and `outboxJobs`. `JobContext.job` and the middleware `job` are now the structural `JobLike`, so a BullMQ job still fits. The cast in runtime-local is gone.
