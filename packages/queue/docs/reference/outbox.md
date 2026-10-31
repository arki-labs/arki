# Transactional scheduling with the outbox

Reference for `@arki/queue/outbox`: a job stored as a database row in your transaction.

`trigger()` and `enqueue()` talk to Redis, outside your database transaction. If the transaction rolls back, the job still runs. If Redis is down after the commit, the job is lost. `@arki/queue/outbox` writes the job as a row in the `@arki/journal` jobs table, in your transaction. The row exists if and only if your write commits. The journal worker runs it. It needs no Redis, and it imports no BullMQ or pg-boss at runtime.

```ts skip="excerpt: it uses names this page does not define"
import { listenOnPool } from '@arki/db/pg';
import { outbox, outboxRunner } from '@arki/queue/outbox';

export const schedule = outbox({ tables }); // tables from journalTables()

export const startRun = (db: AppDb, input: StartInput) =>
  db.transaction(async tx => {
    const run = await runs.withTx(tx).create({ status: 'pending' });
    await schedule.runAfter(tx, discoveryJobs.runDiscovery, { runId: run.id }, { key: `discovery:${run.id}` });
    return run;
  });

// The journal worker the app already runs, plus one option.
const worker = journal.worker(db, {
  listen: listenOnPool(listenPool, journal.wakeChannel),
  jobs: outboxRunner({ registry: discoveryJobs, context: () => ({ db }) }),
});
```

A wrong field in `args` is a compile error. Passing the root `db` instead of `tx` is a compile error and a runtime error (`OUTBOX_E001`). The API is `runAfter(tx, job, args, { delayMs, key, priority })`, `runAt(tx, job, args, date, { key, priority })` and `cancel(db, id)`.

The three ways to start a job:

|                                    | `trigger()`   | `enqueue()` (`queue()` client) | `schedule.runAfter(tx, ...)`        |
| ---------------------------------- | ------------- | ------------------------------ | ----------------------------------- |
| Stored in                          | Redis         | Redis                          | your database, in your transaction  |
| Rolls back with your write         | no            | no                             | yes                                 |
| Needs a worker in the same process | yes           | no                             | no                                  |
| Needs Redis                        | yes           | yes                            | no                                  |
| Runs on                            | `queueWorker` | `queueWorker`                  | `journalWorker` or `journal.worker` |

