---
'@arki/schedule': minor
---

Each schedule now chooses whether it is durable, and lock failures are reported.

- `defineSchedule({ ..., durable: true })`, for `cron` and `every`, hands the schedule to a durable backend. `schedule({ ..., durable: DurableSchedules })` takes that backend as a typed need; `durableScheduler()` from `@arki/queue/dot` provides it on BullMQ. Each tick runs once across replicas, with no KV lock, and a tick missed while no worker ran runs once when a worker returns. The default (`durable: false`) is unchanged: in-process timers that skip ticks missed while down. The README states the missed-tick rules.
- Mistakes are caught early. Passing `durable: DurableSchedules` with no backend mounted before it is a type error. A `durable: true` schedule with no backend fails boot with `ARKI_SCHEDULE_E005`, naming the schedule. A durable name containing `:` throws `ARKI_SCHEDULE_E001` from `defineSchedule`.
- New port types `DurableScheduler` and `DurableScheduleRegistration` let another backend implement durable schedules.
- A broken lock store is no longer reported as a held lock. The run returns the new status `lock-failed` and counts in the new `lockFailures` (a lock lost during the run counts in `lockLost`); `lockContention` counts only "another replica holds the lock". Lock failures and handler failures are now logged as errors through `@arki/log`, not only at debug level.

Breaking, so a minor bump while the package is below 1.0: `ScheduleDef` has a new required `durable` field, `ScheduleRunStatus` has a new member, the schedule-table projection rows have a new `durable` field, and a dashboard that read the old `lockSkips` as "any lock skip" should read `lockContention` and add `lockFailures` and `lockLost`.
