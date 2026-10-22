# @arki/schedule for agents

Read this file first. [`llms.txt`](../llms.txt) is the index. The [README](../README.md) is the overview. If this guide and the code disagree, the code wins.

## The model

1. `defineSchedule({ name, cron | every, handler })` declares a schedule. `initSchedule.context<Ctx>().create().define(...)` does the same with a typed context.
2. `createScheduleRuntime({ schedules })` from `@arki/schedule/runtime` runs them. `start()` arms the timers. `trigger(name)` runs one now. `stop()` waits for active runs.
3. In a Dot app, `schedules([...])` declares a feature's schedules and `schedule({ needs, context })` serves them.
4. In process (the default) a timer in each process fires the tick. `durable: true` hands the tick to a queue backend (`@arki/queue/dot`'s `durableScheduler`).
5. Every run reports a `ScheduleRunResult` with one `status`.
6. `with: [step, around]` runs plain functions before the handler. A step that returns a failure makes the run `refused`. An around must declare `next` as a plain second parameter. See [Run results](reference/results.md#steps-and-arounds).

## Task map

### Run a schedule

Follow [Run schedules](recipes/run-schedules.md). It defines a schedule, triggers it by hand and shows `skipped-overlap`.

### Run a schedule on one replica only

Give the feature schedule a `lock` (`lock: true` or a key). The runtime takes it with the `locks` service from `@arki/lock/dot`. A run that finds the lock held is `skipped-lock`. See [Schedules in a Dot app](reference/dot.md#one-replica-at-a-time-lock).

### Catch up after downtime

Set `durable: true`, mount `durableScheduler()` from `@arki/queue/dot` first, and pass `durable: DurableSchedules` to `schedule()`. Many missed ticks become one run. See [In-process and durable schedules](reference/durable.md).

### Expose a schedule as an HTTP cron route

Use `cronRouterFor` from `@arki/schedule/orpc`. See [Schedules in a Dot app](reference/dot.md).

## Rules that bite

- A refusal is `refused`. Switch on `status` exhaustively.
- The runtime does not retry. A durable backend redelivers, so effects need idempotency keys.
- A durable name cannot contain `:`.
- Two replicas run the same in-process tick unless a `lock` is set. `dot explain` prints `NO LOCK — runs on every replica`.
- `schedule({ clock: 'host' })` arms no timers and allows no durable schedule (`ARKI_SCHEDULE_E007`).
- Supply the context builder's generic through `initSchedule.context<Ctx>()`, not `defineSchedule<Ctx>(...)`. A lone generic stops inference of the rest.

## Errors

Every error is a `ScheduleError` with a `code` and a `.remediation`.

| Code                 | Cause                                                                |
| -------------------- | -------------------------------------------------------------------- |
| `ARKI_SCHEDULE_E001` | A bad name, timing or option (including `:` in a durable name).      |
| `ARKI_SCHEDULE_E002` | Two schedules share a name.                                          |
| `ARKI_SCHEDULE_E003` | Legacy handler failure. The runtime no longer emits it.              |
| `ARKI_SCHEDULE_E004` | Legacy lock failure. Current runtimes return `schedule.lock_failed`. |
| `ARKI_SCHEDULE_E005` | A `durable: true` schedule but no durable backend.                   |
| `ARKI_SCHEDULE_E006` | A feature-owned schedule declared `durable: true`.                   |
| `ARKI_SCHEDULE_E007` | `durable` with `clock: 'host'`.                                      |
| `ARKI_SCHEDULE_E008` | `composeSchedules` names a schedule the scheduler does not run.      |
| `ARKI_SCHEDULE_E009` | A `lock` schedule but the feature has no `locks` service.            |

Returned, not thrown: the run statuses `refused`, `handler-failed`, `skipped-overlap`, `skipped-lock`, `lock-failed` and `unavailable`, and the failure `schedule.lock_failed` (`ScheduleLockFailed`).

## Verify

```sh
turbo run build typecheck lint test --filter=@arki/schedule
cd packages/schedule && bun run test:docs
dot explain --json | jq .data.services   # in an app using @arki/schedule/dot: lists the scheduler service
dot doctor --json | jq .data             # in that app: no missing schedule or lock service
```