- **Atomic enqueue is not request idempotency.** The row is written once per awaited call in the committed transaction. Two HTTP retries that both commit schedule twice. Pass `key` to dedupe among unfinished rows of the same job, like `jobId`. Or cover the whole operation with a journal receipt.
- **At-least-once.** The row stays until the worker acknowledges it. A crash between the handler and the ack runs the job again. Pass `ctx.job.id` to external systems as the idempotency key. It is the row id (`job_xxx`) and stays the same across retries. A handler that returns an `@arki/failure` failure fails the job, as on the BullMQ lane. Retry uses the job's own `.options({ retry })` backoff (3 tries by default). Bad stored args go dead at once, without running the handler.
- **The delay starts with the transaction.** The job is due at the transaction's `now()` plus `delayMs`. A long transaction uses part of the delay. A job can also run late: by up to `pollMs` without a listener, or under load.
- **Plain JSON args and pure schemas.** Args are stored as JSON. Use strings, finite numbers, booleans, null, arrays and plain objects. A `Date`, `Map`, `bigint` or class instance returns `schema.invalid_input`. The job's input schema must give the same result on the stored value: avoid transforms that need a live object. Args over `maxArgsBytes` (256 KiB by default) are refused.
- **Priority has no order promise.** `priority` uses the same scale as `trigger`: `QUEUE_PRIORITIES`, 1 (critical) to 10 (background), default 5. The row stores `5 - priority`, and the worker claims the higher stored value first. Among equal priorities, the oldest due row goes first. `SKIP LOCKED` is not FIFO. A steady stream of high priority rows can starve low ones.
- **Dead and stranded jobs.** When the retry policy stops, the row is dead. List it with `journal.jobs(db, { status: 'dead' })`. `journal.retry(db, id, { actor })` requeues it with the same id. `op` (`{ actor, reason?, executionId? }`) is required on every journal verb; see the `@arki/journal` README. A worker claims only the job names its runner knows. If you rename a job, its old rows are stranded: `journal.strandedJobs(db, { jobs })` lists them. Put a version in the name (`mail.welcome.v1`) so a rename is a new job on purpose.
- **Retention.** A job can say how long the journal keeps its finished and dead rows: `.options({ retention: { completed: '1d', dead: '30d' } })`. It takes `completed`, `dead` and `retryableFor`, with the same forms as an effect's retention in `@arki/journal` (`false`, `'forever'`, `'untilExported'`, an age like `'7d'`, or `{ age, max }`). It overrides the journal's policy for this job name. Only the outbox lane reads it; the BullMQ lane ignores it.
- **Foreman.** `queueForemanModule` from `@arki/queue/foreman` raises its errors through `moduleError` from `@arki/admin/module`. A stale approval and a job that is no longer failed answer 409 (they were 500), and an unknown queue answers 404. The codes are `ARKI_QUEUE_E014`, `E015` and `E016` in `QUEUE_FOREMAN_ERROR_CODES`. `QueueForemanError` is removed: match on the code of the `ModuleError`, with `isModuleError`. `redactSecrets` is owned by `@arki/admin/module`; `@arki/queue/foreman` still re-exports it.
- **Handler differences.** `ctx.job` is the structural `JobLike` on every lane (`id`, `name`, `data`, `attemptsMade`, `updateProgress`, `log`). On the outbox lane `log` and `updateProgress` go to debug output (logger `arki:queue:outbox`). Queue handlers get `ctx.signal`: it aborts when the journal worker loses the job's lease or stops. A handler that ignores it is still covered by at-least-once.
- **Errors.** `OUTBOX_E001` to `OUTBOX_E007`: not in a transaction, bad args, not JSON, bad timing or priority, bad stored args, unknown job, duplicate name. Each has a `.remediation`. Test with `isOutboxError(e)`.
- **Dot wiring.** `outboxPlugin({ tables })` (from `@arki/queue/dot`) provides the `schedule` service. Mount it with `.infra(...)` (or `.use(...)`) in every process that schedules. The worker process lists the features and serves the journal worker with `outboxJobs`. The same `jobs(...)` slice feeds this lane and `queueWorker`.

```ts skip="excerpt: it uses names this page does not define"
import { jobs, outboxJobs, outboxPlugin } from '@arki/queue/dot';

const signup = defineFeature('signup')
  .needs({ db: database.provides.db, schedule: scheduling.provides.schedule })
  .usecases({})
  .provides({
    signups: ({ db, schedule }) => ({
      register: (userId: string) => db.transaction(tx => schedule.runAfter(tx, welcome, { userId })),
    }),
  })
  .entrypoints(jobs(q.registry({ welcome })));

defineApp('signup-worker')
  .infra(database, scheduling, journal({ j }))
  .features([signup])
  .entrypoints(
    journalWorker({
      listen: onMessage => client.listen(journal.wakeChannel, onMessage), // PGlite; with pg, listenOnPool from @arki/db/pg
      jobs: outboxJobs({ needs: {}, context: ({ db }) => ({ db }) }),
    }),
  );
```

The worker manifest lists `<job>.consume` under the plugin `journal-worker`.

- **No entities needed.** The outbox needs the journal tables and a journal worker, not entities or effects. Give `initJournal({ tables })` the journal tables, compose it with no handlers (`j.compose({})`), run `journal.worker(db, { jobs: outboxRunner(...) })`, and add the migration from the `@arki/journal` README (Tables) to your app.
- **Where the typed API lives.** The typed outbox API is `@arki/queue/outbox`. `@arki/journal` itself only knows the `JobRunner` port.
