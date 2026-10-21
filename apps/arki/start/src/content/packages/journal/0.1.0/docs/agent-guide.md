# @arki/journal for agents

Read this file first. [`llms.txt`](../llms.txt) is the index. The [README](../README.md) is the long overview. `src/api.ts` defines every signature. If this guide and `src/api.ts` disagree, `src/api.ts` wins.

Paths that start with `src/` are files of this package. App files are named from the app's own source folder, for example `journal.root.ts` or `features/orders/effects.ts`. The app layout, with a "Which file do I touch" list, is in the [feature layout note](../../../apps/games-platform/backend/src/features/README.md) of the games-platform backend. Read it before you touch an app.

## The model

1. An entity is a normal row in its own Drizzle table. The table has a string key and a `version` column.
2. Every change is also one row in `journal_events`. Event rows are never changed or deleted.
3. One transaction writes the event rows and the entity row together.
4. A command is the way to write. `j.command` defines one. `journal.run` runs it. `journal.bind` is the door: it fixes the database and the actor once and returns a runner.
5. Inside a command, `write(entity, id, events)` locks the row and calls your `events` function with it. That function checks the rules and returns the new events.
6. A reducer turns each event into the next row. `.create` builds the first row. `.on` returns a patch.
7. Lane one is the projection. It runs inside the same transaction. If it throws, the write rolls back.
8. Lane two is the effect. The write adds a row to `journal_jobs`. A worker runs the handler after the commit, at least once.
9. Reads are plain Drizzle queries on the entity table.
10. Replay rebuilds a row from its events. It is for checks and repair only, never for reads.

## Three objects

| Object                | How you get it                                | What it does                                                                                                  | Where it lives in an app             |
| --------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `j`, the definitions  | `initJournal` (see Setup)                     | Declares things: `j.event`, `j.entity`, `j.command`, `j.projection`, `j.effect`. It never touches a database. | `journal.ts`                         |
| The entity builder    | `j.entity(kind, table)`                       | A chain of `.create(Event, reducer)` and `.on(Event, reducer)`. The result is the entity you pass to `write`. | `features/<name>/<entity>.ts`        |
| `journal`, the runner | `j.compose({ tables, projections, effects })` | Does the work: `run`, `bind`, `write`, `replay`, `verify`, `repair`, `rerun`, `drain`, `worker`, `wake`.      | `journal.root.ts`, or the Dot plugin |

How to tell them apart: only `journal` takes a database. Events, entities, commands, projections and effects need only `j`. They must never import the composed `journal`.

The word `create` has two meanings. Neither one builds the journal. `j.compose(...)` builds the journal.

| You see                                                | It means                                                          | Defined in       |
| ------------------------------------------------------ | ----------------------------------------------------------------- | ---------------- |
| `initJournal.tx<AppTx>().db<AppDb>().create({ meta })` | Finish the setup chain. Returns `j`.                              | `src/journal.ts` |
| `.create(Event, reducer)` on an entity builder         | Declare a create reducer. It builds the first row from the event. | `src/entity.ts`  |

## Setup

```ts
import { initJournal, need } from '@arki/journal';
import { journalTables } from '@arki/journal/pg';

// journal.ts: once per app. `meta` is the schema of the metadata every event records.
export const j = initJournal
  .tx<AppTx>()
  .db<AppDb>()
  .create({ meta: z.object({ actorId: z.string().min(1) }) });

// schema.ts: the two journal tables go into the app's schema and migrations.
export const tables = journalTables(); // or journalTables(pgSchema('app'))

// journal.root.ts: the one place that lists handlers.
// `services` gives each effect what it needs, by name.
export const journal = j.compose({ tables, projections: [customerStats], effects: [orderMail], services: { mailer } });
```

`.tx<AppTx>()` types `tx` in commands and projections. `.db<AppDb>()` types `db` in effects. Both steps are optional and type-only. `initJournal({ meta })` alone also returns `j`. `AppDb` is the app's Drizzle database type. `AppTx` is its transaction type: `Parameters<Parameters<AppDb['transaction']>[0]>[0]`.

