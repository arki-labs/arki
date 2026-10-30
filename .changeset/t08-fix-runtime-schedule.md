---
'@arki/schedule': minor
---

`runtime.start()` now returns a promise that resolves a `schedule.durable_start_failed` failure when the durable backend refuses to register the durable schedules, so a refused start is no longer only logged. In-process timers are still armed before the first await. Await it and handle the result (`orThrow(await runtime.start())`). The lock-error code is read with a schema, not a hand-written guard.
