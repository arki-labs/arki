# @arki/schedule

Typed schedules for TypeScript. A schedule is a name, a `cron` pattern or an `every` interval, and a handler. It runs in your process, or on a queue backend that catches up after downtime.

- A handler returns a value or a declared failure. Every run reports one status: `ran`, `refused`, `handler-failed`, and the skip and lock outcomes.
- Two kinds: in process (the default) and durable (`durable: true`, through `@arki/queue`).
- One replica at a time with a `lock`, on any `@arki/lock` lease store: `pgLease` on Postgres, `sqliteLease` on SQLite, `redisStore` on Redis. A Dot adapter and oRPC cron routes.
- No hidden retries. The runtime runs the handler once per tick.

## Install

```sh
bun add @arki/schedule
```

`@arki/dot` is an optional peer for `@arki/schedule/dot`. `@orpc/contract` and `@orpc/server` are optional peers for `@arki/schedule/orpc`. Durable schedules need `@arki/queue` and Redis.

## Quick start

```ts run expect
import { defineSchedule } from '@arki/schedule';
import { createScheduleRuntime } from '@arki/schedule/runtime';

const report = defineSchedule({
  name: 'daily-report',
  cron: '0 6 * * *',
  handler: async () => ({ rows: 3 }),
});

const runtime = createScheduleRuntime({ schedules: [report] });
runtime.start(); // arms the timer for 06:00

const result = await runtime.trigger('daily-report'); // run it now
if (result.status === 'ran') console.log(`ran: ${result.value.rows} rows`);

await runtime.stop();
```

```text
ran: 3 rows
```

## Steps and arounds

`with: [...]` lists plain functions that run before the handler, in order. A step reads the context and returns keys to add, or a failure to refuse the run. An around wraps everything after it.

```ts
import { defineFailure } from '@arki/failure';
import { defineSchedule } from '@arki/schedule';

const Paused = defineFailure('billing.paused', { status: 409, message: 'billing is paused' });

const unlessPaused = (_ctx: object) => (process.env.BILLING_PAUSED === 'true' ? Paused() : { billing: 'on' as const });
let lastRunMs = 0;
const timed = async <T>(_ctx: object, next: () => Promise<T>) => {
  const started = Date.now();
  try {
    return await next();
  } finally {
    lastRunMs = Date.now() - started; // a refusal is timed too: it resolves, it does not throw
  }
};

export const invoice = defineSchedule({
  name: 'invoice',
  every: '1h',
  with: [unlessPaused, timed],
  handler: async ctx => ({ billing: ctx.billing }),
});
```

- **A refusal makes the run `refused`,** with that failure, as if the handler had returned it. The handler does not run.
- **A step and an around are told apart by `fn.length >= 2`.** An around declares `next` as a plain second parameter. Do not give it a default value or a rest parameter, or it runs as a step.
- **Order matters.** Each element sees the keys added before it.

See [Steps and arounds](../dot/docs/middleware.md) for the full model, shared by every transport.

## When not to use this

- You need a job queue with retries, priorities and flows. Use `@arki/queue`. A schedule only decides when something starts.
- You need an exact catch-up of every missed tick. Many missed ticks become one run, even when durable.
- You need exactly-once effects. Durable delivery is at least once.
- You run a single request and exit, such as a function on an edge platform. A schedule needs a process that stays up, or a host that calls `trigger`.

## Runtime support

`@arki/schedule` ships TypeScript source, so it needs Bun or a bundler. It does not run as plain Node from `node_modules`.

The in-process runtime uses timers and runs on Node 22.12 or newer and Bun. Durable schedules also need Redis, through `@arki/queue`. With `clock: 'host'` the runtime arms no timers, and the host calls `trigger`.

Debug logs use the `arki:schedule` category. Show them with `DEBUG=arki:schedule`.

## Public imports

- `@arki/schedule`: `defineSchedule`, `initSchedule`, `ScheduleError`, `ScheduleLockFailed`, `SCHEDULE_ERROR_CODES`, `SCHEDULE_RUNTIME_FAILURES`, `parseEveryInterval`, `lockDurationMs`, and the types.
- `@arki/schedule/runtime`: `createScheduleRuntime` for a process that does not boot through Dot.
- `@arki/schedule/dot`: Dot adapters. `schedule`, `schedules`, `composeSchedules`, `DurableSchedules`.
- `@arki/schedule/orpc`: cron routes over oRPC.
- `@arki/schedule/projection`: a schedule topology document from an app manifest.