## Task map

### Add an event and react in the same transaction

Library files: `src/entity.ts` (the builder and reducer types), `src/handlers.ts` (how a handler is found by event type).

1. In the entity file, declare the event with `j.event(type, schema)`. Event data is stored as JSON, so use no `Date` and no transform.
2. Add `.on(Event, reducer)` to the entity chain. The reducer returns only the columns that change.
3. In a command, return the event from the `events` function.
4. In the projections file, add a handler under the event's type. It gets `(tx, e)`. Use `tx` for every query.
5. A new projection must be listed: under `projections` in `journal.root.ts`, or in the feature's `journalHandlers` in a Dot app.

A full projection, `customerStats`, is in the [README example](../README.md#example).

### Add an entity with create and delete

Library files: `src/entity.ts` (the key column checks), `src/fold.ts` (how reducers are picked and applied).

1. Add the table. It needs a string key that is the primary key or unique, and `version: integer('version').notNull().default(0)`. Add the migration in the app.
2. The key column is `id`. For another column, name it: `j.entity('profile', profiles, { key: 'accountId' })`.
3. Write the chain. Every `.create` comes before the first `.on`.
4. To delete, return `null` from a reducer. The row is removed. The events stay. The entity can be created again later, and its version continues.
5. A soft delete is a normal patch, such as `{ status: 'cancelled' }`. The row stays. The library does nothing special for it.

```ts
export const order = j
  .entity('order', orders)
  .create(OrderPlaced, e => ({ customerId: e.data.customerId, total: e.data.total, status: 'placed' }))
  .on(OrderPaid, () => ({ status: 'paid' })) // a patch: only the columns that change
  .on(OrderCancelled, () => ({ status: 'cancelled' })) // soft delete: a normal patch, the row stays
  .on(OrderErased, () => null); // delete: null removes the row, the events stay
```

### Add an effect that runs after commit

Library files: `src/handlers.ts` (`effectFor` is `j.effect`, `need`, and `bindEffect`, which gives an effect its services), `src/worker.ts` (claims, retries, `drain`, the loop, `wake`), `src/journal.ts` (`createJournal` gives the worker `runOn`, which makes `ctx.run`).

```ts
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

// An effect that writes runs a command. It needs no closure over the journal.
export const closeAfterPayment = j.effect('close-after-payment', order, {
  OrderPaid: (e, { run }) => run(closeOrder, { orderId: e.entityId }, { actorId: 'system' }),
});
```

- The handler gets `(e, { jobId, signal, db, run })`. `db` is the root database given to `drain` or `worker`. Read committed rows with it.
- An effect that needs nothing has three arguments. An effect that needs a service has four: the third is `{ mailer: need<Mailer>() }`, with `need` from `@arki/journal`. The handler then reads `mailer` from its context, typed. Do not wrap an effect in a function to pass a service in.
- Where the service comes from: a plain app gives it once, in `j.compose({ ..., services: { mailer } })`. In a Dot app it is a service of the feature that lists the effect, and the feature declares it in `needs`. A missing service is a compile error. `j.compose` and the Dot boot also throw, and the message names the effect and the need.
- A need cannot be named `jobId`, `signal`, `db` or `run`. `j.effect` throws when the effect is defined.
- `run(command, input, meta)` is `journal.run` on that same database: its own transaction, committed before it returns. `meta` is required, and the library never picks an actor. It works the same in a plain app and in a Dot app.
- If the command throws, the effect fails: nothing of the command is committed and the job is retried. If the effect fails after `run` returned, the command stays committed and runs again on the retry. Make the command safe to run twice. The usual key is `jobId`.
- `jobId` is the same on every retry. An effect can run more than once, so pass `jobId` on as an idempotency key.
- Where it is registered: under `effects` in `journal.root.ts`, or in the feature's `journalHandlers` in a Dot app. Effect names are unique per journal.
- Who runs the worker: a plain app calls `journal.worker(db).start()` once per process and `stop()` on shutdown. In a Dot app the `journal(...)` plugin does both.
- Which process runs the worker: an effect runs in the process that runs the worker. If an effect talks to something that lives in memory (an event emitter, a socket list, a cache), run the worker in the process that holds it. A worker in another process claims the job and the in-memory listeners never hear it. Tests do not catch this, because a test is one process.
- `wake`: `journal.run(db, ...)` on the root database wakes the worker after its commit. After a transaction of your own, call `journal.wake()` yourself. Other processes find the job by polling.
- A failing effect does not reach the caller. Its error is stored on the job row (`last_error`). The job is retried and marked dead after 8 failed attempts.

### Add a command and run it

Library files: `src/api.ts` (`Command`, `CommandContext`, `bind`), `src/command.ts` (how `journal.run` runs one), `src/errors.ts` (`CommandError`), `src/orpc.ts` (the oRPC error mapping).

```ts
// features/orders/commands.ts
import { CommandError } from '@arki/journal';
// core/orpc.ts, in an oRPC app: once, after the app's own error middleware.
import { commandErrors } from '@arki/journal/orpc';

export const payOrder = j.command(
  'payOrder',
  z.object({ orderId: orderIdSchema, amount: z.int().positive() }),
  (input, { write }) =>
    write(order, input.orderId, row => {
      if (!row) throw new CommandError('NOT_FOUND', 'Order not found');
      if (row.status !== 'placed') throw new CommandError('CONFLICT', `Order is already ${row.status}`);
      return [OrderPaid({ amount: input.amount })]; // [] means: write nothing
    }),
);

// The door. Bind the database and the actor once, then pass only the command and its input.
// A request: the actor comes from the session. Put the bound runner on the request context.
const runCommand = journal.bind(db, { actorId: user.id });
await runCommand(payOrder, { orderId: id, amount: 10 });
// A job, a schedule, a script or a seed: use a clear system actor.
const runSystemCommand = journal.bind(db, { actorId: 'system' });
await runSystemCommand(payOrder, { orderId: id, amount: 10 });

export const publicProcedure = os.use(appErrors).use(commandErrors());
```

- The handler context is `{ tx, meta, write, run }`. `run(child, input)` runs another command in a savepoint.
- `journal.bind(source, meta)` is the door. It returns `(command, input) => journal.run(source, command, input, meta)`. You still give `meta`: the library never picks an actor. `meta` is parsed on every call, as in `journal.run`, so a default in the meta schema is new for each command.
- `source` is the root database or a transaction, with the rules of `journal.run`. On the root database each call commits and wakes the worker. On a transaction the call joins it; the caller commits and then calls `journal.wake()`.
- A bound runner has the type `CommandRunner`, the type of a command context's `run`. Pass it to code that takes one, for example `paymentsJournal.writes(runCommand)` of `@arki/payments`.
- A rule that rejects the request throws `new CommandError(code, message)`. The command rolls back and the caller gets the same error. The four codes are in [Rejected rules](#rejected-rules-commanderror).
- An oRPC app adds `commandErrors()` to its procedure builders once. Procedures then need no try/catch around a command. Any other host matches with `isCommandError(error, code?)`.
- `journal.run(source, command, input, meta)` is the long form. It parses the input and `meta`, opens the transaction, and returns what the handler returns.
- From an effect, call `ctx.run(command, input, meta)`. It is `journal.run` on the worker's root database.
- In the games-platform backend, procedures call `context.runCommand`. `core/context.ts` binds it to the signed-in user. A job or a schedule binds its own runner: `journal.bind(db, { actorId: null })`. Do not call `journal.run` from a procedure there.

### Find out why a write failed

1. Check the kind of error. `isJournalError(error)` is true: go to step 2. `isCommandError(error)` is true: a rule of the app rejected the request; read its `code` and `message`, and find the `throw` in the command. A `ZodError`: input, event data or `meta` failed its schema. A plain `Error` that starts with `journal:`: a wrong definition or a misuse; search `src/` for the message. Anything else was thrown by app code and passed through unchanged.
2. Read `error.code`, `error.kind` and `error.entityId`. Match on the code, for example `isJournalError(error, 'CONFLICT')`. Never match on the message. The message reads `CODE: what happened (kind id): detail. What to do next.`
3. Find the code in the [error table](#errors). To see the exact check, search for the code in the file the table names.
4. Run again with `DEBUG=arki:journal:*`. It prints commands, writes, replays, drains and worker ticks.

## Words that are easy to mix up

| Pair                                      | The difference                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stored row and reducer row                | The stored row (`Row<Tbl>`) is what the database returns, with defaults filled in. `events(row)` gets it. The reducer row (`ReducerRow<Tbl, Key>`) is what reducers built. A column left to its database default may be missing. `.on` and `replay` use it.                                                                                                                   |
| Pending event and recorded event          | A pending event is `{ type, data }`. `OrderPaid({ amount })` makes one and `events` returns them. A recorded event also has `seq`, `id`, `entityId`, `version`, `meta`, `recordedAt`, the trace `commandId`, `causeSeq`, `correlationId` (library-stamped; see README, Tracing), and `erasedAt` (see README, Erasure). Reducers, projections and effects get recorded events. |
| Entity version and global sequence        | `version` counts 1, 2, 3 inside one entity. `replay` takes `throughVersion`. `seq` orders all events of all entities in commit order: an advisory lock taken at the start of every write makes a lower `seq` commit first, so `seq > cursor` misses nothing. `rerun` takes `afterSeq`.                                                                                        |
| `DbHandle`, `RootDb`, `TransactionSource` | `DbHandle` fits a database or a transaction: `replay`, `verify`, `repair`. `RootDb` is the database only: `drain`, `worker`. `TransactionSource<Tx>` is anything that opens a `Tx`: `run`, `rerun`. A root database opens a transaction. A transaction opens a savepoint.                                                                                                     |

## Rules that bite

- **Await every `write` and `run`. One journal operation per transaction at a time.** Why: savepoints are a stack, so two open operations would release each other's savepoint. No `Promise.all` over writes.
- **`drain` and `worker` take the root database.** Why: inside a transaction, effects would run before the outer commit. They throw if given a transaction.
- **Run the worker where its effects have their listeners.** Why: any running worker can claim any job. An effect that emits in memory reaches only the process it runs in.
- **A reducer returns the value the database will store.** Why: `replay` and `repair` rebuild the row from reducer output. If the database rounds or trims, the two differ. The write fails with `VALUE_MISMATCH`.
- **Events are frozen.** Why: one handler's change would reach the next handler, and replay would not repeat it. Copy first: `[...e.data.items].sort()`.
- **Version 1 means created by the journal.** A row that existed before the journal starts its history at version 2. Why: replay folds from nothing, so it needs a history that starts at 1. Otherwise `replay`, `verify` and `repair` throw `NO_HISTORY`. To bring a legacy row in with a complete history, `journal.adopt` records a create event that rebuilds the row exactly as version 1 (README, Rows that existed before the journal).
- **Pass the id exactly as it is stored.** Why: the log compares ids as exact strings. A second spelling would split one history in two. The write fails with `ID_MISMATCH`.
- **A reducer sets every column that a later reducer reads.** Why: database defaults are not in the log, so replay does not see them.
- **For a new meaning, add a new event type.** Why: `replay` and `repair` use today's reducers on old events.

## Errors

Two kinds of error have a code.

- A `JournalError` is the library's own failure. It is about one entity's row or history. It has `code`, `kind` and `entityId`. Its twelve codes are in the table below.
- A `CommandError` is a rule of the app that rejects a request. App code throws it; the library never does. It is not a `JournalError`. Its four codes are in [Rejected rules](#rejected-rules-commanderror).

This is the only copy of this table. The message texts are in `src/errors.ts`. An error thrown by an effect never reaches the caller: `drain` stores it on the job row.

| Code               | What it means                                                                                                                                                                                                                                                                                                                   | Usual cause                                                                                                                                                                                                         | What to do                                                                                                                                                                             | Thrown in                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `CONFLICT`         | The row and its event history cannot accept this write. The caller's `expectedVersion` is stale, another writer appended first, or the row is missing or behind while its log says otherwise.                                                                                                                                   | Two requests wrote the same entity at the same time. Or someone deleted the row by hand.                                                                                                                            | After a concurrent append, run the command again on the current state. When the row and the history disagree, check with `verify`, and use `repair` only when the history is complete. | `src/write.ts`, `src/history.ts`                                                |
| `NO_ROW`           | No row exists, and the event has no `.create` reducer.                                                                                                                                                                                                                                                                          | A wrong id, or the entity was deleted, and `events` did not check for a missing row.                                                                                                                                | Create the entity first, or declare `.create` for the event.                                                                                                                           | `src/write.ts`, `src/fold.ts`                                                   |
| `ROW_EXISTS`       | A row exists, and the event has no `.on` reducer.                                                                                                                                                                                                                                                                               | A create event was written twice for one id.                                                                                                                                                                        | Write an update event, or declare `.on` for the event.                                                                                                                                 | `src/write.ts`, `src/fold.ts`                                                   |
| `UNKNOWN_EVENT`    | The entity does not declare the event.                                                                                                                                                                                                                                                                                          | A hand-built `{ type, data }`, or an event that belongs to another entity.                                                                                                                                          | Add `.create` or `.on` for it on this entity, or write it to the entity that declares it.                                                                                              | `src/write.ts`, `src/fold.ts`                                                   |
| `VERSION_MISMATCH` | When saving, no row matched the version this write locked.                                                                                                                                                                                                                                                                      | A direct update or delete of the entity row inside `events`.                                                                                                                                                        | Look for a statement that changes the row version or removes the row outside the journal, for example a direct update inside `events`. Then run the command again.                     | `src/write.ts`                                                                  |
| `NO_HISTORY`       | The log has no complete history from version 1. The row existed before the journal, or events are missing.                                                                                                                                                                                                                      | The row came from a seed or an old migration, not from a create event.                                                                                                                                              | `replay`, `verify` and `repair` cannot rebuild this row. Check how the row was created, or restore the missing events.                                                                 | `src/history.ts`                                                                |
| `HISTORY_GAP`      | The log has a hole (a version between 1 and the top is missing), or the stored row is at a higher version than the log's top while the log says the entity is alive. `replay`, `verify` and `repair` throw it. A row over a log that ends in a delete is not a gap: it was placed outside the journal, and `repair` removes it. | An event row was deleted by hand, or lost in a restore from backup.                                                                                                                                                 | Restore the missing event from a backup, or accept the row as it is. Replay and repair refuse to build a row the real history never produced.                                          | `src/history.ts`                                                                |
| `REPLAY_FAILED`    | A stored event cannot be decoded or applied: its type is not declared, its data or `meta` does not fit the current schema, or no reducer fits it. `replay`, `verify`, `repair` and `rerun` throw it. `drain` records it on the job.                                                                                             | An event type was renamed or removed, or its schema was made stricter, after events were stored.                                                                                                                    | Check the event schema and the reducers against the stored history.                                                                                                                    | `src/history.ts`, `src/fold.ts`                                                 |
| `UNSTABLE_SCHEMA`  | Event data or `meta` changes, or fails, across JSON storage and a second parse.                                                                                                                                                                                                                                                 | A `Date` or a transform in an event schema or in the `meta` schema.                                                                                                                                                 | Return JSON-compatible data that the schema accepts unchanged.                                                                                                                         | `src/storage.ts`                                                                |
| `ID_MISMATCH`      | The id is empty, malformed, too long, or spelled differently from the stored key.                                                                                                                                                                                                                                               | An upper-case `uuid`, an empty string, or an id longer than the key column.                                                                                                                                         | Pass the id exactly as stored. A `uuid` must be lower-case and hyphenated.                                                                                                             | `src/storage.ts`, `src/write.ts`                                                |
| `BAD_DEFINITION`   | A declaration is wrong. It is thrown when the declaring code runs (import time), before any data is touched.                                                                                                                                                                                                                    | A bad event type, entity kind or effect name; a bad key column; `.create` after `.on`; a second reducer for one event; a need named `db`; two effects or projections with one name; a missing service in `compose`. | Fix the declaration the message names. The message text is the detail after the code.                                                                                                  | `src/id.ts`, `src/entity.ts`, `src/handlers.ts`, `src/journal.ts`, `src/dot.ts` |
| `VALUE_MISMATCH`   | The database stored a different value than the reducer produced. The write was rolled back.                                                                                                                                                                                                                                     | A `numeric` value with more decimals than the column keeps, such as `"1.234"` for `numeric(10,2)`.                                                                                                                  | Make the reducer produce the value in the form the column stores.                                                                                                                      | `src/storage.ts`                                                                |

### Rejected rules: `CommandError`

`new CommandError(code, message)` is thrown by a command handler or by an `events` function. The command rolls back, and `journal.run` lets the same error out. `isCommandError(error, code?)` matches it. The message is written for the client.

| Code          | HTTP | Use it when                                                                  |
| ------------- | ---- | ---------------------------------------------------------------------------- |
| `NOT_FOUND`   | 404  | The thing the request names does not exist.                                  |
| `BAD_REQUEST` | 400  | The input has the right shape, but a rule refuses it. An end before a start. |
| `FORBIDDEN`   | 403  | This actor may not do this to this entity.                                   |
| `CONFLICT`    | 409  | The current state does not allow it. Already paid. A name that is taken.     |

`@arki/journal/orpc` maps these for an oRPC app. The code is in `src/orpc.ts`. `@orpc/server` is an optional peer, and the core entry never imports it.

- `toORPCError(error)` turns a `CommandError` into an `ORPCError` with the same code and message.
- It turns a `JournalError` with code `CONFLICT` into an `ORPCError('CONFLICT')` with the message `This was changed by another request. Reload the current state and try again.` The client reloads first: with an `expectedVersion`, the same request fails again.
- It returns every other error unchanged.
- `commandErrors()` is the same mapping as a middleware. Put it after the app's own error middleware: `os.use(appErrors).use(commandErrors())`. Put before it, the app's middleware sees a plain error first and answers 500.

### Dot boot errors

- `JOURNAL_PLUGIN_E001`, a `DotPluginError`: a feature token holds a `journal` slice that `journalHandlers` did not make. Declare the slice with `journalHandlers({ projections, effects })`.
- `journal: duplicate effect name "x" (features "feature.orders" and "feature.billing")`: two features list a handler with the same name. Rename one. Projections get the same message with `projection`.
- `journal: effect "x" needs "mailer", but no service with that name was given; ...`: thrown by `j.compose` in a plain app and at boot in a Dot app. Plain app: add `mailer` to `services` in `j.compose`. Dot app: add it to the `needs` of the feature that lists the effect.
- `journal: effect "x" has a need named "db", ...`: thrown by `j.effect`. The names `jobId`, `signal`, `db` and `run` are taken. Give the need another name.

## Recovery verbs

| Verb                                             | Takes                              | Returns                                                                        | When to use it                                                                                                                                                                              |
| ------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adopt(tx, entity, id, { meta, events })`        | A transaction                      | `{ row, events }` as `write` returns.                                          | Once per row that existed before the journal, before its first write. `events(row)` returns one create event whose `.create` reducer rebuilds the stored row exactly; it becomes version 1. |
| `forget(db, entity, id)`                         | A database or a transaction        | `{ erased, row }`: how many events were rewritten, and the repaired row.       | To remove personal data from one entity's history. Events with an `erased` form are rewritten to it and stamped; the row is repaired to match. Read models are the app's to forget.         |
| `replay(db, entity, id, { throughVersion })`     | A database or a transaction        | `{ row, events }`: the reducer row built in memory, or `null`, and its events. | To see what the log says about one entity. It writes nothing.                                                                                                                               |
| `verify(db, entity, id)`                         | A database or a transaction        | `{ ok: true }`, or `{ ok: false, expected, actual }`.                          | To check one stored row against its log. It compares only the columns that reducers set.                                                                                                    |
| `repair(db, entity, id)`                         | A database or a transaction        | The stored row after the repair, or `null`.                                    | The row is wrong and the history is complete. It writes no event, runs no projection and creates no job.                                                                                    |
| `rerun(db, projection, { afterSeq, batchSize })` | A database that opens transactions | `{ events }`: how many events it handled.                                      | To fill a new read model or rebuild a lost one. Every handler runs again, so empty a counting read model first.                                                                             |
| `drain(db, { batchSize, signal })`               | The root database only             | How many jobs it claimed.                                                      | To run one batch of due jobs by hand, in a test or a script. The worker calls it in a loop.                                                                                                 |

## Dot

`@arki/journal/dot` exports the plugin `journal(...)` and the feature slice `journalHandlers(...)`. The code is in `src/dot.ts`.

| Question                  | Plain app                                             | Dot app                                                                          |
| ------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| Where handlers are listed | One `journal.root.ts` calls `j.compose(...)`.         | Each feature lists its own with `journalHandlers(...)`. There is no root file.   |
| Who builds the journal    | Your code.                                            | The plugin: `journal({ j, tables, features })`. It publishes `services.journal`. |
| Who runs the worker       | Your code: `journal.worker(db)`, `start()`, `stop()`. | The plugin, between `start` and `stop`. Pass `worker: false` to turn it off.     |
| What an effect needs      | `services` in `j.compose(...)`, once for the app.     | The services of the feature that lists the effect. It declares them in `needs`.  |

| Where the door is bound | The request context: `journal.bind(db, { actorId })`. | The gateway's context factory: `services.journal.bind(services.db, { actorId })`. |

The code for both wirings is in the [README, Dot](../README.md#dot).

The gateway binds the door once per request. Its context factory reads the session and puts `run: services.journal.bind(services.db, { actorId })` on the context. A procedure then calls `context.run(command, input)`. The plugin does not bind for you: only the app knows the actor.

An effect runs a command with `ctx.run` in both wirings. In feature mode the journal is built after the features, and that is fine: the journal hands `run` to the effect when the job runs.

## Shared packages

This is the pattern to follow. No code in this repo uses it yet. A package that ships journal pieces exports a factory. The factory takes the app's `j` and the tables. It returns entities, commands, projections and effects. An effect that needs a service lists it with `need<T>()`, and the app gives the service in its own `j.compose({ services })`. The package never owns a database, a composed journal or a worker. The app adds the tables to its schema. It calls `billingJournal(j, billingTables())` and lists the returned handlers in its own `j.compose(...)`. `billingTables()` is the package's own table factory, shaped like `journalTables()`: it returns `{ invoices }`, a table with a string `id` and a `version` column.

```ts
export function billingJournal<Meta extends z.ZodObject, Tx extends TransactionSource<Tx>, AppDb extends RootDb>(
  j: JournalDefinitions<Meta, Tx, AppDb>,
  tables: ReturnType<typeof billingTables>,
) {
  const InvoiceIssued = j.event('InvoiceIssued', z.object({ amount: z.int().positive() }));
  const invoice = j.entity('invoice', tables.invoices).create(InvoiceIssued, e => ({ amount: e.data.amount }));
  const issueInvoice = j.command(
    'issueInvoice',
    z.object({ invoiceId: z.string().min(1), amount: z.int().positive() }),
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
- `bindEffect` in `src/handlers.ts` runs for every effect, also for one without needs, and a Dot app runs it twice (the bridge, then `j.compose`): it is the one place where a need gets its service and where a missing service is caught.
- `need<T>()` is the journal's own marker, not Dot's `service<T>()`: the core must load and type-check without `@arki/dot`, and Dot keeps the key of its marker private.
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
