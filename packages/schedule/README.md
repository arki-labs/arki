# @arki/schedule

Schedules for DOT apps. Each schedule chooses how it runs:

- **In process** (the default, `durable: false`). A croner timer or interval
  in each process. A tick that falls due while the app is down is skipped.
- **Durable** (`durable: true`). A BullMQ job scheduler through
  `@arki/queue`. Each tick runs once across all replicas, and a tick missed
  while no worker ran still runs once when a worker comes back.

Both kinds work with `cron` and with `every`.

## In-process schedules

Use these for single-replica processes by default. For multi-replica
deployments, pass a KV lock handle that supports `setIfNotExists`; each
fire takes a short TTL lock and skips when another replica already ran the
same schedule tick.

## Durable schedules

Mark the schedule, mount the queue's durable backend, and pass the
`DurableSchedules` token to `schedule()`:

```ts
import { defineSchedule } from '@arki/schedule';
import { DurableSchedules, schedule } from '@arki/schedule/dot';
import { durableScheduler } from '@arki/queue/dot';

const nightly = defineSchedule({
  name: 'nightly-billing',
  cron: '0 3 * * *',
  timezone: 'Europe/Bucharest',
  durable: true,
  handler: async ctx => {
    // ...
  },
});

defineApp('billing')
  .use(durableScheduler({ connection: env.REDIS_URL, keyPrefix: 'billing:' }))
  .use(schedule({ schedules: [nightly], durable: DurableSchedules }));
```

Declaring a durable schedule reads nothing from the world. Boot only builds
the backend. Redis is reached when the app starts: each durable schedule
gets its own BullMQ queue (`schedule.<name>`) with one job scheduler, and
one worker per process. Start does not wait for Redis; a failed
registration is logged as an error (`schedule durable registration failed`).

Where each mistake is caught:

| Mistake | Caught |
| --- | --- |
| `durable: DurableSchedules` with no `durableScheduler()` mounted before it | Type error at `.use(...)` |
| `durable` given anything but the `DurableSchedules` token | Type error |
| A durable name that contains `:` (BullMQ forbids it in queue names) | `ScheduleError` `ARKI_SCHEDULE_E001` from `defineSchedule` |
| A `durable: true` schedule but no `durable` option on `schedule()` | `ScheduleError` `ARKI_SCHEDULE_E005` at boot, naming the schedule |

### Without Dot

A process that does not boot through Dot builds the runtime itself, from
`@arki/schedule/runtime`. The main entry does not export it, so importing
`@arki/schedule` stays free of the logger and timers.

```ts
import { createDurableScheduler } from '@arki/queue';
import { createScheduleRuntime } from '@arki/schedule/runtime';

const runtime = createScheduleRuntime({
  schedules: [nightly, warmCache],
  durable: createDurableScheduler({ connection: process.env.REDIS_URL ?? '', keyPrefix: 'billing:' }),
});

runtime.start(); // durable schedules go to BullMQ, the rest run in process
// On shutdown:
await runtime.stop();
```

A `durable: true` schedule with no `durable` option makes `start()` throw
`ARKI_SCHEDULE_E005`.

### What happens to missed ticks

Checked against BullMQ 6.3 (`node_modules/bullmq/dist/esm`):

- A job scheduler keeps exactly one pending job: the next tick. A worker
  adds the following tick only when it takes the current one
  (`classes/worker.js`, `upsertJobScheduler` with `override: false`).
- So while no worker runs, ticks that fall due create no new jobs. The one
  pending job waits in Redis.
- When a worker comes back, that job runs once, right away. The next tick is
  then set from the current time, not from the missed slots: for `cron` the
  next match after now (`classes/job-scheduler.js`), for `every` the next
  interval slot after now (`commands/includes/getJobSchedulerEveryNextMillis.lua`).
  Many missed ticks therefore become **one** catch-up run, not one per tick.
- At start, `@arki/queue` leaves an unchanged scheduler alone, so the
  pending tick survives a restart. If you change the cron, timezone or
  interval, the scheduler is replaced (`commands/addJobScheduler-11.lua`
  deletes the pending job): a changed `cron` drops the missed tick and waits
  for its next match; a changed `every` runs once right away.
- A new `every` schedule runs once right after it is first registered, then
  every interval. A new `cron` schedule first runs at its next match.
- Renaming or removing a durable schedule leaves its old scheduler in Redis
  with one pending job and no worker. Remove it with
  `queue.removeJobScheduler(name)` on the `schedule.<name>` queue.

### Overlap and locks

Durable runs never take the KV lock: BullMQ gives each tick's job to one
worker. Each process runs at most one tick of a schedule at a time. A run
that outlasts its interval can still overlap the next tick on another
replica, because the next tick is queued when the current one starts.

## Run results

Each run reports a `ScheduleRunResult` with one status:

| Status | Meaning |
| --- | --- |
| `ran` | The handler finished. |
| `handler-failed` | The handler threw. Counted in `handlerFailures` and logged as an error. A durable run also marks its BullMQ job failed. |
| `skipped-overlap` | `overlap: 'skip'` and a run of the same schedule is active in this process. |
| `skipped-lock` | In process only: another replica holds the lock for this tick. Counted in `lockSkips`. |
| `lock-failed` | In process only: the lock store threw. Counted in `lockErrors` and logged as an error; the tick is skipped. |