`llms.txt` lists every export per entry point.

## Failure behaviour

A run never throws to the timer. It reports a `ScheduleRunResult`.

| Status            | Meaning                                                                          |
| ----------------- | -------------------------------------------------------------------------------- |
| `ran`             | The handler succeeded. `value` excludes declared failures.                       |
| `refused`         | The handler returned a declared failure. `failure` keeps its type and data.      |
| `handler-failed`  | The handler threw. `cause` is an `UnexpectedDefect`.                             |
| `skipped-overlap` | `overlap: 'skip'` and a run of the same schedule is active in this process.      |
| `skipped-lock`    | Another replica holds the lock for this tick.                                    |
| `lock-failed`     | The lock provider failed. `cause` is `ScheduleLockFailed` or `UnexpectedDefect`. |
| `unavailable`     | The runtime is stopped. Nothing ran.                                             |

A wrong declaration throws a `ScheduleError` with a code `ARKI_SCHEDULE_E001` to `E009` and a `.remediation`. The code is thrown at definition, boot or `start()`, never inside a tick. Each code has a fix and a check command in its JSDoc. The status table is checked by the example in [Run schedules](docs/recipes/run-schedules.md):

```ts from="examples/run-schedules.ts#run"
import { defineSchedule } from '@arki/schedule';
import { createScheduleRuntime } from '@arki/schedule/runtime';

const report = defineSchedule({
  name: 'daily-report',
  every: '1h',
  overlap: 'skip',
  handler: async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    return { rows: 3 };
  },
});

const runtime = createScheduleRuntime({ schedules: [report] });
runtime.start(); // arms the timer: the first tick is an hour away

// Run it now, as a test or an admin button would.
const first = runtime.trigger('daily-report');
const second = runtime.trigger('daily-report'); // the first run is still active in this process

for (const result of await Promise.all([first, second])) {
  console.log(result.status === 'ran' ? `ran: ${result.value.rows} rows` : result.status);
}

await runtime.stop();
```

## Limits

- **An in-process schedule skips ticks missed while the app is down.** Boundary: a `0 6 * * *` schedule in an app that restarts from 05:55 to 06:05 does not run that day.
- **Many missed durable ticks become one run.** A durable schedule keeps one pending tick. When a worker returns, it runs once, then the next tick is set from now.
- **Several replicas run the same in-process tick** unless the schedule has a `lock`. `dot explain` prints `NO LOCK — runs on every replica`.
- **Durable delivery is at least once.** A stalled worker can cause redelivery. Use an idempotency key for external effects.
- **A durable name cannot contain `:`.** BullMQ forbids it in a queue name. `defineSchedule` throws `ARKI_SCHEDULE_E001`.
- **A run that outlasts its interval can overlap the next tick on another replica,** because the next tick is queued when the current one starts. `overlap: 'skip'` covers one process only.
- **`every` takes `s`, `m` or `h`.** `'0s'` and other zero or malformed intervals throw `ARKI_SCHEDULE_E001`.
- **A renamed or removed durable schedule leaves its old scheduler in Redis** with one pending job and no worker. Remove it with `removeJobScheduler`.
- **No retries.** A handler that throws is `handler-failed` for that tick. The next tick runs as planned.

## Documentation

- [Run schedules](docs/recipes/run-schedules.md): define a schedule, run it now, see overlap skipped.
- [Schedules in a Dot app](docs/reference/dot.md): `schedules()`, `schedule()`, locks, the host clock, the `scheduler` service, oRPC cron routes.
- [In-process and durable schedules](docs/reference/durable.md): the two kinds, the bare runtime, missed ticks, overlap.
- [Run results and observation](docs/reference/results.md): statuses, typed outcomes, telemetry.
- [Upgrading schedule outcomes](docs/upgrades/0.0.1-to-0.1.0.md)
- [Agent guide](docs/agent-guide.md) and [llms.txt](llms.txt) for coding agents.

## Support

Report bugs at [github.com/arki-labs/arki/issues](https://github.com/arki-labs/arki/issues).
