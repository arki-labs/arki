# @arki/journal for agents

Read this file first. [`llms.txt`](../llms.txt) is the index. The [README](../README.md) is the long overview. `src/api.ts` defines every signature. If this guide and `src/api.ts` disagree, `src/api.ts` wins.

Paths that start with `src/` are files of this package. App files are named from the app's own source folder, for example `journal.root.ts` or `features/orders/effects.ts`. The app layout, with a "Which file do I touch" list, is in the [feature layout note](../../../apps/games-platform/backend/src/features/README.md) of the games-platform backend. Read it before you touch an app.

## The model

1. An entity is a normal row in its own Drizzle table. The table has a string key and a `version` column.
2. Every change is also one row in `journal_events`. Event rows are never changed or deleted.
3. One transaction writes the event rows and the entity row together.
4. A command is the way to write. `j.command` defines one. `journal.run` runs it.
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
| `journal`, the runner | `j.compose({ tables, projections, effects })` | Does the work: `run`, `write`, `replay`, `verify`, `repair`, `rerun`, `drain`, `worker`, `wake`.              | `journal.root.ts`, or the Dot plugin |

How to tell them apart: only `journal` takes a database. Events, entities, commands, projections and effects need only `j`. They must never import the composed `journal`.

The word `create` has two meanings. Neither one builds the journal. `j.compose(...)` builds the journal.

| You see                                                | It means                                                          | Defined in       |
| ------------------------------------------------------ | ----------------------------------------------------------------- | ---------------- |
| `initJournal.tx<AppTx>().db<AppDb>().create({ meta })` | Finish the setup chain. Returns `j`.                              | `src/journal.ts` |
| `.create(Event, reducer)` on an entity builder         | Declare a create reducer. It builds the first row from the event. | `src/entity.ts`  |

## Setup

```ts
import { initJournal } from '@arki/journal';
import { journalTables } from '@arki/journal/pg';

// journal.ts: once per app. `meta` is the schema of the metadata every event records.
export const j = initJournal
  .tx<AppTx>()
  .db<AppDb>()
  .create({ meta: z.object({ actorId: z.string().min(1) }) });

// schema.ts: the two journal tables go into the app's schema and migrations.
export const tables = journalTables(); // or journalTables(pgSchema('app'))

// journal.root.ts: the one place that lists handlers.
export const journal = j.compose({ tables, projections: [customerStats], effects: [orderMail(mailer)] });
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

Library files: `src/handlers.ts` (`defineEffect`), `src/worker.ts` (claims, retries, `drain`, the loop, `wake`), `src/journal.ts` (`createJournal` gives the worker `runOn`, which makes `ctx.run`).

```ts
// features/orders/effects.ts: a factory, so the mailer comes in as an argument.
export const orderMail = (mailer: Mailer) =>
  j.effect('order-mail', order, {
    OrderPaid: async (e, { jobId, db }) => {
      const [row] = await db.select().from(orders).where(eq(orders.id, e.entityId));
      if (!row) return;
      await mailer.send({ template: 'order-paid', orderId: e.entityId, total: row.total, idempotencyKey: jobId });
    },
  });

