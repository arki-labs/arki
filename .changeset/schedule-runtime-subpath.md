---
'@arki/schedule': minor
'@arki/queue': minor
---

Durable crons now work without Dot. `@arki/schedule/runtime` exports `createScheduleRuntime` (and its option and result types); the main entry stays free of the logger and timers. `@arki/queue` exports `createDurableScheduler` from its main entry, so a plain process can pass it as `createScheduleRuntime({ durable })`.

`@arki/schedule` now typechecks its tests, and a new test wires `@arki/queue`'s `durableScheduler()` into `schedule({ durable })`, so the typecheck fails if the queue's copy of the durable port drifts from the schedule's. `@arki/queue` is a dev dependency of `@arki/schedule` for that test only.
