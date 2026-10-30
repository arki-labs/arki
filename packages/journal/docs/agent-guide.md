# @arki/journal for agents

Read this file first. [`llms.txt`](../llms.txt) is the index. The [README](../README.md) is the long overview. `src/api.ts` defines every signature. If this guide and `src/api.ts` disagree, `src/api.ts` wins.

Paths that start with `src/` are files of this package. App files are named from the app's own source folder, for example `journal.root.ts` or `features/orders/effects.ts`. The app layout puts the journal root, the entities and the commands in separate files per feature. Read the feature layout note of your app before you touch it.

## The model

1. An entity is a normal row in its own Drizzle table. The table has a string key and a `version` column.
2. Every change is also one row in `journal_events`. Event rows are never changed or deleted.
3. One transaction writes the event rows and the entity row together.
4. A command is the way to write. `j.command` defines one and declares the events it writes. `journal.run` runs it. `journal.bind` is the door: it fixes the database and the actor once and returns a runner.
5. Inside a command, `write(entity, id, events)` locks the row and calls your `events` function with it. That function checks the rules and returns the new events.
6. A reducer turns each event into the next row. `.create` builds the first row. `.on` returns a patch.
7. Lane one is the projection. It runs inside the same transaction. If it throws, the write rolls back.
8. Lane two is the effect. The write adds a row to `journal_jobs`. A worker runs the handler after the commit, at least once.
9. Reads are plain Drizzle queries on the entity table.
10. Replay rebuilds a row from its events. It is for checks and repair only, never for reads.

## Three objects

| Object                | How you get it                                   | What it does                                                                                                                | Where it lives in an app                             |
| --------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `j`, the definitions  | `initJournal` (see Setup)                        | Declares things: `j.event`, `j.entity`, `j.command`, `j.projection`, `j.effect`, `j.workflow`. It never touches a database. | `journal.ts`                                         |
| The entity builder    | `j.entity(kind, table)`                          | A chain of `.create(Event, reducer)` and `.on(Event, reducer)`. The result is the entity you pass to `write`.               | `features/<name>/<entity>.ts`                        |
| `journal`, the runner | `j.compose({ projections, effects, workflows })` | Does the work: `run`, `bind`, `write`, `replay`, `verify`, `repair`, `rerun`, `drain`, `worker`, `wake`.                    | `journal.root.ts`, or the Dot adapter `journal(...)` |

How to tell them apart: only `journal` takes a database. Events, entities, commands, projections and effects need only `j`. They must never import the composed `journal`.

The word `create` has two meanings. Neither one builds the journal. `j.compose(...)` builds the journal.

| You see                                                        | It means                                                          | Defined in       |
| -------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------- |
| `initJournal.tx<AppTx>().db<AppDb>().create({ tables, meta })` | Finish the setup chain. Returns `j`.                              | `src/journal.ts` |
| `.create(Event, reducer)` on an entity builder                 | Declare a create reducer. It builds the first row from the event. | `src/entity.ts`  |

## Setup

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
import { initJournal, need } from '@arki/journal';
import { journalTables } from '@arki/journal/pg';

// schema.ts: the journal tables go into the app's schema and migrations.
export const tables = journalTables(); // or journalTables(pgSchema('app'))

// journal.ts: once per app. `meta` is the schema of the metadata every event records.
// `retention` (optional) is the one policy for finished jobs and finished workflow runs.
export const j = initJournal
  .tx<AppTx>()
  .db<AppDb>()
  .create({ tables, meta: z.object({ actorId: z.string().min(1) }), retention: { workflows: { completed: '30d' } } });

// journal.root.ts: the one place that lists handlers.
// `services` gives each effect and workflow step what it needs, by name.
export const journal = j.compose({ projections: [customerStats], effects: [orderMail], services: { mailer } });
```

`.tx<AppTx>()` types `tx` in commands and projections. `.db<AppDb>()` types `db` in effects. Both steps are optional and type-only. `initJournal({ tables, meta })` alone also returns `j`. `tables` is required: the journal's own entities (such as `workflow.run`) are declared on them. `AppDb` is the app's Drizzle database type. `AppTx` is its transaction type: `Parameters<Parameters<AppDb['transaction']>[0]>[0]`.

drizzle-kit migrates only the schema module's top-level exports. Export each `journalTables()` table on its own, never only the object. Keep `export type JournalTablesCheck = ExportsEveryJournalTable<typeof thisModule>;` in that module (`import type * as thisModule` from the file itself): it stops compiling and names the table when a journal upgrade adds one you have not exported. Export it, then run `drizzle-kit generate`.

## Task map

### Add an event and react in the same transaction

Library files: `src/entity.ts` (the builder and reducer types), `src/handlers.ts` (how a handler is found by event type).

1. In the entity file, declare the event with `j.event(type, schema)`. Event data is stored as JSON, so use no `Date` and no transform.
2. Add `.on(Event, reducer)` to the entity chain. The reducer returns only the columns that change.
3. In a command, return the event from the `events` function.
4. In the projections file, add a handler under the event's type. It gets `(tx, e)`. Use `tx` for every query.
5. A new projection must be listed: under `projections` in `journal.root.ts`, or in the feature's `journalProjections(...)` in its `.infra(...)` in a Dot app.

A full projection, `customerStats`, is in the [README example](../README.md#quick-start).

### Add an entity with create and delete

Library files: `src/entity.ts` (the key column checks), `src/fold.ts` (how reducers are picked and applied).

1. Add the table. It needs a string key that is the primary key or unique, and `version: integer('version').notNull().default(0)`. Add the migration in the app.
2. The key column is `id`. For another column, name it: `j.entity('profile', profiles, { key: 'accountId' })`.
3. Write the chain. Every `.create` comes before the first `.on`.
4. To delete, return `null` from a reducer. The row is removed. The events stay. The entity can be created again later, and its version continues.
5. A soft delete is a normal patch, such as `{ status: 'cancelled' }`. The row stays. The library does nothing special for it.

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
export const order = j
  .entity('order', orders)
  .create(OrderPlaced, e => ({ customerId: e.data.customerId, total: e.data.total, status: 'placed' }))
  .on(OrderPaid, () => ({ status: 'paid' })) // a patch: only the columns that change
  .on(OrderCancelled, () => ({ status: 'cancelled' })) // soft delete: a normal patch, the row stays
  .on(OrderErased, () => null); // delete: null removes the row, the events stay
```

### Add an effect that runs after commit

Library files: `src/handlers.ts` (`effectFor` is `j.effect`, `need`, and `bindEffect`, which gives an effect its services), `src/worker.ts` (claims, retries, `drain`, the loop, `wake`), `src/journal.ts` (`createJournal` gives the worker `runOn`, which makes `ctx.run`).

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
// features/orders/effects.ts: the effect lists what it needs. Each handler gets it in the context.
export const orderMail = j.effect(
  'order-mail',
  order,
  { mailer: need<Mailer>() },
  {
    OrderPaid: async (e, { jobId, db, mailer }) => {
      const [row] = await db.select().from(orders).where(eq(orders.id, e.entityId));
      if (!row) return;
      await mailer.send({ template: 'order-paid', orderId: e.entityId, total: row.total, idempotencyKey: jobId });
    },
  },
);