// An effect that writes runs a command. It needs no closure over the journal.
export const closeAfterPayment = j.effect('close-after-payment', order, {
  OrderPaid: (e, { run }) => run(closeOrder, { orderId: e.entityId }, { actorId: 'system' }),
});
```

- The handler gets `(e, { jobId, signal, db, run })`. `db` is the root database given to `drain` or `worker`. Read committed rows with it.
- `run(command, input, meta)` is `journal.run` on that same database: its own transaction, committed before it returns. `meta` is required, and the library never picks an actor. It works the same in a plain app and in a Dot app.
- If the command throws, the effect fails: nothing of the command is committed and the job is retried. If the effect fails after `run` returned, the command stays committed and runs again on the retry. Make the command safe to run twice. The usual key is `jobId`.
- `jobId` is the same on every retry. An effect can run more than once, so pass `jobId` on as an idempotency key.
- Where it is registered: under `effects` in `journal.root.ts`, or in the feature's `journalHandlers` in a Dot app. Effect names are unique per journal.
- Who runs the worker: a plain app calls `journal.worker(db).start()` once per process and `stop()` on shutdown. In a Dot app the `journal(...)` plugin does both.
- Which process runs the worker: an effect runs in the process that runs the worker. If an effect talks to something that lives in memory (an event emitter, a socket list, a cache), run the worker in the process that holds it. A worker in another process claims the job and the in-memory listeners never hear it. Tests do not catch this, because a test is one process.
- `wake`: `journal.run(db, ...)` on the root database wakes the worker after its commit. After a transaction of your own, call `journal.wake()` yourself. Other processes find the job by polling.
- A failing effect does not reach the caller. Its error is stored on the job row (`last_error`). The job is retried and marked dead after 8 failed attempts.

### Add a command and run it

Library files: `src/api.ts` (`Command`, `CommandContext`), `src/command.ts` (how `journal.run` runs one).

```ts
// features/orders/commands.ts
export const payOrder = j.command(
  'payOrder',
  z.object({ orderId: orderIdSchema, amount: z.int().positive() }),
  (input, { write }) =>
    write(order, input.orderId, row => {
      if (!row) throw new Error(`order ${input.orderId} not found`);
      if (row.status !== 'placed') throw new Error(`order ${input.orderId} is ${row.status}`);
      return [OrderPaid({ amount: input.amount })]; // [] means: write nothing
    }),
);

