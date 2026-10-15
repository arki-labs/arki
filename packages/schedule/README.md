# @arki/schedule

Schedules for DOT apps. Each schedule chooses how it runs:

- **In process** (the default, `durable: false`). A croner timer or interval
  in each process. A tick that falls due while the app is down is skipped.
- **Durable** (`durable: true`). A BullMQ job scheduler through
  `@arki/queue`. Each tick runs once across all replicas, and a tick missed
  while no worker ran still runs once when a worker comes back.

Both kinds work with `cron` and with `every`.

## Inside a DOT app

A feature declares its schedules with `schedules([...])`. `schedule()` is a
driving adapter: mount it with `.serve()`, after the features. It runs the
schedules of every mounted feature — the app lists its features once:

```ts
import { feature } from '@arki/dot/feature';
import { service } from '@arki/dot/plugin';
import { initSchedule } from '@arki/schedule';
import { schedule, schedules } from '@arki/schedule/dot';

type Ctx = { readonly db: Db };
const s = initSchedule.context<Ctx>().create();

export const reports = feature('reports', {
  use: [schedules([s.define({ name: 'daily-report', cron: '0 6 * * *', handler: async ({ db }) => db.reports.build() })])],
});

defineApp('shop')
  .use(db({ url }))
  .features([reports, billing])
  .serve(schedule({ needs: { db: service<Db>() }, context: ({ db }) => ({ db }) }));
```

`context` builds the one value every handler receives. The features are
bound at runtime, so the compiler cannot check that their schedules expect
this context: keep one context type per app. A schedule no feature owns
goes in `schedule({ schedules: [...] })`; it runs on the same runtime, so
names must be unique across both.

### Feature-owned schedules: `schedules(needs, defs)`

When a schedule belongs to one feature and works with that feature's
services, declare it with the feature's `needs`. The handler's parameter is
typed from `needs` with no annotation, and the feature must list the same
services in its own `needs` (a compile error otherwise). The driver's
`context` is not used for these handlers.

```ts
const needs = { mailer: service<Mailer>() };

export const digest = feature('digest', {
  needs,
  use: [
    schedules(needs, [
      // Plain option objects, not defineSchedule(): the handler is typed from `needs`.
      { name: 'send-digest', cron: '0 7 * * *', handler: ({ mailer }) => mailer.sendDigest() },
    ]),
  ],
});
```

The options and validation match `defineSchedule` (`cron` or `every`,
`timezone`, `overlap`), except `durable: true`: a durable run happens in
another process that does not hold these services. It is a type error and
fails at declaration with `ARKI_SCHEDULE_E006`. The handler may return a
value; a `ran` result keeps it.

### The host clock: `schedule({ clock: 'host' })`

By default (`clock: 'internal'`) the runtime fires schedules on its own
timers. With `clock: 'host'`, `start()` arms nothing: a schedule runs only
when the host calls `trigger` (a platform cron, an HTTP endpoint). A durable
schedule or a durable backend with the host clock fails boot with
`ARKI_SCHEDULE_E007`, because two clocks would fire the same tick.

### The `scheduler` service

`schedule()` provides `scheduler` to the app, typed with no annotation:

```ts
const app = await defineApp('news')
  .use(mailer())
  .features([digest])
  .serve(schedule({ clock: 'host' }))
  .boot();

app.services.scheduler.clock; // 'host'
app.services.scheduler.names; // ['send-digest']
await app.services.scheduler.trigger('send-digest');
```

`trigger(name)` resolves a `ScheduleOutcome`: a run result (see
[Run results](#run-results)), or `unknown` for a name the driver does not
run. A trigger works once the app has booted, before `start()` too. After
`stop()` it reports `unavailable`; `stop()` waits for runs it already
accepted.

### Typed triggers: `composeSchedules(features, scheduler)`

`composeSchedules` turns the service into a client typed from the features'
own `schedules(needs, defs)` declarations. An undeclared name is a compile
error, and a `ran` outcome's `value` is that handler's resolved return type:

```ts
const schedules = composeSchedules([digest], app.services.scheduler);
const outcome = await schedules.trigger('send-digest');
if (outcome.status === 'ran') outcome.value; // the type sendDigest() resolves to
```

It throws `ARKI_SCHEDULE_E008` when the scheduler does not run a declared
schedule (pass the same features the app mounts).

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
  .serve(schedule({ schedules: [nightly], durable: DurableSchedules }));
```

Declaring a durable schedule reads nothing from the world. Boot only builds
the backend. Redis is reached when the app starts: each durable schedule
gets its own BullMQ queue (`schedule.<name>`) with one job scheduler, and
one worker per process. Start does not wait for Redis; a failed
registration is logged as an error (`schedule durable registration failed`).

Where each mistake is caught:

| Mistake | Caught |
| --- | --- |
| `durable: DurableSchedules` with no `durableScheduler()` mounted before it | Type error at `.serve(...)` |
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
| `ran` | The handler finished. `value` holds what it resolved to. |
| `handler-failed` | The handler threw. `cause` holds the error. Counted in `handlerFailures` and logged as an error. A durable run also marks its BullMQ job failed. |
| `skipped-overlap` | `overlap: 'skip'` and a run of the same schedule is active in this process. |
| `skipped-lock` | In process only: another replica holds the lock for this tick. Counted in `lockSkips`. |
| `lock-failed` | In process only: the lock store threw. `cause` holds the error. Counted in `lockErrors` and logged as an error; the tick is skipped. |
| `unavailable` | The runtime was already stopped; nothing ran. |
