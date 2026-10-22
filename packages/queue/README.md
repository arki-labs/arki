# @arki/queue

Typed background jobs for TypeScript. You write a job once: a name, an input schema and a handler. It runs on BullMQ and Redis, on pg-boss and PGlite with no Redis, or as a database row that commits with your transaction.

- One job definition, three lanes. Handlers see the same `ctx` on each.
- Input is checked by any Standard Schema (Zod, Valibot, ArkType). Bad input comes back as a failure value, not a throw.
- Retries are one `Backoff` from `@arki/resilience`. Expected refusals are returned, not thrown. A thrown error follows the retry; a returned failure does not unless `.while(...)` selects it.
- Schedules, flows, middleware, and a Dot adapter (`@arki/queue/dot`).

## Install

```sh
bun add @arki/queue
```

`@arki/dot` and `@arki/admin` are optional peers. Install `@arki/dot` for `@arki/queue/dot`, and `@arki/admin` for `@arki/queue/foreman`. The BullMQ lane needs a Redis server. The outbox lane needs a database with the `@arki/journal` tables.

## Quick start

This runs a job on the `runtime-local` lane: pg-boss on an in-memory PGlite database. It needs no Redis and no Docker.

```ts run expect
import { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';

import { orThrow } from '@arki/failure';
import { createRuntimeLocalQueueInstance, initQueue } from '@arki/queue/runtime-local';

const q = initQueue.context<{ greeting: string }>().create();
const done = Promise.withResolvers<void>();

const welcome = q.job
  .name('mail.welcome.v1')
  .input(z.object({ userId: z.string() }))
  .handler(async (data, ctx) => {
    console.log(`${ctx.greeting}, ${data.userId}`);
    done.resolve();
    return { sent: true };
  });

const pglite = new PGlite();
const queue = createRuntimeLocalQueueInstance({ pglite, createContext: () => ({ greeting: 'Welcome' }) });
await queue.register(q.registry({ welcome }));
await queue.start();

orThrow(await welcome.trigger({ userId: 'usr_1' }));
await done.promise;
await queue.stop();
await pglite.close();
```

```text
Welcome, usr_1
```

To run the same job on Redis, build the queue with `q.createQueue({ connection: 'redis://localhost:6379', createContext })` instead. The job does not change.

## When not to use this

- You need a job to start only if your database write commits, and you do not want Redis. Use the outbox lane (`@arki/queue/outbox`). It is part of this package.
- You need a general workflow engine. A flow here is a BullMQ tree: a step has at most one dependent. There are no loops and no fan-out.
- You need exactly-once effects. Every lane delivers at least once. Make the effect safe to repeat.
- You run on a platform with no long-lived process, such as a pure edge function. A worker is a process that stays up.

## Runtime support

`@arki/queue` ships TypeScript source, so it needs Bun or a bundler. It does not run as plain Node from `node_modules`.

| Lane                        | Needs                                                                |
| --------------------------- | -------------------------------------------------------------------- |
| `q.createQueue` (BullMQ)    | A Redis server that BullMQ supports, and Node 22.12 or newer, or Bun |
| `@arki/queue/runtime-local` | Node 22.12 or newer, or Bun. PGlite holds the data                   |
| `@arki/queue/outbox`        | The `@arki/journal` tables in Postgres or PGlite                     |

Debug logs use the `arki:queue` category. Show them with `DEBUG=arki:queue`.

## Choose a lane

|                            | `job.trigger()` / `queue().enqueue()` | `runtime-local`                   | `schedule.runAfter(tx, ...)`        |
| -------------------------- | ------------------------------------- | --------------------------------- | ----------------------------------- |
| Stored in                  | Redis                                 | PGlite                            | your database, in your transaction  |
| Rolls back with your write | no                                    | no                                | yes                                 |
| Needs Redis                | yes                                   | no                                | no                                  |
| Flows                      | yes                                   | no                                | no                                  |
| Runs on                    | `queueWorker`                         | `createRuntimeLocalQueueInstance` | `journalWorker` or `journal.worker` |

## Public imports

- `@arki/queue`: the core. `initQueue`, `step`, `around`, `QUEUE_PRIORITIES`, `backoff`, `CronPatterns`, `queueJobId`, `JOB_TRIGGER_FAILURES`, `FLOW_ENQUEUE_FAILURES`, `createDurableScheduler`, and the types.
- `@arki/queue/types`: the types only.
- `@arki/queue/errors`: browser-safe failures. `JOB_TRIGGER_FAILURES`, `QueueUnavailable`, `QueueAcceptanceUnknown` and the declaration error codes.
- `@arki/queue/contract`: browser-safe, for oRPC contracts. `JOB_TRIGGER_FAILURES`, the two trigger failures, `queueJobId`, and the types `JobTriggerFailure`, `JobTriggerResult`, `QueueJobId`.
- `@arki/queue/runtime-local`: the same builders on pg-boss and PGlite. `initQueue`, `createRuntimeLocalQueueInstance`.
- `@arki/queue/dot`: Dot adapters. `queue`, `queueWorker`, `jobs`, `durableScheduler`, `outboxPlugin`, `outboxJobs`.
- `@arki/queue/outbox`: jobs as database rows. `outbox`, `outboxRunner`, `isOutboxError`, `OUTBOX_ERROR_CODES`.
- `@arki/queue/projection`: `project(manifest)` builds a queue topology document from an app manifest.
- `@arki/queue/foreman`: `queueForemanModule`, the admin module for failed jobs and retry. Needs `@arki/admin`.

`llms.txt` lists every export per entry point.

