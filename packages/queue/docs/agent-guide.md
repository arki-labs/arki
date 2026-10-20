# @arki/queue for agents

Read this file first. [`llms.txt`](../llms.txt) is the index. The [README](../README.md) is the long overview. If this guide and the code disagree, the code wins.

## The model

1. A job is a name, an input schema and a handler. `q.job.name(...).input(schema).handler(fn)` builds one.
2. `initQueue.context<...>().create()` gives `q`. Middleware wraps handlers and adds to the context.
3. `q.registry({ ... })` groups jobs by feature.
4. The BullMQ lane stores jobs in Redis. `trigger()` and `queue().enqueue()` start them. `queueWorker` runs them.
5. The outbox lane stores jobs in your database, in the `journal_jobs` table of `@arki/journal`. `schedule.runAfter(tx, job, args)` starts them. The journal worker runs them.
6. Both lanes take the same job definitions and the same registry. A handler sees the same `ctx` on both.

## Task map

### Define a job

```ts
const q = initQueue.context<{ db: AppDb }>().create();

export const welcome = q.job
  .name('mail.welcome.v1')
  .input(z.object({ userId: z.string() }))
  .handler(async ({ userId }, ctx) => {
    await sendWelcome(userId, { idempotencyKey: ctx.job.id });
  });

export const jobs = q.registry({ welcome });
```

### Schedule a job in the same transaction

```ts
import { outbox, outboxRunner } from '@arki/queue/outbox';

export const schedule = outbox({ tables }); // tables from journalTables()

export const register = (db: AppDb, userId: string) =>
  db.transaction(async tx => {
    await users.withTx(tx).create({ id: userId });
    await schedule.runAfter(tx, welcome, { userId }, { key: `welcome:${userId}` });
  });

// In the worker process: the journal worker plus one option.
const worker = journal.worker(db, { jobs: outboxRunner({ registry: jobs, context: () => ({ db }) }) });
```

Options: `runAfter(tx, job, args, { delayMs, key, priority })`, `runAt(tx, job, args, date, { key, priority })`, `cancel(db, id)`.

Rules:

- Pass `tx`, never `db`.
- Pass `ctx.job.id` on as the idempotency key. The job runs at least once.
- Args are plain JSON. No `Date`, `Map`, `bigint` or class instances.
- `key` dedupes among unfinished rows of the same job. It does not make an HTTP retry safe by itself.
- The delay counts from the start of the transaction.
- Order is not promised. High priority can starve low priority.
- Version the job name. A renamed job leaves stranded rows (`journal.strandedJobs(db, { jobs })`).
- The app needs the journal migration (`drizzle-kit generate`). Roll out: migrate, workers, producers.

### Dot

```ts
import { jobs, outboxJobs, outboxPlugin } from '@arki/queue/dot';

// Process that schedules: mount the plugin, which provides the `schedule` service.
defineApp('signup-api').infra(database, scheduling).features([signup]);

// Worker process: the same features, plus the journal worker.
defineApp('signup-worker')
  .infra(database, scheduling, journal({ j, tables }))
  .features([signup])
  .entrypoints(journalWorker({ listen, jobs: outboxJobs({ needs: {}, context: ({ db }) => ({ db }) }) }));
```

Here `scheduling` is `outboxPlugin({ tables })`. A feature lists its jobs with `jobs(q.registry({ welcome }))` in `.entrypoints(...)`. The worker manifest lists `<job>.consume` under the plugin `journal-worker`. For the Redis lane use `queue(...)` and `queueWorker(...)` from the same entry.

## Outbox errors

Each error has a `code` and a `.remediation`. Test with `isOutboxError(e)`.

| Code          | Name               | Cause                                                                    |
| ------------- | ------------------ | ------------------------------------------------------------------------ |
| `OUTBOX_E001` | `notInTransaction` | `runAfter` got the root database. Pass `tx`.                             |
| `OUTBOX_E002` | `badArgs`          | The args do not pass the job's input schema.                             |
| `OUTBOX_E003` | `notJson`          | The args are not plain JSON, or are over `maxArgsBytes`.                 |
| `OUTBOX_E004` | `badTiming`        | Bad `delayMs`, invalid `Date`, or a priority outside `QUEUE_PRIORITIES`. |
| `OUTBOX_E005` | `badStoredArgs`    | Stored args no longer pass the schema. The job goes dead at once.        |
| `OUTBOX_E006` | `unknownJob`       | A job name is not in the registry.                                       |
| `OUTBOX_E007` | `duplicateName`    | Two jobs in the registry share a name.                                   |

## Returned outcomes and migration

`executeJob` preserves the exact handler return union plus canonical input/cancel/deadline/defect failures. BullMQ and pg-boss both persist refusals as failed deliveries. Default retry never repeats a returned refusal or defect; use `.options({ retry: backoff.constant(100).upTo(2).while(TransientFailure) })` for selected definitions. Outbox passes returned outcomes directly to Journal before acknowledgement.

`trigger` and job `enqueue` return an id or `JobTriggerFailure`; export `JOB_TRIGGER_FAILURES` into the calling transport's error map. A lost enqueue acknowledgement is `QueueAcceptanceUnknown`, so inspect the idempotency key before replay. See the README upgrade section before changing runtime-local persisted messages.

Use `timeoutMs` and honor `ctx.signal`. Deadline/cancellation waits for settlement; external effects still require idempotency after a crash. Telemetry configuration belongs in the app; the worker restores producer context and records an execution span by default.

A middleware can return a defined failure directly: `q.middleware(async () => AccessRefused())`. `.use()` adds that exact failure to the job output union; returning it stops before the handler. `next()` retains its `{ ctx, output }` protocol and may be called once. A malformed middleware result becomes `UnexpectedDefect`. Retry keys `attempts`/`backoff` belong to the shared `retry` option and cannot be overridden through native BullMQ options. Flow data mappers declare job input only; mapper defects/refusals fail submission before opening Redis.

## Queue client diagnostic

A worker without its queue client raises `ARKI_QUEUE_E019` (`QUEUE_PLUGIN_ERROR_CODES.clientMissing`). Mount `queue({ connection })` before features and worker startup. `ARKI_QUEUE_E006` remains the missing-name builder diagnostic; older releases used it for both conditions.
