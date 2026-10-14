---
'@arki/queue': minor
---

Add `bullmqFailedJobSource` to `@arki/queue/foreman`, so the Foreman queue module can list and retry failed jobs of BullMQ queues. `q.createQueue()` now returns `BullMQQueueInstance`, which adds a read-only `queues()` map of its BullMQ `Queue` objects by name.