// An event that must run a command starts a task. An effect only reaches out.
export const closeAfterPayment = j.task(
  'close-after-payment',
  {
    version: 1,
    input: z.object({ orderId: z.string() }),
    startOn: {
      entity: order,
      event: OrderPaid,
      timing: 'after-commit',
      id: e => `close:${e.entityId}`,
      input: e => ({ orderId: e.entityId }),
    },
  },
  ({ input, run }) => run(closeOrder, { orderId: input.orderId }, { actorId: 'system' }),
);
```

- The handler gets `(e, { jobId, signal, db })`. `db` is the root database given to `drain` or `worker`. Read committed rows with it. An effect has no `run`: that call does not compile. It is a task or a workflow with `startOn`.
- An effect that needs nothing has three arguments. An effect that needs a service has four: the third is `{ mailer: need<Mailer>() }`, with `need` from `@arki/journal`. The handler then reads `mailer` from its context, typed. Do not wrap an effect in a function to pass a service in. (A Dot reaction is a plain exported value; its types come from the selector in `needsOf`, and the services still come from the feature at boot.)
- Where the service comes from: a plain app gives it once, in `j.compose({ ..., services: { mailer } })`. In a Dot app the effect picks it from the feature that lists it: `needsOf((_: Deps) => ['mailer'])` in place of `{ mailer: need<Mailer>() }`. It may pick a need that is not `entrypointOnly`, a private infra service or a domain service. The effect is then a plain exported value, `export const sendReceipt = j.effect(…, needsOf((_: Deps) => ['mailer']), …)`, in a file that imports `Deps` from the feature as a type only. A domain service types its deps from the `.infra()` stage, never from `Deps`: it is part of `Deps`, so TypeScript reports TS7022 on the feature. A missing service is a compile error. `j.compose` and the feature's boot in a Dot app also throw, and the message names the effect and the need.
- A need cannot be named `jobId`, `signal`, `db` or `run`. `j.effect` throws when the effect is defined.
- A task's `run(command, input, meta)` is `journal.run` on that same database: its own transaction, committed before it returns. `meta` names the actor; left out, the command records the `workflowMeta` the app gave `compose`. It works the same in a plain app and in a Dot app.
- If the command throws, nothing of the command is committed and `run` returns `TransactionDefect`. A body that throws it on is tried again by its retry policy; one that returns it fails, because a returned failure is final. If the body fails after `run` returned, the command stays committed and runs again on the retry. Make the command safe to run twice with `ctx.key`, or use a `.command` node: exactly once, see [Workflows](#workflows).
- `jobId` is the same on every retry. An effect can run more than once, so pass `jobId` on as an idempotency key.
- Where it is registered: under `effects` in `journal.root.ts`, or in a Dot app in the feature's `.usecases(factories, journalHandlers(core, { effects }))`. It lives in the behaviour file of the command it follows (`usecases/place-order.ts`), not in a special folder. Effect names are unique per journal.
- Who runs the worker: a plain app calls `journal.worker(db).start()` once per process and `stop()` on shutdown. In a Dot app, `.entrypoints(journalWorker())` does both.
- Which process runs the worker: an effect runs in the process that runs the worker. If an effect talks to something that lives in memory (an event emitter, a socket list, a cache), run the worker in the process that holds it. A worker in another process claims the job and the in-memory listeners never hear it. Tests do not catch this, because a test is one process.
- `wake`: `journal.run(db, ...)` on the root database wakes the worker after its commit. After a transaction of your own, call `journal.wake()` yourself. Other processes find the job by polling.
- A failing effect does not reach the caller. Its error is stored on the job row (`last_error`). The job is retried and marked dead after 8 failed attempts.

### Add a command and run it

Library files: `src/api.ts` (`Command`, `CommandContext`, `bind`), `src/command.ts` (how `journal.run` runs one), `src/errors.ts` (`CommandNotFound` and the other command failures, `JournalError`), `src/rollback.ts` (how a returned failure rolls back), `src/orpc.ts` (the oRPC error mapping).

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
// features/orders/commands.ts
import { CommandConflict, CommandNotFound } from '@arki/journal';
// core/orpc.ts, in an oRPC app: once, after the app's own error middleware.
import { commandErrors } from '@arki/journal/orpc';

export const payOrder = j.command(
  'payOrder',
  z.object({ orderId: orderIdSchema, amount: z.int().positive() }),
  { writes: [OrderPaid] },
  (input, { write }) =>
    write(order, input.orderId, row => {
      if (!row) return CommandNotFound({ detail: 'Order not found' });
      if (row.status !== 'placed') return CommandConflict({ detail: `Order is already ${row.status}` });
      return [OrderPaid({ amount: input.amount })]; // [] means: write nothing
    }),
);

// The door. Bind the database and the actor once, then pass only the command and its input.
// A request: the actor comes from the session. Put the bound runner on the request context.
const runCommand = journal.bind(db, { actorId: user.id });
// The result is the write's, or CommandNotFound | CommandConflict: then nothing was written.
const paid = await runCommand(payOrder, { orderId: id, amount: 10 });
// A job, a schedule, a script or a seed: use a clear system actor.
const runSystemCommand = journal.bind(db, { actorId: 'system' });
await runSystemCommand(payOrder, { orderId: id, amount: 10 });

export const publicProcedure = os.use(appErrors).use(commandErrors());
```

