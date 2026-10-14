# @arki/journal

A journal keeps two things and writes them together.
Every change is one immutable row in `journal_events`.
Each entity also has a normal row in its own Drizzle table.
A command is the way to write: `j.command` defines one, `journal.run` runs it.
`journal.bind` is the door for a request or a job: it fixes the database and the actor once.
Inside the command, `write` validates the event data, appends the events, runs the reducers, saves the row, runs inline projections and queues jobs for async effects, all in one transaction.
Reads are plain Drizzle queries. Replay exists for checks and repair, not for reading.

Exports: `@arki/journal` (portable core), `@arki/journal/pg` (table definitions), `@arki/journal/errors` (`CommandError`, `JournalError` and their guards with no Drizzle import, for browser code that matches on codes), `@arki/journal/dot` (optional `@arki/dot` plugin and feature slice, see Dot), `@arki/journal/orpc` (optional oRPC error mapping, see Rejected rules), `@arki/journal/testing` (`openJournalDb(schema)`: an in-memory PGlite with the schema pushed, for tests; `@electric-sql/pglite` and `drizzle-kit` are optional peers).

**Agents: start at [`llms.txt`](llms.txt).** Then open the part of the [agent guide](docs/agent-guide.md) that fits the task:

| Task                                                                                          | Read                                                                                                                       |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Understand the model and the three objects (`j`, the entity builder, `journal`)               | [The model](docs/agent-guide.md#the-model), [Three objects](docs/agent-guide.md#three-objects)                             |
| Set the journal up in an app                                                                  | [Setup](docs/agent-guide.md#setup)                                                                                         |
| Add an event and react to it in the same transaction                                          | [Add an event](docs/agent-guide.md#add-an-event-and-react-in-the-same-transaction)                                         |
| Add an entity, with create and delete                                                         | [Add an entity](docs/agent-guide.md#add-an-entity-with-create-and-delete)                                                  |
| Add an effect that runs after commit                                                          | [Add an effect](docs/agent-guide.md#add-an-effect-that-runs-after-commit)                                                  |
| Add a command and run it from a request or a job                                              | [Add a command](docs/agent-guide.md#add-a-command-and-run-it)                                                              |
| Find out why a write failed                                                                   | [Find out why](docs/agent-guide.md#find-out-why-a-write-failed), [Errors](docs/agent-guide.md#errors)                      |
| Check or repair a row, rebuild a read model                                                   | [Recovery verbs](docs/agent-guide.md#recovery-verbs)                                                                       |
| Wire it in a Dot app, or ship journal pieces from a package                                   | [Dot](docs/agent-guide.md#dot), [Shared packages](docs/agent-guide.md#shared-packages)                                     |
| Watch or stop every command or effect run from a plugin (tracing, logging, a circuit breaker) | [Hooks](#hooks): `journal.hooks.command.around`, `journal.hooks.effect.around`                                             |
| Change code inside this package                                                               | [Rules that bite](docs/agent-guide.md#rules-that-bite), [Do not clean these up](docs/agent-guide.md#do-not-clean-these-up) |

## Example

```ts
// src/journal.ts — once per app. `meta` is the app-wide metadata schema.
import { initJournal, need } from '@arki/journal';
// src/schema.ts — the two journal tables live in the app's schema.
import { journalTables } from '@arki/journal/pg';

export const j = initJournal({ meta: z.object({ actorId: z.string() }) });
// Or, to type `tx` everywhere with the app's own Drizzle transaction type:
// export const j = initJournal.tx<AppTx>().create({ meta: ... });
// And to type `db` inside effects with the app's own database type:
// export const j = initJournal.tx<AppTx>().db<AppDb>().create({ meta: ... });

// src/features/orders/tables.ts — a normal table with `id` and `version`.
// A table keyed by another column: j.entity('profile', profiles, { key: 'accountId' }).
export const orders = pgTable('orders', {
  id: varchar('id', { length: 256 }).primaryKey().$type<OrderId>(),
  customerId: varchar('customer_id', { length: 256 }).notNull(),
  total: integer('total').notNull(),
  status: varchar('status', { enum: ['placed', 'paid', 'cancelled'] }).notNull(),
  version: integer('version').notNull().default(0),
});

// src/features/orders/order.ts — events and the entity.
export const OrderPlaced = j.event('OrderPlaced', z.object({ customerId: z.string(), total: z.int().positive() }));
export const OrderPaid = j.event('OrderPaid', z.object({ amount: z.int().positive() }));
export const OrderCancelled = j.event('OrderCancelled', z.object({ reason: z.string().min(1) }));

export const order = j
  .entity('order', orders)
  .create(OrderPlaced, e => ({ customerId: e.data.customerId, total: e.data.total, status: 'placed' }))
  .on(OrderPaid, () => ({ status: 'paid' })) // a patch: only the columns that change
  .on(OrderCancelled, () => null); // null deletes the row; the events stay

// src/features/orders/commands.ts — a command needs only `j`, entities and events.
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

// Inline lane: exact read model, same transaction.
export const customerStats = j.projection('customer-stats', order, {
  OrderPlaced: (tx, e) =>
    tx
      .insert(customerOrderCounts)
      .values({ customerId: e.data.customerId, placed: 1 })
      .onConflictDoUpdate({
        target: customerOrderCounts.customerId,
        set: { placed: sql`${customerOrderCounts.placed} + 1` },
      }),
});

// Async lane: after commit, at least once. The context also has `db`, the root database,
// and `run`, which runs a command. An effect lists what else it needs and gets it in the context.
export const orderMail = j.effect(
  'order-mail',
  order,
  { mailer: need<Mailer>() },
  {
    OrderPaid: (e, { jobId, mailer }) =>
      mailer.send({ template: 'order-paid', orderId: e.entityId, idempotencyKey: jobId }),
  },
);

export const tables = journalTables(); // or journalTables(pgSchema('app'))

// src/journal.root.ts — the one place that lists handlers.
export const journal = j.compose({ tables, projections: [customerStats], effects: [orderMail], services: { mailer } });

// The request context binds the door once: the database and the signed-in actor.
export const createContext = (user: User) => ({ user, runCommand: journal.bind(db, { actorId: user.id }) });

// A procedure. The schema is reused. A rule that rejects the request throws `CommandError`;
// `commandErrors()` from `@arki/journal/orpc`, on the builder, answers the client with its code.
export const pay = protectedProcedure
  .input(payOrder.input.pick({ orderId: true, amount: true }))
  .handler(({ context, input }) => context.runCommand(payOrder, input));

// Boot. One worker per process runs the async lane. Root database only, never a transaction.
// `journal.run(db, ...)` wakes it after each commit that queued a job.
const worker = journal.worker(db);
await worker.start();
```

## Commands

`j.command(name, inputSchema, handler)` returns a plain value with `name`, `input` (the schema, so a procedure can reuse or `.pick` it) and the handler. Nothing is registered anywhere. The handler gets the parsed input and a context:

- `tx`: the command's transaction. Use it for reads, or for writes outside any entity.
- `meta`: the parsed metadata. Every `write` in the command records it.
- `write(entity, id, events)`: `journal.write` bound to `tx` and `meta`. `events` is `(row, { tx }) => pending events`, sync or async.
- `run(child, input)`: run another command in a savepoint of the same transaction, with the same `meta`.

`journal.run(source, command, input, meta)` parses `input` with the command's schema (`parseAsync`; a `ZodError` passes through) and `meta` with the app schema, then calls the handler inside `source.transaction(...)`. The root database opens a transaction. A transaction opens a savepoint, so the caller still decides the commit. It returns what the handler returns. Errors pass through unchanged.

`journal.bind(source, meta)` is the door. It returns `(command, input) => journal.run(source, command, input, meta)`, so a request context or a job fixes the database and the actor once, and every call site passes only the command and its input. The caller still gives `meta`: the library never picks an actor. `source` follows the rules of `run`: a root database commits and wakes, a transaction joins and leaves the commit to the caller. `meta` is parsed on every call, not once at bind time. A bound runner is then exactly `journal.run`: a default in the meta schema is new for each command, and a bad `meta` rejects the call. The runner has the type `CommandRunner`, the type of a command context's `run`, so it can be passed to code that takes one.

Await every `write` and `run` before the handler returns. `run` waits for any operation still running, then fails the command and rolls back, because a transaction must not close with work in flight. If the handler threw, the handler's own error is reported. The low-level `journal.write` inside your own `db.transaction(...)` has no such guard: await every journal call before your transaction callback returns.

Inside a command, an uncaught failure anywhere rolls back everything the command did. A child failure the parent catches rolls back only that child. A command may touch no entity, one, or several; it may return any value. Command input is not stored, so it may hold Dates and transforms. Event data and `meta` keep the storage rules below.

The types are all inferred: the handler's `input` from the schema, `journal.run`'s `input` as the schema's input type, the return type from the handler, `row`, id and events in `write` from the entity, `tx` from `initJournal.tx<AppTx>()`, `meta` from the meta schema.

### Tracing

Every recorded event says where it came from. The library stamps three columns; the app never sets them.

- `commandId`: the `cmd_` id of the run that wrote the event. A child run gets its own. A bare `journal.write` has none.
- `causeSeq`: inside an effect's `ctx.run`, the `seq` of the event the job was for. So a reaction points at what it reacts to.
- `correlationId`: one id for the whole chain. A run from an effect continues the cause event's chain. A root run starts a new chain, unless `journal.run(db, cmd, input, meta, { correlationId })` or `journal.bind(db, meta, { correlationId })` seeds it, for example with the request id. A bare write starts its own chain.

The command context exposes `commandId` and `correlationId` for logs. To read a chain: `select * from journal_events where correlation_id = $1 order by seq`. Rows written before these columns existed have `null` in all three.

### Idempotent commands

A webhook or a retried request can run the same command twice. `journal.run(db, cmd, input, meta, { idempotencyKey })` makes the second run answer like the first and write nothing. The first run records the key, the command name, the parsed input and its result in `journal_receipts`, inside its own transaction, so a receipt exists exactly when the run committed. A later run with the same key and the same input returns the stored result without running the handler; hooks still run and see `ctx.idempotencyKey`. The same key with another input, or with another command, is `CONFLICT`. A concurrent repeat waits for the first to commit, then replays it. A key cannot be reused inside its own run.

The result must survive JSON, because the replay returns the stored form; a result with a `Date` or a class instance fails the first run with `UNSTABLE_SCHEMA`. Return plain data: an id, a status, a version. A key from outside is scoped by the app: `${tenant}:${eventId}`, never the bare client value. A bound runner and an effect's `ctx.run` take the key per call: `runAs(cmd, input, { idempotencyKey })`.

A replay does not run the handler, so a permission check inside the handler does not run either. Put it in the command's `authorize` option: `j.command(name, input, handler, { authorize: (input, { tx, meta }) => ... })`. It runs inside the transaction on every call, a replay included, before the stored result is returned; it throws (a `CommandError` `FORBIDDEN`, usually) to refuse, and a refused replay changes nothing.

Receipts hold inputs and results, so they can hold personal data, and `forget` does not touch them. An app that keys personal flows prunes on a schedule: `journal.pruneReceipts(db, { before })`.

### Where commands run from

The same `journal.run` serves every trigger. `journal.bind(db, meta)` is the same call with `db` and `meta` fixed. Checking who the caller is stays application code; business rules live in the command.

| Trigger   | Call                                                              | Notes                                                                     |
| --------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Procedure | `context.runCommand(command, input)`                              | The request context binds once: `journal.bind(db, { actorId: user.id })`. |
| Job       | `journal.run(db, command, payload, job.meta)`                     | The queue owns retries.                                                   |
| Schedule  | `journal.run(db, command, input, { actorId: 'system' })`          | A clear system actor; `meta` keeps its schema.                            |
| Webhook   | `journal.run(db, command, mappedInput, trustedMeta)`              | The adapter verifies the signature and maps the payload.                  |
| Effect    | `ctx.run(command, input, { actorId: 'system' })`                  | See below. An effect never imports the journal root.                      |
| Script    | `journal.run(db, command, input, { actorId: 'script:backfill' })` | One call per item; each is its own transaction.                           |
| Test      | `journal.run(db, command, input, meta)`                           | No procedure, no HTTP. The same validation and transaction.               |

An effect that needs to write runs a command with `run` from its context:

```ts
// src/features/orders/effects.ts
export const closeAfterPayment = j.effect('close-after-payment', order, {
  OrderPaid: (e, { run }) => run(closeOrder, { orderId: e.entityId }, { actorId: 'system' }),
});

// src/journal.root.ts
export const journal = j.compose({ tables, effects: [closeAfterPayment] });
```

- `run(command, input, meta)` is `journal.run` on the root database that the worker or `drain` was given. It opens its own transaction and commits before it returns.
- `meta` is required. The library never picks an actor. An app may still wrap `run` in one small helper, so the system actor is written in one place.
- If the command throws, the effect fails. Nothing of the command is committed. The job is retried with backoff.
- If the effect fails after `run` returned, the command stays committed and the job runs again. So the command can run twice. Make it safe: check the row and return `[]`, or pass `jobId` in the input and store it as the key. `jobId` is the same on every retry.
- A command that queues a job wakes the worker. A chain of effects does not wait for the poll.

## The low-level write

`journal.write(tx, entity, id, { meta, events })` is what a command's `write` calls. Use it directly only when there is no command: a one-off migration step, or a test that needs a specific `meta` per write. `events` is the function that looks at the locked row, checks the rules, and returns the events to append. It runs after the row is locked, inside the write's savepoint, and receives that savepoint as `{ tx }`, so it can read related rows under the lock. It may be async. It only accepts events declared on the entity; the row type, the id type and the event data types are all inferred.

`expectedVersion` is the row version the caller saw. If the stored version differs (0 for no row), the write is refused with `CONFLICT` before `events` runs. A command passes it on: `write(order, id, events, { expectedVersion: input.version })`. The client sends the version it rendered; `commandErrors()` turns the refusal into a 409 that asks it to reload. This is how concurrent editors and stale game moves are caught without a hand-written version compare.

`write` returns `{ row, events }`: the stored row after the write (`null` after a delete) and the recorded events, each with `seq`, `id`, `entityId`, `version`, `meta`, `recordedAt` the trace `commandId`, `causeSeq`, `correlationId` (see Tracing), and `erasedAt` (see Erasure). An entity can be created again after a delete; its version continues from the last event.

### Rows that existed before the journal

A row the journal creates gets version 1 from its create event. A row that was there first (stored `version` 0, no events in the log) can still be written to, but its history starts at version 2: the first write treats the row as version 1 and records its event as version 2. Version 1 therefore always means "created from nothing". `replay`, `verify` and `repair` need a history that starts at version 1 and throw `NO_HISTORY` otherwise, because folding a partial history from nothing would pick the wrong reducers and build the wrong row. They also need every version up to the top, and a live row no newer than its log, and throw `HISTORY_GAP` otherwise: an event lost after it was written must be restored, not folded around.

To bring such a row in properly, adopt it before its first write. `journal.adopt(tx, entity, id, { meta, events })` takes the row at version 0 with no history, calls `events(row)` for exactly one create event built from the stored row, and checks that the event's `.create` reducer rebuilds the row exactly, column by column. If it does, the event is recorded as version 1 and the row moves to version 1: the history is complete, and `replay`, `verify` and `repair` work from then on. If it does not, `VALUE_MISMATCH` names the column and nothing changes. A row the journal already knows, a missing row, or a legacy row that was already written to is `CONFLICT`. Projections run and effects are queued as for any write, because the event is the app's own. Run it once per legacy row, in a migration or a one-off script, before the app writes to the row.

```ts
await db.transaction(tx =>
  journal.adopt(tx, order, id, {
    meta: { actorId: 'migration' },
    events: row => [OrderPlaced({ customerId: row.customerId, total: row.total })],
  }),
);
```

### Erasure

Personal data written into an event stays in the log until the log forgets it. An event that can hold personal data declares its erased form: `j.event('MessageSent', schema, { erased: data => ({ ...data, content: '' }) })`. The erased form keeps everything that is not personal and must still fit the event's own schema. An event without one holds no personal data and is never touched.

`journal.forget(db, entity, id)` rewrites every stored event of that entity that has an erased form to it, sets `erased_at` on those rows, and then repairs the row from the rewritten log, so the row and its history agree. All in one transaction. An erased form the schema rejects is `BAD_DEFINITION` and nothing changes. A history replay cannot rebuild, such as a legacy row that was never adopted, is `NO_HISTORY` and nothing changes: adopt it first. Running it twice is safe; the first erased time is kept. It returns `{ erased, row }`.

Projections are not rerun and no job is queued: the app owns its read models and forgets them itself, in the same request. Recorded events carry `erasedAt`, so a projection that is rerun later can tell an erased event from a live one.

### A row removed outside the journal

If a row is deleted by hand while its log says it exists, the next write that would create it throws `CONFLICT`. Write would apply `.create` where replay applies `.on`, and the two would disagree. Run `repair` to restore the row from the log, then write again. A row the journal deleted is fine: its log ends with the delete, and a create continues the version sequence.

### The key column

Names are non-empty and well-formed text: at most 64 characters for an entity kind, and 128 for an event type or an effect name. `j.entity`, `j.event` and `j.effect` throw otherwise.

The key column is `id` unless the entity names another one by its property name: `j.entity('profile', profiles, { key: 'accountId' })`. The name is checked against the table's columns at the type level and must be one property name, not a union. The column must hold a string, be `notNull`, and be the primary key or unique, either on the column (`.primaryKey()`, `.unique()`) or at table level as a single-column `unique()`, `uniqueIndex()` or `primaryKey()`. A `uniqueIndex` with a `where` does not count: it is unique only inside that subset. `j.entity` checks this and throws otherwise. The id argument of `write`, `replay`, `verify` and `repair`, the key on the `.on` row, and `entityId` on every recorded event all have that column's own type (for example a branded `AccountId`). `journal_events.entity_id` stores the string.

The journal compares keys as exact strings, so the key column must not treat two different strings as one key. Four rules:

- `text` and `varchar` (with or without a length) are allowed, with the database's default, exact comparison. Do not give them a case-insensitive collation. `varchar(256).$type<Branded>()` is fine.
- An id is at most 256 characters, or the column's own length if that is smaller, counted in Unicode code points. It must not be empty. `write`, `replay`, `verify` and `repair` refuse any other id with `ID_MISMATCH`, before they touch the database. Nothing is trimmed or cut for you.
- An id must be well-formed text. An id with an unpaired surrogate (such as `"x\uD800"`) is refused with `ID_MISMATCH`, before the database is touched. The driver would store it as U+FFFD and it would reach the history of another id. Nothing is replaced for you.
- `uuid` is allowed, but ids must be lower-case and hyphenated. `write`, `replay`, `verify` and `repair` refuse any other spelling with `ID_MISMATCH`, before they touch the database. Nothing is lower-cased for you.
- Every other type (`citext`, `char(n)`, numbers) is refused when the entity is defined. So is a custom column type (`customType`), even one that reports `text` or `varchar(n)`, because its mapping can change the string.

Why: if the database sees two spellings as one key but the log sees two, one entity gets two histories, and `repair` could replay only half. `ReducerValues<Tbl, Key>` omits the key column and `version`.

The id you pass must be exactly the key the database stores. Some columns treat two spellings as one key, such as a `uuid` (upper and lower case) or case-insensitive text. The journal logs events under the string you pass, so a second spelling would split one history in two. It refuses any id that differs from the stored key with `ID_MISMATCH`, and writes nothing. For `uuid` keys, pass the lower-case form.

### One operation at a time per transaction

Savepoints are a stack. Two `write` or `run` calls open on one transaction at the same time would release each other's savepoint, so a caught failure of one could erase what the other wrote. A transaction therefore holds one journal operation at a time: await each `write` and `run` before starting the next on the same transaction. A second one started early waits for the first to settle, then rejects with an error naming the command or entity. A child command runs on its own savepoint, so a `run` inside a `run` is fine, and so are operations on the root database, which get separate transactions.

### The app's transaction type

`initJournal({ meta })` types the command's `tx`, `write`'s `tx`, `events`' `{ tx }` and projection handlers' `tx` with the structural `DbHandle`. To use the app's own Drizzle transaction type instead, so repositories typed against it fit, declare it once: `initJournal.tx<AppTx>().create({ meta })`. `tx` is a type-only step. `run` and `rerun` then take any database that opens `AppTx` transactions; `drain` and `worker` keep taking the root database. To name the root database type as well, see Effects.

### Reducers

Events are read-only. A reducer, projection or effect that tries to change `e.data` or `e.meta` gets a `TypeError`. Copy first: `[...e.data.items].sort()`.

An `.on` reducer receives the reducer-shaped state (`ReducerRow<Tbl, Key>`: the insert shape plus the key column and `version`) and returns a patch, `Partial<ReducerValues<Tbl, Key>> | null`. The patch is merged onto the state. A key set to `undefined` means unchanged. `events(row, { tx })` still receives the stored `Row<Tbl> | null`.

Columns that every `.create` reducer sets are required on the `.on` row. A column one create leaves to its database default, sets on one branch only, or may set to `undefined`, stays optional. The rule: every `.create` comes before the first `.on`. After the first `.on` the builder has no `.create`, and calling one anyway throws, because a later create could leave out a column the `.on` was promised. An `.on` declared before any `.create` sees the plain insert shape.

One event may have both a `.create` and an `.on` reducer, for an event that may open an entity or update it (a grant, a flag). The fold picks by state: no row runs the create reducer, a row runs the on reducer. An event with only a create reducer on an existing row is `ROW_EXISTS`; an event with only an on reducer and no row is `NO_ROW`. Declaring the same event twice in the same mode throws at definition time.

A reducer must produce each value in the form the database stores. If the database would round or trim it, the write is refused with `VALUE_MISMATCH`. The message names the entity, id and column, and shows both values. For a `numeric(10,2)` column, a reducer that returns `"1.234"` is refused, because the database stores `1.23`. Return `"1.23"` instead. Why: `replay` and `repair` recompute the row from reducer output. Later reducers read the stored row. If the two differ, a correct balance drifts. For a JSON column, a reducer may produce plain objects, full arrays, strings, numbers, booleans and `null`. A `Map`, a `Set` or an array with holes is refused, because JSON storage would lose its contents. A custom column may hold a value object: a class instance with an `equals` method, such as a Temporal `Instant` from `@arki/db/temporal`. It is compared with its `equals`, so a value the column rebuilds exactly passes and a value the column changed is refused. The check covers the columns a reducer set in this write. `repair` makes the same check and leaves the row as it was.

Database defaults are not journal state. `write` folds from the stored row, where a default-filled column has its value. `replay` folds from nothing, where that column is `undefined`. That is why such columns are optional in the `.on` row type unless a create sets them. The rule: a reducer must set every column that any reducer later reads. In a `.create` result, a key set to `undefined` is stripped and the default applies. `verify` compares only the columns reducers set.

`write` parses every event's data with its schema, even for a hand-built `{ type, data }`. The schema must accept its own stored output unchanged, because replay parses stored data again; otherwise `write` throws `UNSTABLE_SCHEMA`. The same rule applies to `meta`. An optional key holding `undefined` in event data is not stored: JSON drops it, so the stored event, the reducers and replay all see the key as absent. The check allows this, because absent and `undefined` read the same way. Leaving the key out is the same thing.

An error about one entity's row or history is a `JournalError` with a `code`. Match on the code, never on the message. The message names the entity kind and id, adds the event type and version when the journal knows them, and ends with the next step.

The twelve codes, the usual cause of each and what to do are in one table: [agent guide, Errors](docs/agent-guide.md#errors).

Other errors are not `JournalError`. A wrong definition or a misuse is a plain `Error` whose message starts with `journal:`. Input, event data or `meta` that fails its schema is a `ZodError`. An error thrown by a command handler, an `events` function, a reducer or a projection passes through unchanged.

### Rejected rules

A rule of the app that rejects a request throws `new CommandError(code, message)`. The code is `NOT_FOUND`, `BAD_REQUEST`, `FORBIDDEN` or `CONFLICT`. The message is written for the client. It is not a `JournalError`: a `JournalError` is the library's own failure, a `CommandError` is the app saying no. The command rolls back and the caller gets the same error. `isCommandError(error, code?)` matches it.

An oRPC app maps it once, with `@arki/journal/orpc`. `@orpc/server` is an optional peer. The core entry never imports it.

```ts
// src/core/orpc.ts
import { commandErrors } from '@arki/journal/orpc';

// After the app's own error middleware, so a rejected rule is already an `ORPCError` when that one sees it.
export const publicProcedure = os.use(appErrors).use(commandErrors());
```

`commandErrors()` answers a `CommandError` with the `ORPCError` of the same code and message, and a `JournalError` with code `CONFLICT` with a 409 that asks the client to try again. Every other error passes unchanged. `toORPCError(error)` is the same mapping as a function. A host without oRPC writes its own few lines with `isCommandError`. The codes and their HTTP meaning are in the [agent guide](docs/agent-guide.md#rejected-rules-commanderror).

Other verbs: `replay(db, entity, id, { throughVersion })` (returns the reducer-shaped row), `verify(db, entity, id)`, `repair(db, entity, id)`, `rerun(db, projection, { afterSeq, batchSize })`, `drain(db, { batchSize, signal })`. `drain` and `worker` take the root database (`RootDb`), never a transaction: effects must run after commit. Lease and retry times use the database clock.

### Changing reducers later

`replay`, `verify` and `repair` use today's reducers and today's event schemas. They do not remember the code that ran when the event was written.

So changing how an existing event is reduced changes what `repair` writes for existing rows. `verify` will report those rows as drifted.

For a new meaning, add a new event type. Leave the old reducer as it is.

### Changing events later

Adding an optional field, or one with a default, is safe. Old rows still parse.

For any other change to an event's data, such as a rename, a new required field, or a new structure, keep the old schema and add an upcaster:

```ts
const NoteSetV1 = z.object({ text: z.string() });

const NoteSet = j.event('NoteSet', z.object({ note: z.string(), by: z.string() }), {
  upcasters: [{ from: NoteSetV1, up: v1 => ({ note: v1.text, by: 'unknown' }) }],
});
```

Each upcaster lifts data one version up. `upcasters[0]` takes version 1 to 2, the next takes 2 to 3, and so on. The event's version is one more than the number of upcasters. New rows store it in `schema_version`, and old rows keep the version they were written at.

Every reader goes through the same decoder: `replay`, `verify`, `repair`, `forget`, `rerun`, async projections, effects and taps. It parses an old row with each step's `from` schema, calls `up`, and parses the result with the current schema. Each `up` gets the typed output of its own `from`. Readers only ever see the current shape. The stored row is never rewritten, except by `forget`, which stores the erased form at the current version.

The rules:

- Append a step for each change. Never edit or remove a step, because rows at that version still exist.
- An upcaster is a pure function of the old data. It must not read the clock, the database or the row.
- A row from a newer release than the reader is `REPLAY_FAILED`, so old code never guesses at a new shape. Deploy readers before the first write of a new version if old and new code run side by side.
- A row that does not fit its version's schema, or an upcaster that throws, is `REPLAY_FAILED` and names the version.

### Async projections

A projection runs inline by default: inside the write's transaction, so the read model is exact. A slow or large one can run later instead: `j.projection('leaderboard', game, handlers, { lane: 'async' })`. The write then only wakes the worker. The worker, after every drain pass, gives each async projection one batch: it locks the projection's row in `journal_cursors`, scans the next `batchSize` events in commit order, applies the matching ones on that same transaction, and moves the cursor to the last event scanned. Progress and the read model's writes commit together, so a crash cannot apply a batch twice or skip one. The cursor counts every event, matching or not, so `journal.cursors(db)` reports an honest `lag` in seqs, and lag 0 means caught up. A projection whose batch throws is skipped that pass and tried again next pass; the others go on.

`journal.catchUp(db, { batchSize })` runs one batch per async projection by hand, for tests and scripts. `journal.reset(db, projection, async tx => { await tx.delete(table) })` empties the read model and rewinds the cursor in one transaction, with the cursor locked first, so no batch lands in between. To rebuild with no downtime, deploy the projection under a new name into a new table, wait for lag 0, switch reads, then drop the old one. `rerun` is for inline projections only. `forget` locks every async cursor before it rewrites, so a batch in flight cannot commit erased data after it.

## Effects

An effect runs after the commit, at least once, from a row in `journal_jobs`. A handler gets the event and a context: `(e, { jobId, signal, db, run })`.

- `jobId` stays the same across retries. Pass it on as an idempotency key.
- `signal` is the `signal` given to `drain`.
- `db` is the root database given to `drain` or `worker`: the same object. Use it to read committed rows. The effect needs no closure for the database.
- `run` runs a command on that database: `run(command, input, meta)`. See [Where commands run from](#where-commands-run-from).

An effect that needs a service (a mailer, an in-process emitter) lists it. The list is the third argument:

```ts
export const orderMail = j.effect(
  'order-mail',
  order,
  { mailer: need<Mailer>() },
  {
    OrderPaid: (e, { jobId, mailer }) =>
      mailer.send({ template: 'order-paid', orderId: e.entityId, idempotencyKey: jobId }),
  },
);

export const journal = j.compose({ tables, effects: [orderMail], services: { mailer } });
```

- `need<Mailer>()` comes from `@arki/journal`. It is a marker: it holds the type and no value.
- Each handler gets the service in its context, under the name of the need, with its type.
- The app gives the real services once, in `services`. Every need of every listed effect must be there. A missing one is a compile error, and `compose` throws: `journal: effect "order-mail" needs "mailer", but no service with that name was given; ...`.
- Two effects that use the same name get the same service.
- A need cannot be named `jobId`, `signal`, `db` or `run`. `j.effect` throws.
- An effect that needs nothing has three arguments: `j.effect(name, entity, on)`.

`db` has the library's `RootDb` type unless the app names its own database type once: `initJournal.db<AppDb>().create({ meta })`. Then `ctx.db.query.orders` is typed, and `drain` and `worker` need an `AppDb`. They still refuse a transaction. With `.tx<AppTx>()` they also need a database that opens `AppTx` transactions, because effects run commands on it. The app's own Drizzle database does. `.tx<AppTx>()` and `.db<AppDb>()` are both optional type-only steps and chain in either order: `initJournal.tx<AppTx>().db<AppDb>().create({ meta })`.

### When a job runs

An effect can carry a schedule: `j.effect('receipt', order, handlers).withSchedule({ priority: 10 })`. `priority` (an integer, default 0): among due jobs the higher one is claimed first. It is strict, so a steady stream of high-priority jobs can starve lower ones; use a few levels, not a score. `delaySeconds`: the job is due that long after the write's transaction started (Postgres `now()`), so a long transaction uses part of the delay before commit. `runAt: event => Date`: the job is due at the time the event names, from the app's clock; a time in the past is due at once. Give `delaySeconds` or `runAt`, not both. Retries keep their backoff and their priority. A bad value throws `BAD_DEFINITION` where the schedule is declared.

## The worker

`journal.worker(db, { pollMs, batchSize })` is a loop around `drain`. When a pass finds no job it sleeps `pollMs` (1000 by default).

- A pass claims one job at a time, right before it runs it, up to `batchSize` jobs. So each job's lease (`leaseSeconds`, default 60) covers its own work only, and a slow job cannot let the lease of a later one run out. A job queued during the pass can run in the same pass.
- While an effect runs, the worker renews its lease every half lease, under its own token. A long effect is safe for as long as its worker is alive. If the renewal finds the lease gone (the worker stalled past a whole lease and another worker reclaimed the job), the effect's `ctx.signal` aborts so it can stop, and its result is not acknowledged: the other worker owns the job now. An effect that does external work should still pass `jobId` on as an idempotency key, because the stall can happen between the work and the ack.
- `stop()` aborts the running effect's `ctx.signal`, claims no further job, and resolves when that effect returns. An effect that does long work should pass `ctx.signal` on (for example to `fetch`) so shutdown does not wait for it.
- `drain` and the worker never claim a job whose effect this journal does not have. During a rolling deploy an older worker may still have it. After the deploy, `journal.strandedJobs(db)` lists what is left, counted per effect name. A non-empty list means an effect was renamed or removed while it had jobs: bring it back under its old name until the count is zero, or delete those rows on purpose.

A wake ends the sleep, so an effect does not wait for the next poll:

- `journal.run(db, ...)` on the root database wakes by itself. The library committed the transaction, so it knows when. It wakes only when the command queued a job.
- With your own transaction (`journal.run(tx, ...)` or `journal.write(tx, ...)`) nothing wakes. The library cannot see your commit. Call `journal.wake()` after you commit.
- `journal.wake()` wakes every running worker this journal started in this process. `worker.wake()` wakes one worker. With no running worker a wake does nothing.
- A wake that arrives while a pass is running is not lost: one more pass runs right after. Many wakes make one extra pass.
- The wake works inside one process only. Other processes pick jobs up by polling.

```ts
await db.transaction(async tx => {
  await journal.run(tx, payOrder, input, meta);
  await tx.insert(auditLog).values(entry);
});
journal.wake(); // after the commit
```

## Taps and the wake channel

Every commit that recorded events notifies a Postgres channel, `journal.wakeChannel` (`journal_wake`, or `<schema>_journal_wake` for tables in a schema), with the seq range as JSON: `{ "from": 12, "to": 14 }`. Postgres delivers `NOTIFY` at commit, so a listener hears exactly the commits that happened, in every process, including commits of transactions the caller manages, where `journal.wake()` cannot help. The payload is small and bounded; a listener loads what it needs by seq.

A worker hears it through `listen`: `journal.worker(db, { listen })`, where `listen` is `onMessage => unlisten`. `LISTEN` needs a dedicated connection. With a `pg` pool, use `listenOnPool(db.$client, journal.wakeChannel)`: it borrows one client for as long as the worker runs, replaces it when the connection drops, and gives it back on `stop()`. With PGlite, `onMessage => client.listen(journal.wakeChannel, onMessage)`. `LISTEN` hears only what is sent after it ran, and a connection can drop, so the worker keeps polling (`pollMs`); the channel makes it prompt, not correct. A listening worker drains at once on every commit.

A tap is a handler that fires from that channel: in-process, after commit, lossy. No job row, no retry, no order promised across entities. `j.tap('live-orders', order, { OrderPlaced: (e, { db }) => hub.publish(e) })`, with needs like an effect: `j.tap(name, entity, { hub: need<Hub>() }, handlers)`, given in `compose({ taps, services })`. It fires in every process whose worker listens, for every event in the announced range that it names, in seq order, with the root database and no `run`: a tap may not issue commands, because a lost notification must never mean lost writes. An error in a tap is logged and swallowed; the command already committed. Taps are not wrapped by effect hooks. A journal with taps refuses a worker without `listen`, unless `{ taps: false }` says that worker runs jobs only and another process listens. For a live page, a cache, a metric. For work that must happen, write an effect.

## Hooks

The one way to watch or stop a run from outside is a hook: a wrapper that receives the context and `next`. Register at boot, before any work.

```ts
journal.hooks.command.around(async (ctx, next) => {
  // ctx: { name, input, meta, commandId, correlationId }, frozen
  const span = tracer.startSpan(`command ${ctx.name}`, { attributes: { 'journal.correlation_id': ctx.correlationId } });
  try {
    await next();
  } finally {
    span.end();
  }
});
journal.hooks.effect.around(async (ctx, next) => {
  // ctx: { name, event, jobId, attempt }, frozen
  log.debug('effect %s attempt %d for %s', ctx.name, ctx.attempt, ctx.event.id);
  await next();
});
```

The rules, all enforced:

- Call `next` exactly once. A second call throws. Returning without calling it throws: throw before `next` to stop the run instead.
- A rejection of `next` is the hook's rejection too. A hook that catches it and returns still fails, with the original error: a rolled-back command cannot look like a success to the caller.
- The context is frozen, and the result is the handler's own. A hook cannot change the input or the result.
- Hooks run in registration order, the first one outermost. Command hooks run inside the transaction, around the handler, so a throw rolls the command back cleanly; a child run is wrapped again, with its own `commandId` and the same `correlationId`. Effect hooks run inside the lease, around the handler, so a throw fails the job like a handler failure: it is retried with backoff and recorded on the job row.
- Registration is frozen once the journal has run a command, a drain or a worker. A later `around` throws `BAD_DEFINITION`. In a Dot app, a plugin that needs the journal attaches in `boot`, which runs before the worker starts.

## Operating the jobs

`journal.jobs(db, { status, effect, limit })` lists job rows: `pending` (the default) is everything not dead, due, delayed and leased alike; `dead` is what the worker gave up on after 8 attempts, with `lastError`. `journal.retry(db, jobId)` brings a dead job back: attempts and lease cleared, due now, workers woken. `journal.discard(db, jobId)` deletes a dead job. Both refuse a job that is not dead: retrying a live one would run it twice, and deleting a live one would not stop its work, only lose the record of it. `journal.strandedJobs(db)` finds pending jobs whose effect this journal no longer has.

## Dot

`@arki/journal/dot` connects the journal to an `@arki/dot` app. It exports two adapters and one feature slice. `@arki/dot` is an optional peer. The core entry never imports it.

- `journal(...)`: the driven part, for `.use()`. It publishes `services.journal`, so features can write through it.
- `journalWorker(...)`: the driving part, for `.serve()`. It runs effects, taps and async projections between `start` and `stop`.
- `journalHandlers(...)`: the feature slice. A feature lists its projections, effects and taps with it.

**Not a Dot app.** List the handlers in one `journal.root.ts`. Start and stop the worker yourself.

```ts
// src/journal.root.ts — the one place that lists handlers.
export const journal = j.compose({ tables, projections: [customerStats], effects: [orderMail], services: { mailer } });

// src/server.ts
const worker = journal.worker(db);
await worker.start();
// On shutdown:
await worker.stop();
```

**Dot app.** Each feature lists its own handlers with `journalHandlers`. The app lists its features once, in `.features([...])`. Both adapters read that list. There is no root file.

```ts
// src/features/orders/feature.ts
export const orders = feature('orders', {
  needs: { mailer: service<Mailer>() },
  use: [journalHandlers({ projections: [customerStats], effects: [orderMail] })],
});

// src/app.ts
export const app = defineApp('shop')
  .use(db())
  .use(mailer())
  .use(journal({ j, tables: journalTables() }))
  .features([orders, billing])
  .serve(journalWorker());

// The gateway binds the door once per request, in its context factory. A procedure calls `context.run`.
const run = services.journal.bind(services.db, { actorId: user.id });
await run(payOrder, input);
```

- `journal(...)` boots before the features. It reads their `journalHandlers` declarations, not their booted services, so a feature can `need` the journal and write through it, even in its own `boot`.
- This works because a write never needs an effect's services. A write runs the inline projections, which get only the transaction, and queues each effect's job. The journal is composed with `services: 'worker'`. `journalWorker()` gives each effect and tap its services when it runs it.
- `journal(...)` needs the root database under the `db` key. A transaction there is a compile error.
- `journalWorker()` starts one worker on `start` and stops it on `stop`. Options: `pollMs`, `batchSize`, `leaseSeconds`, `listen`, `taps`. A process that serves no worker still writes. Its jobs wait for a process that serves one.
- An effect with needs gets them from the booted services of the feature that lists it, by name. The feature must declare each one in its own `needs`, or it does not compile. A missing service fails that feature's boot.
- Two features may use the same need name for two different services. Each effect gets the service of its own feature.
- Every effect is an action in the app manifest (`binding: 'journal'`, id `<name>.run`). Projections are never listed: they run inside the write.
- Two features with the same projection name or the same effect name fail the boot. The message names the duplicate and both features.
- A feature without `journalHandlers` adds nothing. That is allowed.
- An app that composed its journal itself passes it: `journal({ journal })`. Serve `journalWorker()` if it has effects, taps or async projections. `journalHandlers` slices are not read in this mode.
- A second journal uses Dot's `rename`: `rename(journal({ journal: reports }), { journal: 'reportsJournal' }, 'reports-journal')`.
- An effect runs a command with `ctx.run` in both modes. It needs no closure over the journal.

## Tables

`journalTables()` returns both. The app's migrations create them (`drizzle-kit generate`). The library never creates tables at runtime.

`seq` is commit order, not only insert order. Every write takes one advisory transaction lock (`pg_advisory_xact_lock`, namespace `0x4a524e4c`) at its start and holds it until the transaction commits, so a transaction that took a lower `seq` always commits first. A reader that remembers the last `seq` it saw, as `rerun` does with `afterSeq`, therefore misses nothing. The cost: event appends across the whole app commit one transaction at a time, and a transaction that writes events and then does slow work holds every other writer until it commits. Keep writes near the end of a transaction, or keep the transaction short.

```text
journal_events
  seq          bigserial primary key      -- commit order, used by rerun
  id           varchar not null unique    -- evt_xxx
  kind         varchar(64) not null
  entity_id    varchar(256) not null
  version      integer not null           -- 1, 2, 3 per entity
  type         varchar(128) not null
  data         jsonb not null
  meta         jsonb not null
  recorded_at  timestamptz not null default now()
  command_id      varchar                 -- cmd_xxx, the run that wrote it; null for a bare write
  cause_seq       bigint                  -- the event whose effect ran that command; else null
  correlation_id  varchar                 -- one per chain; see Tracing
  erased_at       timestamptz             -- set by forget; data holds the erased form
  schema_version  integer not null default 1  -- the event's version when data was written
  unique (kind, entity_id, version)
  index (correlation_id)

journal_receipts
  key           varchar(256) primary key  -- the app's idempotency key
  command       varchar(128) not null
  input         jsonb not null            -- the parsed input, after JSON
  result        jsonb                     -- { value } when finished; {} for no value; null while running
  command_id    varchar not null
  recorded_at   timestamptz not null default now()

journal_cursors
  name          varchar(128) primary key  -- the async projection
  seq           bigint not null default 0 -- global scan progress
  updated_at    timestamptz not null default now()

journal_jobs
  id            varchar primary key       -- job_xxx; pass it on as an idempotency key
  event_seq     bigint not null references journal_events(seq)
  effect        varchar(128) not null
  priority      integer not null default 0 -- from the effect's schedule; higher first
  attempts      integer not null default 0
  available_at  timestamptz not null default now()
  lease_until   timestamptz
  lease_token   varchar
  last_error    text
  dead_at       timestamptz               -- set after 8 failed attempts
  unique (event_seq, effect)
  index (priority desc, available_at) where dead_at is null
```

A job row is deleted when its handler succeeds. The table holds only pending and dead work. The event row is the lasting record.

An entity table needs a string key column that is primary or unique (`id` by default) and `version integer not null default 0`.

## Debugging

`DEBUG=arki:journal:*` prints commands, writes, replays, drains and worker ticks.
