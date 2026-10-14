---
'@arki/schedule': minor
'@arki/queue': minor
---

`@arki/schedule`: `schedule()` is a driver for `.serve()` and collects every bound feature's `schedules` slice; the `features` option and the feature-token option types are removed. App-level `schedules` are optional. Feature schedules are no longer checked against `context` at compile time (features bind at runtime); a malformed slice fails boot with `ARKI_SCHEDULE_E001`.

`@arki/queue`: `queueRuntime()` is replaced by two units. `queue({ connection, keyPrefix? })` goes in `.use()` and provides `queue: QueueClient` (`enqueue(job, data, opts?)`), so features can enqueue. `queueWorker({ q, needs, context })` goes in `.serve()` and runs the features' `jobs()` slices, using the client's connection and key prefix. `jobs()` slices carry only producer actions; the worker owns the consumer actions. `QueueFeatureToken`, `QueueRuntimeOptions`, `QueueRuntimeFeatureOptions`, `QueueFeatureNeeds`, `QueueRuntimeHandle` and codes `E004`/`E005` are removed; a missing client fails with `ARKI_QUEUE_E006`.