- The handler context is `{ tx, meta, write, run }`. `run(child, input)` runs another command in a savepoint.
- `journal.bind(source, meta)` is the door. It returns `(command, input) => journal.run(source, command, input, meta)`. You still give `meta`: the library never picks an actor. `meta` is parsed on every call, as in `journal.run`, so a default in the meta schema is new for each command.
- `source` is the root database or a transaction, with the rules of `journal.run`. On the root database each call commits and wakes the worker. On a transaction the call joins it; the caller commits and then calls `journal.wake()`.
- A bound runner has the type `CommandRunner`, the type of a command context's `run`. Pass it to code that takes one, for example `paymentsJournal.writes(runCommand)` of `@arki/payments`.
- A rule that rejects the request returns a failure: `CommandNotFound`, `CommandInvalid`, `CommandForbidden`, `CommandConflict`, or the app's own. The handler, `authorize` and an `events` function can return one. The command rolls back exactly as for a throw, and the caller gets the same failure, typed. An `events` failure comes back from `write`, a child's from `run`: return it from the handler (`if (isFailure(x)) return x;`). Going on to a success returns `TransactionDefect` with an `IGNORED_FAILURE` cause and nothing commits, unless the handler handled the refusal on purpose and called `accept(x)` first. See [Rejected rules](#rejected-rules).
- `writes` is required. `write` takes only the listed events, and `writes: []` is a command that only runs child commands. A helper that takes `write` names its events: `CommandWrite<Meta, Tx, typeof OrderPaid>`. The list stays on the value: `payOrder.writes`.
- A permission check goes in `j.command(name, input, { writes, authorize: (input, { tx, meta }) => ... }, handler)`, not in the handler. A call with an `idempotencyKey` that replays a receipt never runs the handler, but it always runs `authorize` first.
- An oRPC app adds `commandErrors()` to its procedure builders once. Procedures then need no try/catch around a command, and a returned failure answers as an error. A procedure with an output schema, or a contract-first one, uses `orThrowRpc(context.run(cmd, input), errors)` with `errorMap(CommandNotFound, ...)` in the contract. Any other host reads the failure's `status`, or matches it with `CommandNotFound.is(result)` and the like.
- `journal.run(source, command, input, meta)` is the long form. It parses the input and `meta`, opens the transaction, and returns what the handler returns.
- From a task or a workflow step, call `ctx.run(command, input, meta)`. It is `journal.run` on the worker's root database. An effect cannot run a command.
- In the games-platform backend, procedures call `context.runCommand`. `core/context.ts` binds it to the signed-in user. A job or a schedule binds its own runner: `journal.bind(db, { actorId: null })`. Do not call `journal.run` from a procedure there.

### Schedule a job in the same transaction

The job row is written in the caller's transaction. It exists if and only if the business write commits. The typed API is `@arki/queue/outbox`. The journal only stores and claims the row.

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
// backend/src/schedule.ts: once per app
import { listenOnPool } from '@arki/db/pg';
import { outbox } from '@arki/queue/outbox';

import { tables } from './journal.tables';

export const schedule = outbox({ tables });

// usecase
export const startRun = (db: AppDb, input: StartInput) =>
  db.transaction(async tx => {
    const run = await runs.withTx(tx).create({ briefName: input.briefName, status: 'pending' });
    await schedule.runAfter(
      tx,
      discoveryJobs.runDiscovery,
      { runId: run.id, budgetLimitUsd: input.budgetLimitUsd },
      { key: `discovery:${run.id}` },
    );
    return run;
  });

// worker: the journal worker the app already runs, plus one option
const worker = journal.worker(db, {
  listen: listenOnPool(listenPool, journal.wakeChannel),
  jobs: outboxRunner({ registry: discoveryJobs, context: () => ({ db }) }),
});
```

Rules:

- Pass `tx`, never `db`. The root database is a compile error and a runtime error (`OUTBOX_E001`).
- Pass `ctx.job.id` on to external systems as the idempotency key. The job runs at least once. The id is the row id and stays the same across retries.
- Job args are plain JSON. A `Date`, a `Map` or a class instance is rejected (`OUTBOX_E003`).
- A worker without `jobs` never claims a queue row. List queue rows with `journal.jobs(db, { job })` (it returns `{ jobs, next }`). Find stranded ones with `journal.strandedJobs(db, { jobs })`.
- After a migration, run `drizzle-kit generate`. Roll out migrate, then workers, then producers.

### Operate and retain jobs

A job is `ready`, `delayed`, `running` or `dead`. `pending` is the first three. Reads take the root database and page with an opaque cursor.

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
const { jobs, next } = await journal.jobs(db, { status: 'dead', limit: 50 }); // pass `next` back as `after`; null on the last page
const counts = await journal.jobCounts(db);
const op = { actor: 'alice', reason: 'provider outage' }; // required on every verb; actor is a non-empty free string

await journal.retry(db, jobId, op); // dead only: JOB_NOT_DEAD
await journal.discard(db, jobId, op); // dead only; archived as 'discarded'
await journal.cancel(db, jobId, op); // ready or delayed; JOB_RUNNING if a worker holds it
await journal.retryDead(db, { ids: [a, b] }, op); // at most 500 ids, all or nothing
await journal.purgeDead(db, { olderThan, limit: 500 }, op); // olderThan must respect retention.retryableFor
await journal.replayJob(db, archivedId, op); // a NEW job id, not a retry; JOB_EXISTS on a live dedupe key
```

Every verb that changes something writes one `journal_job_operations` row in its transaction. Retention goes in `initJournal({ tables, retention })`: `retryableFor` (`'30d'`), `archive.completed` (`'7d'`), `archive.dead` (`'90d'`), `archive.sink`, `operations` (`'forever'`), `sweep` (`{ every: '1h', batch: 1000 }` or `false`). A `Keep` is `false`, `'forever'`, `'untilExported'` (needs a sink, else `BAD_DEFINITION` at boot), an age (`'30d'`) or `{ age, max }`. One effect overrides it with `withSchedule({ retention: { completed: false } })`; a queue job with `.options({ retention })`. `retention.workflows` (`completed` `'7d'`, `failed` `'90d'`, `cancelled` = `failed`) is for finished workflow runs; see [Workflows](#workflows).

Rules:

- Each worker sweeps: `purgeDead`, `exportArchive`, `pruneArchive`, `pruneOperations`. With `sweep: false` call the first three yourself.
- A sink gets rows at least once and dedupes on `row.id`. No row is pruned before it is exported. `ndjsonArchiveSink({ put, prefix })` writes one NDJSON file per batch; `@arki/fs` `put` fits.
- Upgrading: generate the migration from `journalTables()` (three new tables, two new `journal_jobs` columns). Migrate first, then roll workers.
- Foreman: `journalJobsModule({ journal, db })` from `@arki/journal/foreman`. Refusals are `ARKI_JOURNAL_E001` to `E005`. `journalWorkflowsModule({ journal, db, meta })` has one permission per verb: `workflow:read` (reads, limits too), `journal:retry`, `workflow:signal`, `workflow:resolve`, `workflow:cancel`, `workflow:metadata` (`setMetadata`, `addTags`), `workflow:reschedule`, `workflow:replay` and `workflow:limits` (`workflow.limits.pause`, `resume`, `override`, `reset`). A limit approval is taken on `LimitView.version`; a metadata or tag change voids no run approval.
- Outbound webhook signing returns exact HTTP failures before sending. The worker keeps ownership and applies the configured retry predicate; use `.while(WebhookCryptoUnavailable)` only when retrying that refusal is intended. Attempts store the safe failure code.
- Inbox: key a command with the webhook event id (`journal.run(db, cmd, input, meta, { idempotencyKey })`). Relay: an effect that calls `queue.add(name, data, { jobId })`. `kv.publish` is best-effort only.

### Add a durable workflow

See [Workflows](#workflows): the rules, a five-step task, the traps and the [error codes](#workflow-errors).

### Find out why a write failed

1. Check the kind of error. `isJournalError(error)` is true: go to step 2. Not an error at all, but `isFailure(result)`: a rule returned a failure and the command rolled back; read its `code` and `message`, and find the `return` in the handler, `authorize` or `events`. `InvalidInput` (from `@arki/failure`): input, event data or `meta` failed its schema; read `data.issues`. `AsyncSchema` or `ValidatorDefect`: a schema could not run; fix the schema. These are returned values and are included in the operation's inferred failure type. A plain `Error` that starts with `journal:`: a wrong definition or a misuse; search `src/` for the message. Anything else was thrown by app code and passed through unchanged.
2. Read `error.code`, `error.kind` and `error.entityId`. Match on the code, for example `isJournalError(error, 'CONFLICT')`. Never match on the message. The message reads `CODE: what happened (kind id): detail. What to do next.`
3. Find the code in the [error table](#errors). To see the exact check, search for the code in the file the table names.
4. Run again with `DEBUG=arki:journal:*`. It prints commands, writes, replays, drains and worker ticks.

## Words that are mixed up

| Pair                                      | The difference                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stored row and reducer row                | The stored row (`Row<Tbl>`) is what the database returns, with defaults filled in. `events(row)` gets it. The reducer row (`ReducerRow<Tbl, Key>`) is what reducers built. A column left to its database default may be missing. `.on` and `replay` use it.                                                                                                                   |
| Pending event and recorded event          | A pending event is `{ type, data }`. `OrderPaid({ amount })` makes one and `events` returns them. A recorded event also has `seq`, `id`, `entityId`, `version`, `meta`, `recordedAt`, the trace `commandId`, `causeSeq`, `correlationId` (library-stamped; see README, Tracing), and `erasedAt` (see README, Erasure). Reducers, projections and effects get recorded events. |
| Entity version and global sequence        | `version` counts 1, 2, 3 inside one entity. `replay` takes `throughVersion`. `seq` orders all events of all entities in commit order: an advisory lock taken at the start of every write makes a lower `seq` commit first, so `seq > cursor` misses nothing. `rerun` takes `after`, a log position.                                                                           |
| `DbHandle`, `RootDb`, `TransactionSource` | `DbHandle` fits a database or a transaction: `replay`, `verify`, `repair`. `RootDb` is the database only: `drain`, `worker`. `TransactionSource<Tx>` is anything that opens a `Tx`: `run`, `rerun`. A root database opens a transaction. A transaction opens a savepoint.                                                                                                     |

## File map

- Public surface: `src/index.ts` (the exports), `src/api.ts` (every public signature), `src/types.ts` (row, event, handler and database types), `src/errors.ts` (the codes and their messages, and the command failures), `src/hooks.ts` (around-hooks on command and effect runs).
- Definitions: `src/journal.ts` (`initJournal`, `j`, `j.compose`), `src/entity.ts` (entity builder, reducers, key checks), `src/event.ts` (`j.event`), `src/handlers.ts` (`j.projection`, `j.effect`, `need`, and `bindEffect`, which gives an effect its services).
- Write path: `src/command.ts` (`journal.run`), `src/journal.ts` (`journal.bind`),`src/write.ts` (the write steps), `src/fold.ts` (apply events to a row), `src/store.ts` (Postgres storage: rows, the event log, receipts, jobs, wake), `src/storage.ts` (id and value checks), `src/transaction-guard.ts` (one operation per transaction).
- After commit and repair: `src/worker.ts` (`drain`, the worker loop, `wake`, `strandedJobs`), `src/history.ts` (`replay`, `verify`, `repair`, `rerun`).
- Job operations and retention: `src/outbox.ts` (`createJobOps`: reads, verbs, sweep steps), `src/retention.ts` (`Keep`, defaults, `ndjsonArchiveSink`), `src/foreman/index.ts` (the Foreman module).
- Workflows: `src/workflow/define.ts` (the builder and its types), `src/workflow/runner.ts` (`start`, `signal`, `cancel`, `read`, the `workflow.step` and `workflow.timer` effects, compensation), `src/workflow/machine.ts` (the `workflow.run` entity and its events), `src/workflow/read.ts` (`journal.workflows` reads and verbs), `src/workflow/states.ts` (states, statuses, skip causes), `src/foreman/workflows.ts` (the Foreman module), `src/testing.ts` (`workflowHarness`, `workflowHarnessOn`). Event waits: the `eventWait` node in `define.ts`, `workflow_waits` in `src/pg.ts`, `oldestEligible`, `wakeWait` and `wakeEffectFor` in `runner.ts`.
- Edges: `src/pg.ts` (the tables), `src/dot.ts` (Dot unit), `src/orpc.ts` (oRPC error mapping),`src/id.ts` (id factories, name checks), `src/debug.ts` (`DEBUG=arki:journal:*`), `src/test-support.ts` (test fixture, not shipped).

## Rules that bite

- **Await every `write` and `run`. One journal operation per transaction at a time.** Why: savepoints are a stack, so two open operations would release each other's savepoint. No `Promise.all` over writes.
- **`drain` and `worker` take the root database.** Why: inside a transaction, effects would run before the outer commit. They throw if given a transaction.
- **Run the worker where its effects have their listeners.** Why: any running worker can claim any job. An effect that emits in memory reaches only the process it runs in.
- **A reducer returns the value the database will store.** Why: `replay` and `repair` rebuild the row from reducer output. If the database rounds or trims, the two differ. The write fails with `VALUE_MISMATCH`.
- **Events are frozen.** Why: one handler's change would reach the next handler, and replay would not repeat it. Copy first: `[...e.data.items].sort()`.
- **Version 1 means created by the journal.** A row that existed before the journal starts its history at version 2. Why: replay folds from nothing, so it needs a history that starts at 1. Otherwise `replay`, `verify` and `repair` throw `NO_HISTORY`. To bring a row with no history in, at whatever version it holds, `journal.adopt` records a create event that rebuilds the row exactly as version 1 and sets the row to version 1 (README, Rows that existed before the journal).
- **A transient entity keeps no events.** `j.entity(kind, table, { events: 'transient' })`, or `initJournal({ tables, events: 'transient' })` for every entity. The write still locks, checks the version, folds, saves the row, runs inline projections and queues effect jobs, and the events it returns have a real `seq`. Why it bites: `replay`, `verify`, `repair`, `forget`, `adopt` and `rerun` throw `NO_HISTORY`; an async projection or a tap on such an entity is `BAD_DEFINITION` at `compose`. `workflow.run` always stores its events. After a delete, a new create starts at version 1 again. The event's copy in an effect job's `args` outlives the write until the job leaves the archive. To switch the entity to `'stored'`: change the setting, then `journal.adopt` each row before its first write; the row's version becomes 1 (README, Transient events).
- **An entity in another store is forwarded.** `j.entity(kind, table, { events: log })` with a log that cannot join the transaction: the write commits a `forward` job, and the worker appends the events after the commit, one stream per entity, in version order. Why: the row is the truth and the log lags. History verbs throw `FORWARD_PENDING` until the job ran, taps are refused, and an effect may run before the log has its event. Check an adapter with `eventLogContract` from `@arki/journal/event-log-contract`.
- **Changing an entity's `events` is a migration.** Pause the kind's writes, drain its forward jobs, `journal.copyLog(db, entity, { to })`, flip the setting, then `reset` the async projections that read it. Why: a new log starts at version 0 while the row is at N, so the first forward job would wait forever, and a switch back to `'stored'` leaves a gap. The events of another Postgres database come from `postgresEvents` in `@arki/journal/postgres`, with `eventLogTables()` migrated there.
- **A KurrentDB entity's kind has no `-`, and its events cannot be forgotten.** `kurrentEvents` from `@arki/journal/kurrentdb` names a stream `<kind>-<entityId>`. Why: KurrentDB reads a stream's category up to the first `-`, and it cannot rewrite an event, so `forget` throws `NO_HISTORY`. Event data must be a JSON object, array or string.
- **A command writes only what it declares.** Why: `writes` is read before boot, so a list that lies misleads everything that reads it. An undeclared event is a type error. A handler that gets past the types fails with `BAD_DEFINITION`, and nothing commits, even when it catches the error. The types do not catch an event that is declared and never written.
- **Pass the id exactly as it is stored.** Why: the log compares ids as exact strings. A second spelling would split one history in two. The write fails with `ID_MISMATCH`.
- **A reducer sets every column that a later reducer reads.** Why: database defaults are not in the log, so replay does not see them.
- **For a new meaning, add a new event type.** Why: `replay` and `repair` use today's reducers on old events.

## Errors

Journal ID generation uses `@arki/contracts` declarations with the existing prefixes and 24-character bodies. `jobId`, writes, adopt, drain and job operation verbs return the exact `IdGenerationFailure` union. Commands and workflow doors include it through `COMMAND_FAILURES`; return refusals from handlers so the owning transaction rolls back. Workers log a refused claim without leasing or acknowledging a job. Webhook subscribe, dispatch and replay preserve these failures, and dispatch rolls back its message and jobs together.

Command runners infer domain refusals plus `CommandFailure`, derived from `COMMAND_FAILURES`. See the [upgrade guide](../README.md#upgrading-command-and-durable-job-outcomes) for receipt, callback and durable-worker migrations. A throw in an effect or a step is retried by its `retry`, or the default (8 tries), as in `@arki/queue`; the `while` judges the error that was thrown, as is. A returned failure is final, unless that `while` accepts the exact failure value.

Two kinds of error have a code.

- A `JournalError` is the library's own failure. It is about one entity's row or history. It has `code`, `kind` and `entityId`. Its codes are in the table below.
- A rule of the app that rejects a request returns a failure. Receipt key mismatches also return `CommandConflict`; unexpected command callback exceptions return `TransactionDefect` with a private cause; effect/workflow bodies return `UnexpectedDefect`. Stranded workflow jobs persist `WorkflowStranded`. The journal's four are in [Rejected rules](#rejected-rules).

This is the only copy of this table. The workflow and job codes have their own tables, in [Workflow errors](#workflow-errors) and the README. The message texts are in `src/errors.ts`. An error thrown by an effect never reaches the caller: `drain` stores it on the job row.

| Code               | What it means                                                                                                                                                                                                                                                                                                                   | Usual cause                                                                                                                                                                                                         | What to do                                                                                                                                                                             | Thrown in                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `CONFLICT`         | The row and its event history cannot accept this write. The caller's `expectedVersion` is stale, another writer appended first, a row insert hit a unique constraint (a lost create race, a taken column value), or the row is missing or behind while its log says otherwise.                                                  | Two requests wrote the same entity at the same time. Or someone deleted the row by hand.                                                                                                                            | After a concurrent append, run the command again on the current state. When the row and the history disagree, check with `verify`, and use `repair` only when the history is complete. | `src/write.ts`, `src/store.ts`, `src/history.ts`                                |
| `NO_ROW`           | No row exists, and the event has no `.create` reducer.                                                                                                                                                                                                                                                                          | A wrong id, or the entity was deleted, and `events` did not check for a missing row.                                                                                                                                | Create the entity first, or declare `.create` for the event.                                                                                                                           | `src/write.ts`, `src/fold.ts`                                                   |
| `ROW_EXISTS`       | A row exists, and the event has no `.on` reducer.                                                                                                                                                                                                                                                                               | A create event was written twice for one id.                                                                                                                                                                        | Write an update event, or declare `.on` for the event.                                                                                                                                 | `src/write.ts`, `src/fold.ts`                                                   |
| `UNKNOWN_EVENT`    | The entity does not declare the event.                                                                                                                                                                                                                                                                                          | A hand-built `{ type, data }`, or an event that belongs to another entity.                                                                                                                                          | Add `.create` or `.on` for it on this entity, or write it to the entity that declares it.                                                                                              | `src/write.ts`, `src/fold.ts`                                                   |
| `VERSION_MISMATCH` | When saving, no row matched the version this write locked.                                                                                                                                                                                                                                                                      | A direct update or delete of the entity row inside `events`.                                                                                                                                                        | Look for a statement that changes the row version or removes the row outside the journal, for example a direct update inside `events`. Then run the command again.                     | `src/write.ts`                                                                  |
| `NO_HISTORY`       | The log has no complete history from version 1. The row existed before the journal, events are missing, or the entity is declared `events: 'transient'` and keeps none.                                                                                                                                                         | The row came from a seed or an old migration, not from a create event. Or a history verb was called on a transient entity.                                                                                          | `replay`, `verify` and `repair` cannot rebuild this row. Check how the row was created, or restore the missing events. For a transient entity, none of these verbs apply.              | `src/history.ts`, `src/write.ts`                                                |
| `FORWARD_PENDING`  | A forward job for this entity still waits, so its event log is behind the row. `replay`, `verify`, `repair` and `forget` throw it, and `cancel` and `discard` refuse a forward job whose events the log does not have.                                                                                                          | The worker has not run yet, the job is dead, or its log is down.                                                                                                                                                    | Run the worker, or `retry` the dead job. Call again once `forwardLag` shows nothing pending.                                                                                           | `src/history.ts`, `src/outbox.ts`                                               |
| `FORWARD_DIVERGED` | The event log holds other events at the versions a forward job carries. The job dies at once and the jobs after it in its stream wait.                                                                                                                                                                                          | Something other than this journal wrote to the log.                                                                                                                                                                 | Find the writer. `discard` the job, then `repair` the row from the log; or remove the foreign events and `retry`.                                                                      | `src/worker.ts`                                                                 |
| `HISTORY_GAP`      | The log has a hole (a version between 1 and the top is missing), or the stored row is at a higher version than the log's top while the log says the entity is alive. `replay`, `verify` and `repair` throw it. A row over a log that ends in a delete is not a gap: it was placed outside the journal, and `repair` removes it. | An event row was deleted by hand, or lost in a restore from backup.                                                                                                                                                 | Restore the missing event from a backup, or accept the row as it is. Replay and repair refuse to build a row the real history never produced.                                          | `src/history.ts`                                                                |
| `REPLAY_FAILED`    | A stored event cannot be decoded or applied: its type is not declared, its data or `meta` does not fit the current schema, or no reducer fits it. `replay`, `verify`, `repair` and `rerun` throw it. `drain` records it on the job.                                                                                             | An event type was renamed or removed, or its schema was made stricter, after events were stored.                                                                                                                    | Check the event schema and the reducers against the stored history.                                                                                                                    | `src/history.ts`, `src/fold.ts`                                                 |
| `UNSTABLE_SCHEMA`  | Event data or `meta` changes, or fails, across JSON storage and a second parse.                                                                                                                                                                                                                                                 | A `Date` or a transform in an event schema or in the `meta` schema.                                                                                                                                                 | Return JSON-compatible data that the schema accepts unchanged.                                                                                                                         | `src/storage.ts`                                                                |
| `ID_MISMATCH`      | The id is empty, malformed, too long, or spelled differently from the stored key.                                                                                                                                                                                                                                               | An upper-case `uuid`, an empty string, or an id longer than the key column.                                                                                                                                         | Pass the id exactly as stored. A `uuid` must be lower-case and hyphenated.                                                                                                             | `src/storage.ts`, `src/write.ts`                                                |
| `BAD_DEFINITION`   | A declaration is wrong. It is thrown when the declaring code runs (import time), before any data is touched. A command that writes an event outside its `writes` hits it at run time, and the run rolls back.                                                                                                                                                                                                                    | A bad event type, entity kind or effect name; a bad key column; `.create` after `.on`; a second reducer for one event; a need named `db`; two effects or projections with one name; a missing service in `compose`. | Fix the declaration the message names. The message text is the detail after the code.                                                                                                  | `src/id.ts`, `src/entity.ts`, `src/handlers.ts`, `src/journal.ts`, `src/dot.ts` |
| `VALUE_MISMATCH`   | The database stored a different value than the reducer produced. The write was rolled back.                                                                                                                                                                                                                                     | A `numeric` value with more decimals than the column keeps, such as `"1.234"` for `numeric(10,2)`.                                                                                                                  | Make the reducer produce the value in the form the column stores.                                                                                                                      | `src/storage.ts`                                                                |
| `IGNORED_FAILURE`  | A write's `events` or a child command returned a failure, and the command still returned a success. The run throws it and rolls back, so nothing the command did commits.                                                                                                                                                       | A handler that goes on after `await write(...)` or `await run(child, ...)` without checking the result. `Promise.all` over writes or runs, or a result kept in a variable and never checked.                        | Return that failure, or another: `if (isFailure(result)) return result;`. Handled on purpose: call `accept(result)` first. The message names the write or child and the code.          | `src/command.ts`                                                                |
| `INVALID_ACCEPT`   | `accept(x)` was called with a value it cannot mark as a handled refusal. The message says which case.                                                                                                                                                                                                                           | A value no `write` or `run` of this handler returned (hand-built, a copy, or one only the parent received), a second `accept` for one return, a late call, or a value that is not a failure.                        | Accept the very value `write` or `run` returned, once per return, before the handler returns.                                                                                          | `src/refusals.ts`                                                               |

### Rejected rules

A command handler, its `authorize` or an `events` function returns a failure from `@arki/failure` when a rule says no. The command's transaction rolls back exactly as for a throw, and `journal.run` returns the same failure instance; the type comes from the handler. An `events` failure comes back from `write` first: the handler returns it on (`if (isFailure(paid)) return paid;`). A child command's failure comes back from `context.run`: the child's savepoint is rolled back, and the parent returns it on. Once a write or a child returned a failure, the command is doomed: it must end with a failure, that one or another. A success then throws `IGNORED_FAILURE` and rolls everything back, so an ignored refusal never commits the rest. A handler that has a good answer anyway checks the value and calls `accept(x)` (`if (OutOfStock.is(stock)) { accept(stock); ... }`): that lifts only this command's check, one return of that very value at a time; the refused child's savepoint stays rolled back, and the success is stored as the receipt like any other. `accept` on a value this handler never received, twice on one return, after the handler finished, or on a non-failure throws `INVALID_ACCEPT`. An effect that ignores a failure from `ctx.run` and returns a success fails its job with that failure, dead after one try by default; an effect may `accept` it the same way. A failure is never stored as an idempotency receipt. The journal has four, each with data `{ detail }`, the message written for the client (`message` is `detail`). An app may return its own `defineFailure` values too.

| Failure            | Code                | HTTP | Use it when                                                                  |
| ------------------ | ------------------- | ---- | ---------------------------------------------------------------------------- |
| `CommandNotFound`  | `journal.not_found` | 404  | The thing the request names does not exist.                                  |
| `CommandInvalid`   | `journal.invalid`   | 400  | The input has the right shape, but a rule refuses it. An end before a start. |
| `CommandForbidden` | `journal.forbidden` | 403  | This actor may not do this to this entity.                                   |
| `CommandConflict`  | `journal.conflict`  | 409  | The current state does not allow it. Already paid. A name that is taken.     |

`@arki/journal/orpc` maps these for an oRPC app. The code is in `src/orpc.ts`. `@orpc/server` is an optional peer, and the core entry never imports it.

- `toORPCError(error)` turns a failure into the `ORPCError` with its code, status, message and data. That is what `orThrowRpc` from `@arki/failure/orpc` throws for a failure the contract does not list (`defined: false`). List them with `errorMap(CommandNotFound, ...)` in the contract and call `orThrowRpc(result, errors)` in the procedure, and the client gets them typed (`defined: true`). A contract that ships to the browser imports the failures and `COMMAND_FAILURES` from `@arki/journal/contract`: the root entry pulls in Drizzle.
- It turns a `JournalError` with code `CONFLICT` into an `ORPCError('CONFLICT')` with the message `This was changed by another request. Reload the current state and try again.` The client reloads first: with an `expectedVersion`, the same request fails again.
- It returns every other error unchanged.
- `commandErrors()` is the same mapping as a middleware. It also answers a failure the procedure returns as an error, never as a success. A procedure with an output schema fails output validation on a failure first, so it uses `orThrowRpc`. Put it after the app's own error middleware: `os.use(appErrors).use(commandErrors())`. Put before it, the app's middleware sees a plain error first and answers 500.

### Dot boot errors

- `ARKI_JOURNAL_PLUGIN_E001`, a `DotUnitError`: a feature lists a `journal` contribution that `journalHandlers` did not make. Declare its reactions with `journalHandlers(core, { effects, taps, workflows })` in `.usecases(...)`, and its projections with `journalProjections(...)` in `.infra(...)`.
- `journal: duplicate effect name "x" (features "orders" and "billing")`: two features list a handler with the same name. Rename one. Projections get the same message with `projection`.
- `journal: effect "x" needs "mailer", but no service with that name was given; ...`: thrown by `j.compose` in a plain app, and at the boot of the feature that lists the effect in a Dot app. A journal composed with `services: 'worker'` throws it from `worker` or `drain` instead. Plain app: add `mailer` to `services` in `j.compose`. Dot app: give the feature that lists the effect a need (not `entrypointOnly`), an infra service or a domain service with that name, and pick it with `needsOf`.
- Job verbs throw a `JournalError` with `JOB_NOT_DEAD`, `JOB_NOT_PENDING`, `JOB_RUNNING`, `JOB_EXISTS` or `BAD_ARGUMENT` (a bad limit, cursor, actor or purge bound).
- `journal: effect "x" has a need named "db", ...`: thrown by `j.effect`. The names `jobId`, `signal`, `db` and `run` are taken. Give the need another name.

## Recovery verbs

| Verb                                             | Takes                              | Returns                                                                        | When to use it                                                                                                                                                                              |
| ------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adopt(tx, entity, id, { meta, events })`        | A transaction                      | `{ row, events }` as `write` returns.                                          | Once per row with no history (it existed before the journal, or its entity was transient), at any version, before its first write. `events(row)` returns one create event whose `.create` reducer rebuilds the stored row exactly; it becomes version 1, and so does the row. |
| `forget(db, entity, id)`                         | A database or a transaction        | `{ erased, row }`: how many events were rewritten, and the repaired row.       | To remove personal data from one entity's history. Events with an `erased` form are rewritten to it and stamped; the row is repaired to match. Read models are the app's to forget.         |
| `replay(db, entity, id, { throughVersion })`     | A database or a transaction        | `{ row, events }`: the reducer row built in memory, or `null`, and its events. | To see what the log says about one entity. It writes nothing.                                                                                                                               |
| `verify(db, entity, id)`                         | A database or a transaction        | `{ ok: true }`, or `{ ok: false, expected, actual }`.                          | To check one stored row against its log. It compares only the columns that reducers set.                                                                                                    |
| `repair(db, entity, id)`                         | A database or a transaction        | The stored row after the repair, or `null`.                                    | The row is wrong and the history is complete. It writes no event, runs no projection and creates no job.                                                                                    |
| `rerun(db, projection, { after, batchSize })`    | A database that opens transactions | `{ events }`: how many events it handled.                                      | To fill a new read model or rebuild a lost one. Every handler runs again, so empty a counting read model first.                                                                             |
| `drain(db, { batchSize, signal, services })`     | The root database only             | How many jobs it claimed.                                                      | To run one batch of due jobs by hand, in a test or a script. The worker calls it in a loop.                                                                                                 |

## Workflows

A workflow is a list of steps that survives process death. Each node runs as a `workflow.step` job. Its checkpoint (the result, and the next node scheduled) commits in one transaction. The [README, Workflows](../README.md#workflows) has the API and an example that runs. This section has the rules, the error codes and the traps.

### Pick the tool

| The work                                                       | Use                                        |
| -------------------------------------------------------------- | ------------------------------------------ |
| One durable unit of work (send, call, summarize), retried      | `j.task` (a workflow of one step)          |
| Must survive a restart, or waits hours or days (signal, sleep) | `j.workflow` (this section)                |
| A loop of steps inside one request or one job, in memory       | `createFlow` from `@arki/ai`. Not durable. |
| One reaction to one event, after commit, that reaches out      | `j.effect`                                 |
| An event must run a command                                    | `j.task` or `j.workflow` with `startOn`    |
| One command in a workflow that must commit exactly once        | `.command` node                            |

### Rules

1. **The step body owns idempotency.** A step runs at least once: a crash after the provider answered and before the checkpoint runs it again. Pass `ctx.key` to the provider as its idempotency key, or look up first and act only when the work is not done. Never make a new random key inside the body: the re-run would send another one.
2. **Compose workflows once per `initJournal()`.** Pass every definition, and every workflow a `child` or `map` node starts, to one `compose({ workflows, workflowMeta })`. `workflowMeta` is required; it is the meta of the runner's own checkpoints, such as `{ actorId: 'system:workflow' }`. A body's `ctx.run(command, input)` without a meta records it too, so a library workflow that is generic over the app's meta needs no meta of its own. Pass a meta as the third argument to record another actor. An effect's `ctx.run` still requires the meta.
3. **A changed node list is a new version.** Adding, removing, renaming or reordering nodes needs a higher `version`. Keep the old definition registered until `journal.workflows.counts(db)` shows no unfinished run of it. Bump the version for a changed meaning too: the shape check sees node names, not what a body does.
4. **Start the newest version.** `def.start` of an older registered version throws `WORKFLOW_VERSION_RETIRED`. Export one name for the newest definition and start runs through it.
5. **Throw to retry, return a failure to stop.** A thrown error retries with the step's `retry`, or the default (8 tries, 1 s up to 5 min). The step's error records it as `UnexpectedDefect`; the `while` gets the error the body threw, as is: `retry: backoff.exponential({ base: 1000 }).upTo(7).while(reason => reason instanceof TransientError)`. A returned failure kills the step at once, unless that `while` accepts it. A dead step follows `onDeadStep`: `'wait'` (default) leaves it for an operator, `'compensate'` undoes the run.
6. **Values are small JSON.** Inputs, results, payloads and the output must come back from JSON unchanged (no `Date`, no class instance) and stay under `limits.payload` (65 536 bytes). Return an id, not the document.
7. **Give `output` to a step an operator may resolve.** `resolveStep` checks the result with it. A step without `output` can only be retried.
8. **Signals carry the sender's id.** `deliveryId` is the webhook event id or another id the sender repeats on a resend. A repeat returns `duplicate` and changes nothing. `def.signal` returns `kept`, `woke`, `duplicate`, `finished` or `no-run`. `no-run` means no run of that workflow has the id (or it belongs to another workflow): nothing is stored. Webhook trap: do not throw on `no-run` or `finished`. A throw becomes a 500 and the provider resends forever, so answer 200. Only `journal.workflows.signal` (the operator verb) refuses an unknown run. One signal name has one payload schema in a workflow.
9. **Move a run with the workflow verbs.** `journal.workflows.retryStep`, `resolveStep`, `skipUndo`, `signal`, `cancel`, `reschedule`, or the Foreman module. The raw job verbs refuse workflow jobs.
10. **Report progress through the run's metadata.** In a step or an undo: `await ctx.metadata.set(patch)`, `increment(key, by?)`, `append(key, value)`, `remove(key)`, and `await ctx.tags.add(...tags)`. Each call commits at once as one event (`MetadataChanged`, `RunTagged`), so a reader sees it while the step runs. A call never rejects, so a progress report may be left un-awaited. A refusal (`CommandConflict` for a finished run, `CommandInvalid` for a wrong value type, over 256 KiB or over 10 tags) is the returned value: it does not fail the step and needs no `accept`. A retried attempt repeats its calls, so `increment` and `append` are at-least-once; prefer `set` with an absolute value when a count must be exact. From outside a run: `journal.workflows.setMetadata(db, { runId, change }, op)` and `addTags(db, { runId, tags }, op)`.

11. **Time a start with `delay` and `ttl`, never with a sleep node first.** `def.start({ input, delay: '10m', ttl: '1h' })`: the first node is due 10 minutes later (`delayedUntil` on the readers until then), and if no worker has started it within an hour of that, the run ends `expired` without running. `delay` also takes a `Date`. The deadline counts from the planned start. `journal.workflows.reschedule(db, { runId, delay } | { runId, at }, op)` moves a start that has not happened (`CommandConflict` after). Children take neither.
12. **A one-step job is a task.** `j.task(name, { version, input, output?, retry?, timeout?, undo?, key?, ... }, run)` is `j.workflow(name, options).step('run', run, { retry, timeout, undo, key }).finish()`. It is a `WorkflowDef`: compose it, start it, use it as a `child`, version it like any workflow. Its one node is named `run`, so `results.run` holds the output and `retryStep` takes `path: 'run'`. When it grows a second step, rewrite it as `j.workflow` under the same name with a higher `version`: the node list changed.
13. **Fan out with `def.startBatch`, not a loop of starts.** `startBatch({ items, batchId? })` starts up to `BATCH_LIMIT` (1000) runs in one transaction and returns `{ batchId, runs }`, one outcome per item in order. A busy or taken item is its own refusal and the others still start; check each `runs[i]`. A malformed item refuses the whole batch with `InvalidInput`. Watch it with `journal.workflows.batch(db, batchId)`.
14. **Rerun after a fix with `journal.workflows.replay(db, { runId, overrides? }, op)`.** It starts a new run (new id, `replayOf` = the old id) at the newest version, with the old input, `scope`, `tags` and `metadata` unless `overrides` replaces them. It does not retry the old run: use `retryStep` to continue a run where it died. The newest input schema must still take the old input (`InvalidInput` if not), and the concurrency gate applies.
15. **React to a run's end with `on`, not with an effect on `workflow.run`.** `on: { success, failure, cancel, expired, complete }` in `j.workflow` or `j.task` options. Each hook is a durable job (`workflow.on`) queued in the transaction that ends the run: it runs after that commit, at least once, with the code of the run's own version. A throw retries, a returned failure is final, and nothing a hook does changes the run. `success` gets `ctx.output` typed by the `output` schema (`unknown` without one), `failure` gets `ctx.error`, `complete` runs after the specific one for every end. Hooks get the definition's `needs` and a `ctx.run` that records `workflowMeta`. Make a hook idempotent with `ctx.jobId`.
16. **Wrap every step with `journal.hooks.step.around((ctx, next) => ...)`.** `ctx` is `{ workflow, version, runId, step, attempt, phase }`: no input, no results. It wraps each body and undo inside the `journal.step` span, and is frozen by the first drain or worker.
17. **Narrow one run with `maxAttempts`, `timeout` and `priority` at start, not with a second workflow.** `def.start({ input, maxAttempts: 2, timeout: '5m', priority: 10 })` (also on each `startBatch` item and in `replay` overrides). `maxAttempts` caps the tries of every step of the run, `timeout` each step attempt, and `priority` orders the run's step and timer jobs among due jobs (the scale of an effect's `priority`). They only narrow the step's own `retry` and `timeout`, never loosen them. A child does not inherit them. Bad values are `InvalidInput`.
18. **Share a cap across workflows with `j.limit`, and change it with `journal.limits`, not with a deploy.** `const uploads = j.limit({ name: 'uploads', total: 3, perKey: 1 })`, then `concurrency: { key, shared: [uploads], onBusy }` in each workflow (at most two shared limits). `limit` (per key, needs `key`) and `total` are the workflow's own limit, `workflow/<name>`. A start needs room in every limit it holds; `join` answers only a full own `limit`. An operator overrides values (`override`, `reset`, one key for up to 30 days, `perKey: 0` blocks a key) and stops new runs with `pause` (running runs finish; works on `workflow/<name>` without `concurrency` too). Each verb is an event on `journal.limit` that names the operator; an unknown name is `CommandNotFound`.
19. **Wait for a slot with `onBusy: 'queue'`, not with a caller that retries `WorkflowBusy`.** A busy start (any full or paused limit, a top run or a child) creates the run in the state `queued` and returns its `{ runId }`; it schedules no node and holds no slot. When a run that held the limit ends, an operator raises, resets or resumes it, or a key override runs out, the oldest queued runs that now fit start in that same transaction (FIFO per key, at most `LIMIT_BOUNDS.promoteTries` checked per change). A queued run past its `ttl` ends `expired` without running; `cancel` ends it `cancelled` at once; `reschedule` moves its `start_at`. `journal.limits.get` shows `queued` next to `running`.
20. **An effect runs no command.** Its context has no `run`. An event that must run a command starts a task or a workflow. The system actor stays explicit: `run(cmd, input, { actorId: 'system' })`.
21. **`startOn.timing` is required.** `'after-commit'` writes a job that starts the run. `'with-event'` writes the run in the event's transaction, so a rollback removes it and a read after the commit finds it. No body runs inline. It never refuses, so `onBusy: 'refuse'` is a type error; a paused limit queues the run.
22. **A `.command` node is the one exactly-once node.** `.command(name, command, ({ input, results }) => commandInput, { accept?, undo?, when?, retry? })` runs the command as a savepoint inside the checkpoint's transaction. Give the command an `output` schema: the node stores it, and without one the result is `null`. A refused command rolls back and the failure transition commits. `accept` names failures the run goes on from. `undo` runs in compensation, once, in reverse order, and is skipped for an accepted failure.

### Task: add a workflow

1. Declare it next to its feature: `j.workflow('<area>.<verb>', { version: 1, input, output?, needs? })`, then the nodes, then `.finish()`. Give each step that calls an outside system an `undo` if its work can be undone.
2. List it in `compose({ workflows, workflowMeta, services })`, or in a Dot app in the feature's `.usecases({}, journalHandlers(core, { workflows }))`, its needs picked with `needsOf((_: Deps) => keys)`.
3. Start it from a procedure or an effect: `context.run(def.start, { id?, input, scope?, tags?, metadata? })`. Give an `id` from the business key (`refund:<orderId>`) when a retry of the request must not start a second run. Give `scope` the tenant key (an org or user id): children inherit it, and `journal.workflows.runs(db, { scope })` finds the tenant's runs. `tags` (max 10, 1-128 chars) and `metadata` (a JSON object, max 256 KiB) are for finding and describing runs; children do not inherit them. When an event starts it, declare `startOn: { entity, event, id, input }` on the workflow instead of writing the effect: the runner owns it (`workflow.start:<name>`), writes its job in the event's transaction, starts with `workflowMeta`, and starts nothing for an id that already has a run.
4. Deliver outside events with `def.signal(name)`, and read runs with `def.read(db, runId)`.
5. Test it with `workflowHarness` from `@arki/journal/testing`: `tick` and `tickTo` for timers and deadlines, `dueJobs` and `release` to run jobs one by one, `crash` for restarts. `workflowHarnessOn(db, { setup })` runs on a real Postgres, for races.

23. **Wait for an event of the app with `.waitFor(name, { on })`, not with an effect that forwards a signal.** `on: { [label]: { entity, events: [A, B], match: ({ input, results }) => id, where? } }`, with `timeout` or `until`, and `onTimeout`. The result is `{ via: label, event }`; narrowing `event.type` types `data`. With `onTimeout: 'continue'` a deadline gives `null`, so a wait doubles as a sleep an event cuts short. The wake is mounted for you (`workflow.wake:<entity kind>`). Signals stay for senders outside the app.
24. **Loop with `next`, on a step or on a `sleep`.** A wait has no `next`: put a step after it. `when` on that step plus `next: 'due'` reads better than a check in its body, because a skipped step ignores `next`.

### Traps

- **One compose per `initJournal()`.** A second compose with workflows on the same `j` throws `BAD_DEFINITION`. A test that composes twice builds a new `initJournal()` each time. A deploy is a new process, so it runs `initJournal()` again.
- **`JOB_MANAGED` on the raw job verbs.** `journal.retry`, `discard` and `cancel` refuse a job with a `run_id`. A raw retry would skip the run's own transitions. Use `journal.workflows.retryStep`.
- **An un-awaited metadata call may land after the step's checkpoint.** It is safe (no rejection, no change to the step), but its result is not in the step's output, and on a finished run it is refused. Await it when the change must happen before the next step.
- **The step body owns idempotency.** The journal never dedupes the outside call for you. `LEASE_LOST` stops a stale worker's checkpoint, not its provider call.
- **A transforming input schema makes `def.read` refuse.** The run stores the input schema's output. `def.read` checks the stored value with the same schema. A schema whose output is not a valid input (`z.string().transform(Number)` stores a number, and the string schema refuses it) fails, and `def.read` returns `WorkflowReadMismatch`. Read such runs with `journal.workflows.run`, or keep input schemas free of transforms.
- **A skipped wait is `null`.** A `waitFor` whose `when` returns false is skipped with cause `when`, does not park, and stores `null`, like a skipped step. A dropped wait (next trap) stores nothing.
- **A dropped wait has no result.** When a run starts compensating (cancel, deadline, `onDeadStep: 'compensate'`) while parked on a `waitFor` or `sleep`, that node is skipped with cause `compensating`. It leaves no key in `results`. `def.read` types results as optional for this reason: check `'settled' in results` or `results.settled !== undefined`, never assume `null`.
- **A missing service in a plain `compose`** is a compile error for a workflow step, as for an effect, and `compose` throws `BAD_DEFINITION` naming the workflow and the need. In Dot, `needsOf((_: Deps) => keys)` and `journalHandlers(core, …)` make it a compile error.
- **A wait counts from admission, not from the park.** An event since the run's `startOn` event, or since its `RunStarted`, is taken when the run arrives, with no park at all. A run that must only see later events needs a `where`.
- **A revisit reads on from what that wait last took.** A deadline moves no cursor, so an event between two rounds is kept for the next. An event `where` refused and a later one was taken over is gone for that wait.
- **One event is taken once per run.** Two waits in a row for one type need two events. The first reads it, the second sees it as taken.
- **`where` runs again.** It runs on the park, on each wake and on the timer, so it must decide from its arguments alone.
- **A loop has a cap, `limits.transitions` (1000 by default).** A transition is the first try of a node: each visit of a node in a loop, and each node a `when` skips. A retry and an undo are not. Count `nodes in the loop * rounds`, plus the nodes outside it, and set the cap above that (the prayer reminder sets `50_000`). A node that would pass the cap does not run: the run compensates and ends `failed` with the failure `WorkflowTransitionLimit`, whatever `onDeadStep` says. The count is `workflow_runs.transitions`, so it survives a restart.
- **A wait stores a pointer to the event, not a copy.** The node's result is `{ via, seq }` in `workflow_runs.results`, `workflow_steps.result` and the run's events. Bodies, `def.read` and the operator views read the event from `journal_events`. So `forget(db, entity, id)` reaches every run that took the entity's events, parked, running or finished: an event with an `erased` form reads in that form. What a body derives from the event (a step result, the output) is the workflow's own data and `forget` does not rewrite it.
- **`workflow.wake:<entity kind>` queues a job for every event of a watched type,** with a run waiting or not. Watch the rare events of a busy entity.
- **Only the highest version may declare `startOn`.** When you add v2, move `startOn` from v1 to v2. A lower version with `startOn` makes `compose` throw `BAD_DEFINITION`. A `startOn` whose entity does not record its event throws `BAD_DEFINITION` when the workflow is defined.
- **`def.start` throws for code it does not know.** A definition that no compose registered throws `WORKFLOW_UNKNOWN`; an older version throws `WORKFLOW_VERSION_RETIRED`. Both are bugs in the app, not refusals, so they are thrown.
- **`queued` is an unfinished state that holds no slot.** Code that counts the runs that hold a limit must leave `queued` out; code that lists the live states (`running`, `parked`) to stop or cancel a run must take `queued` in. A queued run has no node, no step row and no job but its ttl timer.
- **`expired` is a stored end state.** Code that lists end states (`completed`, `failed`, `cancelled`) must handle `expired` too: `RUN_STATES` has it, retention has `workflows.expired` (default: the `failed` time), and an expired run has no node results.
- **After `h.crash()` in a test,** read `h.journal` and the definitions from the harness again. The old objects belong to the dead runtime.

### Workflow errors

The workflow codes are `JournalError` codes, thrown, unless the row says returned. Match on `error.code`.

| Code                        | What it means                                                                                                                                                                                                       | What to do                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `WORKFLOW_UNKNOWN`          | No registered workflow has this name and version.                                                                                                                                                                   | Pass the definition to `compose({ workflows })` in every process that starts or runs it. Keep old versions until their runs end. |
| `WORKFLOW_VERSION_RETIRED`  | `def.start` of an older version while a newer one is registered.                                                                                                                                                    | Start the newest definition. The older one only finishes its runs.                                                               |
| `WORKFLOW_SHAPE_CHANGED`    | The registered definition has other nodes than the run started with.                                                                                                                                                | Bump `version` for a changed node list. Put the old definition back to let its runs finish.                                      |
| `WORKFLOW_LIMIT`            | A value is larger than `limits.payload`, or a run nests too deep. At start it is a returned `CommandConflict`.                                                                                                      | Store the data elsewhere and keep a reference, or raise `limits.payload`.                                                        |
| `STEP_TIMEOUT`              | A step ran longer than its `timeout`. The step fails and follows its `retry`.                                                                                                                                       | Raise `timeout`, or stop the body when `ctx.signal` aborts.                                                                      |
| `LEASE_LOST`                | This worker no longer holds the step's job. Nothing was written.                                                                                                                                                    | Nothing in app code. The new owner runs the step. Make the body idempotent (rule 1).                                             |
| `WORKFLOW_NOT_FOUND`        | No run has this id.                                                                                                                                                                                                 | Check the id, and that retention did not prune the finished run.                                                                 |
| `WORKFLOW_FINISHED`         | The run is completed, failed or cancelled.                                                                                                                                                                          | Start a new run. A finished run is history.                                                                                      |
| `WORKFLOW_COMPENSATING`     | The run is undoing its work, so the verb does not apply.                                                                                                                                                            | Wait, or fix the failed undo with `retryStep` (phase `undo`) or `skipUndo`.                                                      |
| `STEP_NOT_DEAD`             | The step is not dead, so there is nothing to retry or skip.                                                                                                                                                         | Read the run (`journal.workflows.run`) and pick a step with status `failed`.                                                     |
| `STEP_NOT_RESOLVABLE`       | The step has no `output` schema, is not a `do` step, or the run is not running.                                                                                                                                     | Use `retryStep`, or add `output` to the step in a new version.                                                                   |
| `JOB_MANAGED`               | A raw job verb was used on a workflow's job.                                                                                                                                                                        | Use the `journal.workflows` verbs.                                                                                               |
| `journal.workflow_transition_limit` | The failure `WorkflowTransitionLimit`, the error of a run that would pass `limits.transitions`. The run compensated and ended `failed`; the node that would pass the cap did not run. `data.limit` and `data.transitions` say the cap and the count. | Find why the run loops, or raise `limits.transitions` when the loop is as long as the work needs. |
| `WORKFLOW_READ_MISMATCH`    | Returned by `def.read` as the failure `WorkflowReadMismatch` (`journal.workflow_read_mismatch`): a stored value no longer fits its schema. `data.field` names it.                                                   | Read untyped with `journal.workflows.run`; widen the schema to take what older runs stored.                                      |
| `journal.workflow_busy` | The failure `WorkflowBusy`, from `def.start` when a limit it holds is full (`concurrency.limit` per key, `total`, or a shared `j.limit`) and `onBusy` is `'refuse'` or cannot join, when an operator paused it, or from any busy child start. `data.limitName` and `data.reason` (`'full'`, `'paused'`) say which and why; `data.key` is the start's concurrency key (`null` without one); `data.running` lists the caller's own runs that hold it. | Wait for a run to end, start with another key, or have an operator raise or resume the limit (`journal.limits`). `onBusy: 'join'` answers the running run when the own per-key limit is full. |
| `journal.workflow_stranded` | The failure `WorkflowStranded`, stored on the job of a stranded run (`data.reason` is `WORKFLOW_UNKNOWN` or `WORKFLOW_SHAPE_CHANGED`).                                                                              | Restore the run's version with its original nodes, then `retryStep`.                                                             |
| `BAD_DEFINITION`            | A wrong definition: a duplicate node name, a `next` that is not earlier, a second compose, a missing `workflowMeta`, an unregistered child, a missing service, `'untilExported'` or `max` in `retention.workflows`, a `startOn` on a lower version or with an event its entity does not record, a wait on an event its entity does not record or on an entity that keeps no events in `journal_events`, a wait with both `timeout` and `until`. | Fix what the message names. It is thrown when the code loads or composes.                                                        |

The Foreman module answers its refusals with `ARKI_JOURNAL_E010` to `E017` (`JOURNAL_WORKFLOWS_ERROR_CODES` in `src/foreman/workflows.ts`): `staleRevision` (refresh the preview), `finished`, `stepNotDead`, `badSignal` (a signal or payload the run's version does not take), `compensating`, `stepNotResolvable`, `notFound` and `stranded`. Each code's `@fix` there says what to do.

## Dot

`@arki/journal/dot` exports the infra unit `journal(...)` (for `.infra()`), the only entrypoint `journalWorker(...)` (for `.entrypoints()`), the projections unit `journalProjections(...)` (for a feature's `.infra()`), the application contribution `journalHandlers(core, …)` (for a feature's `.usecases()`) and `needsOf((_: Deps) => keys)`. The code is in `src/dot.ts`.

| Question                   | Plain app                                             | Dot app                                                                                                     |
| -------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Where handlers are listed  | One `journal.root.ts` calls `j.compose(...)`.         | Each feature: `journalProjections(...)` in `.infra()`, `journalHandlers(core, …)` in `.usecases()`.          |
| Who builds the journal     | Your code.                                            | `journal({ j, workflowMeta? })`, from the mounted features. It publishes `services.journal`.                |
| Who runs the worker        | Your code: `journal.worker(db)`, `start()`, `stop()`. | `.entrypoints(journalWorker())`, between `start` and `stop`. A process without it runs no jobs.             |
| What an effect needs       | `services` in `j.compose(...)`, once for the app.     | `needsOf((_: Deps) => keys)`: the feature's needs (never `entrypointOnly`), private infra and domain services.      |
| Where workflows are listed | `j.compose({ workflows, workflowMeta })`.             | `journalHandlers(core, { workflows })`; `workflowMeta` on `journal(...)`.                                   |
| Where the door is bound    | The request context: `journal.bind(db, { actorId })`. | A procedure: `.use(actorRun(select))`, then `context.run(command, input)`. No command list.                 |

The code for both wirings is in the [README, Dot](../README.md#dot).

### Where each part lives in a feature

Application code is organised by business behaviour. A behaviour file in `usecases/` holds the decision (the command) and the reactions it owns: `usecases/place-order.ts` exports `placeOrder` and `sendReceipt`.

| Part                                   | Lives in                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------- |
| Event schemas, entity state and fold   | `model/`                                                                    |
| Commands and the reactions they own    | `usecases/<behaviour>.ts`, mounted with `.usecases({}, journalHandlers(…))` |
| Read-model projections                 | `infra/`, mounted with `journalProjections(...)`                            |
| Transport                              | `entrypoints/`; a procedure calls `context.run(command, input)`             |

- A reaction that serves several behaviours gets its own business-named file in `usecases/`. A reaction that crosses features belongs to the consuming feature.
- One file assigns ownership. It never limits who subscribes, and it never implies one transaction.
- An effect is application code, not an entrypoint: entrypoint → command → event → effect. The outside actor enters once, at the entrypoint. An effect that runs a command names a system actor.
- `journalHandlers(...)` is never a `context.usecases` member, so a procedure cannot call an effect.
- A contract-first procedure answers a command with `orThrowCommand(context.run(command, input), errors)` from `@arki/journal/orpc`. The contract lists its business failures only.
- `dot explain --as journal-flow` prints, per event, the fold, the projections and the reactions, each with its timing, owner, deps and retry policy. `--json` gives one app-wide graph of `nodes` and typed `edges` (`folds`, `projects`, `reacts`, `owned-by`).

An effect runs a command with `ctx.run` in both wirings. The journal hands `run` to the effect when the job runs.

In feature mode the journal is built before the features, from their declarations, so a feature can need it. Effects and taps still need the features' booted services. The journal is therefore composed with `services: 'worker'`: a write only queues jobs and never needs those services. `journalHandlers` binds once at the feature's boot, to the feature's usecase-level deps, and checks each need there. `journalWorker()` reads each feature's bound services from its slice record and passes them to `journal.worker(db, { services })`, per effect, tap and workflow.

## Shared packages

This is the pattern to follow. No code in this repo uses it yet. A package that ships journal pieces exports a factory. The factory takes the app's `j` and the tables. It returns entities, commands, projections and effects. An effect that needs a service lists it with `need<T>()`, and the app gives the service in its own `j.compose({ services })`. The package never owns a database, a composed journal or a worker. The app adds the tables to its schema. It calls `billingJournal(j, billingTables())` and lists the returned handlers in its own `j.compose(...)`. `billingTables()` is the package's own table factory, shaped like `journalTables()`: it returns `{ invoices }`, a table with a string `id` and a `version` column.

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
export function billingJournal<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
>(j: JournalDefinitions<Meta, Tx, AppDb>, tables: ReturnType<typeof billingTables>) {
  const InvoiceIssued = j.event('InvoiceIssued', z.object({ amount: z.int().positive() }));
  const invoice = j.entity('invoice', tables.invoices).create(InvoiceIssued, e => ({ amount: e.data.amount }));
  const issueInvoice = j.command(
    'issueInvoice',
    z.object({ invoiceId: z.string().min(1), amount: z.int().positive() }),
    { writes: [InvoiceIssued] },
    (input, { write }) => write(invoice, input.invoiceId, () => [InvoiceIssued({ amount: input.amount })]),
  );
  const invoiceMail = j.effect(
    'invoice-mail',
    invoice,
    { sendInvoiceMail: need<(invoiceId: string, idempotencyKey: string) => Promise<void>>() },
    { InvoiceIssued: (e, { jobId, sendInvoiceMail }) => sendInvoiceMail(e.entityId, jobId) },
  );
  return { entities: { invoice }, events: { InvoiceIssued }, commands: { issueInvoice }, effects: { invoiceMail } };
}
```

## Do not clean these up

These look odd. Each one is needed.

- `ownHandler` with `Object.hasOwn` in `src/handlers.ts`: an event type named `toString` must not find a handler on the prototype.
- `bindEffect` in `src/handlers.ts` runs for every effect, also for one without needs, and a worker runs it again on every drain for a journal composed with `services: 'worker'`: it is the one place where a need gets its service and where a missing service is caught.
- `need<T>()` is the journal's own marker, not Dot's `service<T>()` or a unit handle such as `mailerInfra.provides.mailer`: the core must load and type-check without `@arki/dot`, and Dot keeps the key of its marker private.
- `needsOf` in `src/dot.ts` takes a selector `(deps: D) => keys`. `D` comes from the caller's annotation, which is `Deps` exported by `feature.ts` from the stage before `.usecases()`. After that call `DepsOf` is the entrypoints' view, with the `entrypointOnly` needs a reaction must never see. `journalHandlers` still takes `UsecaseCore` and checks the picked keys against it.
- The erasure seams in `needsOf`: the selector only carries the type and its argument is never read, so it is called with `undefined as never`; and `Object.fromEntries` types its keys as `string`, and each value is the empty phantom `need()` makes.
- `const E` on `compose` (`src/api.ts`) and `journalHandlers` (`src/dot.ts`): without it TypeScript reads `[plainEffect, effectWithNeeds]` as a list of plain effects, and a missing service is no longer a compile error.
- The module-scoped `WeakMap` in `src/transaction-guard.ts`: two journals on one transaction share its savepoint stack, so they must share this guard.
- `assertRoundTrips` in `src/storage.ts` uses `JSON.stringify`, not `structuredClone`: it checks what JSON storage does to the value.
- Delete, then insert, when a row is deleted and created again in one write (`src/write.ts`): columns the create leaves out must get their defaults, not the old values.
- `dbNowPlus` and every `now()` in `src/worker.ts`: lease and retry times use the database clock, because process clocks differ.
- A savepoint around every `write` and every child `run`: a failure the caller catches rolls back only that operation.
- `decodeStoredEvent` after the insert in `src/write.ts`: reducers and projections see the event exactly as replay will read it.
- `deepFreeze` in `src/storage.ts`: it is what makes events frozen.
- `definedOnly` in `src/entity.ts`: a patch key set to `undefined` means unchanged.
- `isUniqueViolation` in `src/write.ts` walks `cause` five levels deep: drivers wrap the Postgres error.
- `assertRootDb` in `src/storage.ts`: the type check alone cannot stop every transaction, so `drain` and `worker` also check at run time.
- No `.create` after the first `.on` (`OnOnlyEntityBuilder` in `src/entity.ts`): a later create could leave out a column that an `.on` reducer was promised.

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun run test:runtimes
bun ../../tooling/library/src/llms.ts --check
```

In an app that mounts the unit: the static graph, then the booted app's health.

```sh
dot explain --json | jq '.data'
dot doctor --json | jq '.data'
```

`dot explain` reads the manifest and starts nothing. `dot doctor` boots the app and disposes it.
