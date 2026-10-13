---
'@arki/queue': minor
---

New `durableScheduler({ connection, keyPrefix? })` Dot plugin in `@arki/queue/dot`. It is the BullMQ backend for `@arki/schedule` schedules declared with `durable: true`, provided under `DURABLE_SCHEDULES_KEY` (`'arki.schedule.durable'`).

Boot only builds the backend. When the schedule plugin starts, each durable schedule gets a queue named `schedule.<name>` with one job scheduler and one worker. An unchanged scheduler is left alone at start, so a tick that fell due while no worker ran survives a restart and runs once. A handler failure marks the tick's job failed. The last 100 completed and 100 failed tick jobs are kept.

No change to `queueRuntime`, jobs, schedules or flows.