// From a request. The actor comes from the session.
await journal.run(db, payOrder, { orderId: id, amount: 10 }, { actorId: user.id });
// From a job or a schedule. Use a clear system actor.
await journal.run(db, payOrder, { orderId: id, amount: 10 }, { actorId: 'system' });
```

- The handler context is `{ tx, meta, write, run }`. `run(child, input)` runs another command in a savepoint.
- From an effect, call `ctx.run(command, input, meta)`. It is `journal.run` on the worker's root database.
- `journal.run` parses the input and `meta`, opens the transaction, and returns what the handler returns.
- In the games-platform backend, requests call `context.runCommand` and jobs call `runSystemCommand`. Both are in `core/run-command.ts`. Do not call `journal.run` from a procedure there.

### Find out why a write failed

1. Check the kind of error. `isJournalError(error)` is true: go to step 2. A `ZodError`: input, event data or `meta` failed its schema. A plain `Error` that starts with `journal:`: a wrong definition or a misuse; search `src/` for the message. Anything else was thrown by app code and passed through unchanged.
2. Read `error.code`, `error.kind` and `error.entityId`. Match on the code, for example `isJournalError(error, 'CONFLICT')`. Never match on the message. The message reads `CODE: what happened (kind id): detail. What to do next.`
3. Find the code in the [error table](#errors). To see the exact check, search for the code in the file the table names.
4. Run again with `DEBUG=arki:journal:*`. It prints commands, writes, replays, drains and worker ticks.

## Words that are easy to mix up

| Pair                                      | The difference                                                                                                                                                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stored row and reducer row                | The stored row (`Row<Tbl>`) is what the database returns, with defaults filled in. `events(row)` gets it. The reducer row (`ReducerRow<Tbl, Key>`) is what reducers built. A column left to its database default may be missing. `.on` and `replay` use it.               |
| Pending event and recorded event          | A pending event is `{ type, data }`. `OrderPaid({ amount })` makes one and `events` returns them. A recorded event also has `seq`, `id`, `entityId`, `version`, `meta` and `recordedAt`. Reducers, projections and effects get recorded events.                           |
| Entity version and global sequence        | `version` counts 1, 2, 3 inside one entity. `replay` takes `throughVersion`. `seq` orders all events of all entities. `rerun` takes `afterSeq`.                                                                                                                           |
| `DbHandle`, `RootDb`, `TransactionSource` | `DbHandle` fits a database or a transaction: `replay`, `verify`, `repair`. `RootDb` is the database only: `drain`, `worker`. `TransactionSource<Tx>` is anything that opens a `Tx`: `run`, `rerun`. A root database opens a transaction. A transaction opens a savepoint. |

## Rules that bite

- **Await every `write` and `run`. One journal operation per transaction at a time.** Why: savepoints are a stack, so two open operations would release each other's savepoint. No `Promise.all` over writes.
- **`drain` and `worker` take the root database.** Why: inside a transaction, effects would run before the outer commit. They throw if given a transaction.
- **Run the worker where its effects have their listeners.** Why: any running worker can claim any job. An effect that emits in memory reaches only the process it runs in.
- **A reducer returns the value the database will store.** Why: `replay` and `repair` rebuild the row from reducer output. If the database rounds or trims, the two differ. The write fails with `VALUE_MISMATCH`.
- **Events are frozen.** Why: one handler's change would reach the next handler, and replay would not repeat it. Copy first: `[...e.data.items].sort()`.
- **Version 1 means created by the journal.** A row that existed before the journal starts its history at version 2. Why: replay folds from nothing, so it needs a history that starts at 1. Otherwise `replay`, `verify` and `repair` throw `NO_HISTORY`.
- **Pass the id exactly as it is stored.** Why: the log compares ids as exact strings. A second spelling would split one history in two. The write fails with `ID_MISMATCH`.
- **A reducer sets every column that a later reducer reads.** Why: database defaults are not in the log, so replay does not see them.
- **For a new meaning, add a new event type.** Why: `replay` and `repair` use today's reducers on old events.

## Errors

A `JournalError` is about one entity's row or history. It has `code`, `kind` and `entityId`. This is the only copy of this table. The message texts are in `src/errors.ts`. An error thrown by an effect never reaches the caller: `drain` stores it on the job row.

| Code               | What it means                                                                                                                                                                                                                       | Usual cause                                                                                        | What to do                                                                                                                                                                             | Thrown in                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `CONFLICT`         | The row and its event history cannot accept this write. Another writer appended first, or the row is missing or behind while its log says otherwise.                                                                                | Two requests wrote the same entity at the same time. Or someone deleted the row by hand.           | After a concurrent append, run the command again on the current state. When the row and the history disagree, check with `verify`, and use `repair` only when the history is complete. | `src/write.ts`, `src/history.ts` |
| `NO_ROW`           | No row exists, and the event has no `.create` reducer.                                                                                                                                                                              | A wrong id, or the entity was deleted, and `events` did not check for a missing row.               | Create the entity first, or declare `.create` for the event.                                                                                                                           | `src/write.ts`, `src/fold.ts`    |
| `ROW_EXISTS`       | A row exists, and the event has no `.on` reducer.                                                                                                                                                                                   | A create event was written twice for one id.                                                       | Write an update event, or declare `.on` for the event.                                                                                                                                 | `src/write.ts`, `src/fold.ts`    |
| `UNKNOWN_EVENT`    | The entity does not declare the event.                                                                                                                                                                                              | A hand-built `{ type, data }`, or an event that belongs to another entity.                         | Add `.create` or `.on` for it on this entity, or write it to the entity that declares it.                                                                                              | `src/write.ts`, `src/fold.ts`    |
| `VERSION_MISMATCH` | When saving, no row matched the version this write locked.                                                                                                                                                                          | A direct update or delete of the entity row inside `events`.                                       | Look for a statement that changes the row version or removes the row outside the journal, for example a direct update inside `events`. Then run the command again.                     | `src/write.ts`                   |
| `NO_HISTORY`       | The log has no complete history from version 1. The row existed before the journal, or events are missing.                                                                                                                          | The row came from a seed or an old migration, not from a create event.                             | `replay`, `verify` and `repair` cannot rebuild this row. Check how the row was created, or restore the missing events.                                                                 | `src/history.ts`                 |
| `REPLAY_FAILED`    | A stored event cannot be decoded or applied: its type is not declared, its data or `meta` does not fit the current schema, or no reducer fits it. `replay`, `verify`, `repair` and `rerun` throw it. `drain` records it on the job. | An event type was renamed or removed, or its schema was made stricter, after events were stored.   | Check the event schema and the reducers against the stored history.                                                                                                                    | `src/history.ts`, `src/fold.ts`  |
| `UNSTABLE_SCHEMA`  | Event data or `meta` changes, or fails, across JSON storage and a second parse.                                                                                                                                                     | A `Date` or a transform in an event schema or in the `meta` schema.                                | Return JSON-compatible data that the schema accepts unchanged.                                                                                                                         | `src/storage.ts`                 |
| `ID_MISMATCH`      | The id is empty, malformed, too long, or spelled differently from the stored key.                                                                                                                                                   | An upper-case `uuid`, an empty string, or an id longer than the key column.                        | Pass the id exactly as stored. A `uuid` must be lower-case and hyphenated.                                                                                                             | `src/storage.ts`, `src/write.ts` |
| `VALUE_MISMATCH`   | The database stored a different value than the reducer produced. The write was rolled back.                                                                                                                                         | A `numeric` value with more decimals than the column keeps, such as `"1.234"` for `numeric(10,2)`. | Make the reducer produce the value in the form the column stores.                                                                                                                      | `src/storage.ts`                 |

### Dot boot errors

- `JOURNAL_PLUGIN_E001`, a `DotPluginError`: a feature token holds a `journal` slice that `journalHandlers` did not make. Declare the slice with `journalHandlers({ projections, effects })`.
- `journal: duplicate effect name "x" (features "feature.orders" and "feature.billing")`: two features list a handler with the same name. Rename one. Projections get the same message with `projection`.

## Recovery verbs

| Verb                                             | Takes                              | Returns                                                                        | When to use it                                                                                                  |
| ------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `replay(db, entity, id, { throughVersion })`     | A database or a transaction        | `{ row, events }`: the reducer row built in memory, or `null`, and its events. | To see what the log says about one entity. It writes nothing.                                                   |
| `verify(db, entity, id)`                         | A database or a transaction        | `{ ok: true }`, or `{ ok: false, expected, actual }`.                          | To check one stored row against its log. It compares only the columns that reducers set.                        |
| `repair(db, entity, id)`                         | A database or a transaction        | The stored row after the repair, or `null`.                                    | The row is wrong and the history is complete. It writes no event, runs no projection and creates no job.        |
| `rerun(db, projection, { afterSeq, batchSize })` | A database that opens transactions | `{ events }`: how many events it handled.                                      | To fill a new read model or rebuild a lost one. Every handler runs again, so empty a counting read model first. |
| `drain(db, { batchSize, signal })`               | The root database only             | How many jobs it claimed.                                                      | To run one batch of due jobs by hand, in a test or a script. The worker calls it in a loop.                     |

## Dot

`@arki/journal/dot` exports the plugin `journal(...)` and the feature slice `journalHandlers(...)`. The code is in `src/dot.ts`.

| Question                  | Plain app                                             | Dot app                                                                          |
| ------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| Where handlers are listed | One `journal.root.ts` calls `j.compose(...)`.         | Each feature lists its own with `journalHandlers(...)`. There is no root file.   |
| Who builds the journal    | Your code.                                            | The plugin: `journal({ j, tables, features })`. It publishes `services.journal`. |
| Who runs the worker       | Your code: `journal.worker(db)`, `start()`, `stop()`. | The plugin, between `start` and `stop`. Pass `worker: false` to turn it off.     |

The code for both wirings is in the [README, Dot](../README.md#dot).

An effect runs a command with `ctx.run` in both wirings. In feature mode the journal is built after the features, and that is fine: the journal hands `run` to the effect when the job runs.

## Shared packages

This is the pattern to follow. No code in this repo uses it yet. A package that ships journal pieces exports a factory. The factory takes the app's `j` and the tables. It returns entities, commands, projections and effect factories. The package never owns a database, a composed journal or a worker. The app adds the tables to its schema. It calls `billingJournal(j, billingTables())` and lists the returned handlers in its own `j.compose(...)`. `billingTables()` is the package's own table factory, shaped like `journalTables()`: it returns `{ invoices }`, a table with a string `id` and a `version` column.

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
  const invoiceMail = (send: (invoiceId: string, idempotencyKey: string) => Promise<void>) =>
    j.effect('invoice-mail', invoice, { InvoiceIssued: (e, { jobId }) => send(e.entityId, jobId) });
  return { entities: { invoice }, events: { InvoiceIssued }, commands: { issueInvoice }, effects: { invoiceMail } };
}
```

## Do not clean these up

These look odd. Each one is needed.

- `ownHandler` with `Object.hasOwn` in `src/handlers.ts`: an event type named `toString` must not find a handler on the prototype.
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