## Failure behaviour

A refusal you expect is a returned value. A bug in your declaration is a thrown error with a code.

| Where                        | Result                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `trigger()`, job `enqueue()` | A job id, or a `JobTriggerFailure` from `JOB_TRIGGER_FAILURES`. Bad input is `InvalidInput`.                             |
| Flow `enqueue()`             | `{ jobIds }`, or a failure from `FLOW_ENQUEUE_FAILURES`.                                                                 |
| No queue started             | `QueueUnavailable`.                                                                                                      |
| Acknowledgement lost         | `QueueAcceptanceUnknown`. The job may be queued. Look it up by its key before you send again.                            |
| Handler returns a failure    | The job fails. The failure's code, status and data are stored. It is not retried unless `.while(Definition)` selects it. |
| Handler or middleware throws | Reported as `UnexpectedDefect`. The throw follows the job's retry: `upTo(2)` runs it up to 3 times.                      |
| Handler passes `timeoutMs`   | `Deadline`. `ctx.signal` aborts, and settlement waits for the handler.                                                   |
| Wrong declaration            | `QueueDefinitionError` with a code `ARKI_QUEUE_E006` to `E013`, `E017` or `E020`. Thrown at build or register time.      |
| Outbox misuse                | An error with a code `OUTBOX_E001` to `OUTBOX_E007` and a `.remediation`. Test with `isOutboxError`.                     |

Each error code has a fix and a check command in its JSDoc. [Recover jobs](docs/recipes/recover-jobs.md) shows a worker dying mid-job:

```ts from="examples/recover-jobs.ts#recover"
import { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';

import { orThrow } from '@arki/failure';
import { createRuntimeLocalQueueInstance, initQueue } from '@arki/queue/runtime-local';

const q = initQueue.context<Record<string, never>>().create();
const finished = Promise.withResolvers<void>();

const ship = q.job
  .name('orders.ship')
  .input(z.object({ orderId: z.string() }))
  // A claim that is not settled within 1 second means the worker is dead.
  .options({ runtimeLocalOptions: { expireInSeconds: 1 } })
  .handler(async (data, ctx) => {
    const attempt = ctx.job.attemptsMade + 1;
    console.log(`claimed ${data.orderId}, attempt ${attempt}`);
    // The first claim never settles, like a worker killed in the middle of the job.
    if (attempt === 1) await new Promise<never>(() => {});
    console.log(`shipped ${data.orderId}`);
    finished.resolve();
    return { shipped: true };
  });

const queue = createRuntimeLocalQueueInstance({
  pglite: new PGlite(),
  createContext: () => ({}),
  // Look for dead claims every second. The default is every 60 seconds.
  superviseIntervalSeconds: 1,
  maintenanceIntervalSeconds: 1,
  monitorIntervalSeconds: 1,
});
await queue.register({ ship });
await queue.start();
orThrow(await ship.trigger({ orderId: 'ord_1' }));
await finished.promise;
// The first handler never settles, so a graceful stop would wait for it. Exit instead.
process.exit(0);
```

## Limits

- **Delivery is at least once.** After a worker dies, the job runs again from the start with `ctx.job.attemptsMade` one higher. Boundary: a handler that sends mail and then crashes before it settles sends the mail twice unless it passes `ctx.job.id` as the idempotency key.
- **A flow is a tree.** A step can be the dependency of one other step. A step that two steps depend on throws `ARKI_QUEUE_E017` at `.build()`.
- **Job names.** A job name is its queue name. BullMQ refuses a name with `:`. pg-boss accepts only letters, digits, `_`, `-`, `.` and `/`. `orders.ship` works on every lane. `orders:ship` throws `ARKI_QUEUE_E020` when the job is declared.
- **Runtime-local has no flows and no interval schedules.** It skips them with a warning. Use cron schedules.
- **Outbox args are plain JSON, at most 256 KiB** (`maxArgsBytes`). A `Date`, `Map`, `bigint` or class instance throws `OUTBOX_E003`.
- **Outbox order is not promised.** Priority 1 to 10 picks the claim order, but `SKIP LOCKED` is not FIFO. A steady stream of high-priority rows can starve low ones.
- **An outbox delay starts with the transaction,** not with the commit. A job can also run late, by up to `pollMs` without a listener.
- **Recovery time depends on the lane.** BullMQ needs 30 to 60 seconds by default. pg-boss needs `expireInSeconds` (15 minutes by default) plus a supervise pass. See [Recover jobs](docs/recipes/recover-jobs.md).
- **Polling can delay a job** beyond its due time on `runtime-local`. Workers poll every 500 ms.

## Documentation

- [Recover jobs after a worker dies](docs/recipes/recover-jobs.md): what recovers a job on each lane, with a runnable example.
- [Jobs, middleware and retries](docs/reference/jobs.md): builders, retry rules, telemetry, middleware, handler events, testing, shutdown.
- [Schedules and flows](docs/reference/schedules-and-flows.md): cron and interval schedules, durable schedules for `@arki/schedule`, flows.
- [Outbox](docs/reference/outbox.md): jobs that commit with your transaction.
- [Dot](docs/reference/dot.md): `queue()`, `queueWorker()` and `jobs()`.
- [Builder API and job identity](docs/reference/api.md): the builder surface and how job keys work.
- [Upgrading queue outcomes](docs/upgrades/0.1.0-to-0.2.0.md)
- [Agent guide](docs/agent-guide.md) and [llms.txt](llms.txt) for coding agents.

## Support

Report bugs at [github.com/arki-labs/arki/issues](https://github.com/arki-labs/arki/issues).
