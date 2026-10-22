# @arki/journal

A journal keeps two things and writes them together.
Every change is one immutable row in `journal_events`.
Each entity also has a normal row in its own Drizzle table.
A command is the way to write: `j.command` defines one, `journal.run` runs it.
`journal.bind` is the door for a request or a job: it fixes the database and the actor once.
Inside the command, `write` validates the event data, appends the events, runs the reducers, saves the row, runs inline projections and queues jobs for async effects, all in one transaction.
Reads are plain Drizzle queries. Replay exists for checks and repair, not for reading.

**Agents: start at [`llms.txt`](llms.txt).** Then open the part of the [agent guide](docs/agent-guide.md) that fits the task:

| Task                                                                                          | Read                                                                                                                       |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Understand the model and the three objects (`j`, the entity builder, `journal`)               | [The model](docs/agent-guide.md#the-model), [Three objects](docs/agent-guide.md#three-objects)                             |
| Set the journal up in an app                                                                  | [Setup](docs/agent-guide.md#setup)                                                                                         |
| Add an event and react to it in the same transaction                                          | [Add an event](docs/agent-guide.md#add-an-event-and-react-in-the-same-transaction)                                         |
| Add an entity, with create and delete                                                         | [Add an entity](docs/agent-guide.md#add-an-entity-with-create-and-delete)                                                  |
| Add an effect that runs after commit                                                          | [Add an effect](docs/agent-guide.md#add-an-effect-that-runs-after-commit)                                                  |
| Add a command and run it from a request or a job                                              | [Add a command](docs/agent-guide.md#add-a-command-and-run-it)                                                              |
| Add a durable workflow: steps, waits, undo, operators                                         | [Workflows](#workflows), [agent guide: Workflows](docs/agent-guide.md#workflows)                                           |
| Find out why a write failed                                                                   | [Find out why](docs/agent-guide.md#find-out-why-a-write-failed), [Errors](docs/agent-guide.md#errors)                      |
| Check or repair a row, rebuild a read model                                                   | [Recovery verbs](docs/agent-guide.md#recovery-verbs)                                                                       |
| Wire it in a Dot app, or ship journal pieces from a package                                   | [Dot](docs/agent-guide.md#dot), [Shared packages](docs/agent-guide.md#shared-packages)                                     |
| Watch or stop every command or effect run from a unit (tracing, logging, a circuit breaker) | [Hooks](#hooks): `journal.hooks.command.around`, `journal.hooks.effect.around`                                             |
| Change code inside this package                                                               | [Rules that bite](docs/agent-guide.md#rules-that-bite), [Do not clean these up](docs/agent-guide.md#do-not-clean-these-up) |

## Install

```sh
bun add @arki/journal
# or
npm install @arki/journal
```

The tables live in your Drizzle schema (`journalTables()` from `@arki/journal/pg`). Create them with your migration tool.

Optional peers: `@arki/dot`, `@orpc/server`, `@arki/http`, `@electric-sql/pglite` and `drizzle-kit` (only for `@arki/journal/testing`).

## Quick start

The example is a sketch of an app, not one runnable file. Each comment names the file the code goes in. It needs your schema, a database and a mailer.

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
// src/journal.ts — once per app. `meta` is the app-wide metadata schema.
import { CommandConflict, CommandNotFound, initJournal, need } from '@arki/journal';
// src/schema.ts — the journal tables live in the app's schema.
import { journalTables } from '@arki/journal/pg';

export const tables = journalTables(); // or journalTables(pgSchema('app'))

export const j = initJournal({ tables, meta: z.object({ actorId: z.string() }) });
// Or, to type `tx` everywhere with the app's own Drizzle transaction type:
// export const j = initJournal.tx<AppTx>().create({ tables, meta: ... });
// And to type `db` inside effects with the app's own database type:
// export const j = initJournal.tx<AppTx>().db<AppDb>().create({ tables, meta: ... });

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
// A rule that says no returns a failure: the command rolls back and `run` returns it, typed.
export const payOrder = j.command(
  'payOrder',
  z.object({ orderId: orderIdSchema, amount: z.int().positive() }),
  (input, { write }) =>
    write(order, input.orderId, row => {
      if (!row) return CommandNotFound({ detail: 'Order not found' });
      if (row.status !== 'placed') return CommandConflict({ detail: `Order is already ${row.status}` });
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

// src/journal.root.ts — the one place that lists handlers.
export const journal = j.compose({ projections: [customerStats], effects: [orderMail], services: { mailer } });

// The request context binds the door once: the database and the signed-in actor.
export const createContext = (user: User) => ({ user, runCommand: journal.bind(db, { actorId: user.id }) });

// A procedure. The schema is reused. A rule that says no returns a failure; `commandErrors()`
// from `@arki/journal/orpc`, on the builder, answers the client with its code and status.
// A contract-first procedure hands the result to `orThrowRpc` instead (see Rejected rules).
export const pay = protectedProcedure
  .input(payOrder.input.pick({ orderId: true, amount: true }))
  .handler(({ context, input }) => context.runCommand(payOrder, input));

// Boot. One worker per process runs the async lane. Root database only, never a transaction.
// `journal.run(db, ...)` wakes it after each commit that queued a job.
const worker = journal.worker(db);
await worker.start();
```

## When not to use this

- You want a general event store with streams you read back. Reads here are plain Drizzle queries. Replay is for checks and repair, not for reading.
- You do not use Drizzle and Postgres. The tables and transactions assume both.
- You need exactly-once effects. Effects run at least once, after the commit. Make them safe to repeat with the job id.
- You need to run work outside a transaction. Every write is one transaction.
- You want a general job queue. The job table serves effects. For a queue, see `@arki/queue`.

## Runtime support

The core and `@arki/journal/errors` hold no driver. They load on Node, Bun, Deno and in the browser. `bun run test:runtimes` proves that. The write path needs a Drizzle database on Postgres, so it runs where your driver runs (Node, Bun). `@arki/journal/testing` runs an in-memory PGlite for tests.

## Commands

`j.command(name, inputSchema, handler)` returns a plain value with `name`, `input` (the schema, so a procedure can reuse or `.pick` it) and the handler. Nothing is registered anywhere. The handler gets the parsed input and a context:

- `tx`: the command's transaction. Use it for reads, or for writes outside any entity.
- `meta`: the parsed metadata. Every `write` in the command records it.
- `write(entity, id, events)`: `journal.write` bound to `tx` and `meta`. `events` is `(row, { tx }) => pending events`, sync or async.
- `run(child, input)`: run another command in a savepoint of the same transaction, with the same `meta`.

`journal.run(source, command, input, meta)` parses `input` with the command's schema (`parseAsync`; a schema failure returns before the handler runs) and `meta` with the app schema, then calls the handler inside `source.transaction(...)`. The root database opens a transaction. A transaction opens a savepoint, so the caller still decides the commit. It returns what the handler returns. Errors pass through unchanged.

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

A webhook or a retried request can run the same command twice. `journal.run(db, cmd, input, meta, { idempotencyKey })` makes the second run answer like the first and write nothing. The first run records the key, the command name, the parsed input and its result in `journal_receipts`, inside its own transaction, so a receipt exists exactly when the run committed. A later run with the same key and the same input returns the stored result without running the handler; hooks still run and see `ctx.idempotencyKey`. The same key with another input, or with another command, returns `CommandConflict` (`journal.conflict`). A concurrent repeat waits for the first to commit, then replays it. A key cannot be reused inside its own run.

The result must survive JSON, because the replay returns the stored form; a result with a `Date` or a class instance fails the first run with `UNSTABLE_SCHEMA`. Return plain data: an id, a status, a version. A key from outside is scoped by the app: `${tenant}:${eventId}`, never the bare client value. A bound runner and an effect's `ctx.run` take the key per call: `runAs(cmd, input, { idempotencyKey })`.

A replay does not run the handler, so a permission check inside the handler does not run either. Put it in the command's `authorize` option: `j.command(name, input, handler, { authorize: (input, { tx, meta }) => ... })`. It runs inside the transaction on every call, a replay included, before the stored result is returned; it returns a failure (`CommandForbidden`, usually) to refuse, and a refused replay changes nothing. `journal.run` returns that failure, and the command's type includes it. A throw refuses too.

Receipts hold inputs and results, so they can hold personal data, and `forget` does not touch them. An app that keys personal flows prunes on a schedule: `journal.pruneReceipts(db, { before })`.

### Idempotent HTTP requests

Command receipts protect a command. A retried HTTP request also wants its whole response back, and that response is not part of the business transaction. For that, `@arki/journal/http` gives a `ResponseCache` on `journal_receipts` for the `idempotent()` middleware of `@arki/http/idempotency`:

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
import { idempotent } from '@arki/http/idempotency';
import { responseCache } from '@arki/journal/http';

idempotent({ cache: responseCache(db, tables), scope, routes: ['POST /orders'], ttl: 86_400_000 });
```

Give it the root database, not a command's transaction. Cache rows use `http:` keys and `command = 'http.response'`. Pending reservations have no expiry. `begin` atomically claims a missing key or takes over an expired completed replay. `finish` checks the owner and atomically writes the response and expiry, starting replay retention at that moment. A missing or different owner returns `IdempotencyOwnershipLost`; database rejection returns the operation's unconfirmed failure with a private cause. Invalid replay data returns `IdempotencyReplayInvalid`. `abandon` releases only a pending reservation owned by the caller, after application reconciliation proves repetition safe. `pruneReceipts` preserves every unresolved reservation and every unexpired replay, even when its recording time is old.

Upgrade with all old writers stopped: drain active requests, inventory legacy pending rows, reconcile their application outcomes, and preserve unresolved rows with `expires_at = NULL` before reopening traffic. Do not delete a pending row merely because its old TTL elapsed. Mixed writer versions are unsafe: an old writer can restore expiry on an unresolved reservation. Store loss still needs durable application receipts to prevent duplicate business work.

For oRPC, `idempotent({ scope })` from `@arki/journal/orpc` reads `Idempotency-Key` from `context.headers`. Place it before `actorRun`: `os.use(idempotent({ scope: ctx => ctx.session?.user.id })).use(asActor)`. Each command the procedure runs then uses `${scope.length}:${scope}:${key}:${commandName}` as its receipt key (the length keeps a key with colons from reaching another scope), so a procedure with two commands replays both. The same effect without oRPC: `journal.bind(db, meta, { idempotencyKey, keyPerCommand: true })`.

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

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
// src/features/orders/effects.ts
export const closeAfterPayment = j.effect('close-after-payment', order, {
  OrderPaid: (e, { run }) => run(closeOrder, { orderId: e.entityId }, { actorId: 'system' }),
});

// src/journal.root.ts
export const journal = j.compose({ effects: [closeAfterPayment] });
```

- `run(command, input, meta)` is `journal.run` on the root database that the worker or `drain` was given. It opens its own transaction and commits before it returns.
- `meta` is required. The library never picks an actor. An app may still wrap `run` in one small helper, so the system actor is written in one place.
- If the command throws, nothing of the command is committed, and `run` returns the throw as `TransactionDefect`. An effect that throws it on (`orThrow`) is retried with backoff, like any throw. An effect that returns it is dead: a returned failure is final.
- If the effect fails after `run` returned, the command stays committed and the job runs again. So the command can run twice. Make it safe: check the row and return `[]`, or pass `jobId` in the input and store it as the key. `jobId` is the same on every retry.
- A command that queues a job wakes the worker. A chain of effects does not wait for the poll.

## The low-level write

`journal.write(tx, entity, id, { meta, events })` is what a command's `write` calls. Use it directly only when there is no command: a one-off migration step, or a test that needs a specific `meta` per write. `events` is the function that looks at the locked row, checks the rules, and returns the events to append. It runs after the row is locked, inside the write's savepoint, and receives that savepoint as `{ tx }`, so it can read related rows under the lock. It may be async. It only accepts events declared on the entity; the row type, the id type and the event data types are all inferred. When a rule says no, `events` returns a failure instead, such as `CommandNotFound({ detail: 'Order not found' })`: the savepoint rolls back, nothing is written, and `write` returns that failure. A command handler returns it on (`if (isFailure(paid)) return paid;`), and the whole command rolls back. Going on to a success is `IGNORED_FAILURE` (see Rejected rules).

`expectedVersion` is the row version the caller saw. If the stored version differs (0 for no row), the write is refused with `CONFLICT` before `events` runs. A command passes it on: `write(order, id, events, { expectedVersion: input.version })`. The client sends the version it rendered; `commandErrors()` turns the refusal into a 409 that asks it to reload. This is how concurrent editors and stale game moves are caught without a hand-written version compare.

`write` returns `{ row, events }`, or the failure `events` returned: the stored row after the write (`null` after a delete) and the recorded events, each with `seq`, `id`, `entityId`, `version`, `meta`, `recordedAt` the trace `commandId`, `causeSeq`, `correlationId` (see Tracing), and `erasedAt` (see Erasure). An entity can be created again after a delete; its version continues from the last event.

### Rows that existed before the journal

A row the journal creates gets version 1 from its create event. A row that was there first (stored `version` 0, no events in the log) can still be written to, but its history starts at version 2: the first write treats the row as version 1 and records its event as version 2. Version 1 therefore always means "created from nothing". `replay`, `verify` and `repair` need a history that starts at version 1 and throw `NO_HISTORY` otherwise, because folding a partial history from nothing would pick the wrong reducers and build the wrong row. They also need every version up to the top, and a live row no newer than its log, and throw `HISTORY_GAP` otherwise: an event lost after it was written must be restored, not folded around.

To bring such a row in properly, adopt it before its first write. `journal.adopt(tx, entity, id, { meta, events })` takes the row at version 0 with no history, calls `events(row)` for exactly one create event built from the stored row, and checks that the event's `.create` reducer rebuilds the row exactly, column by column. If it does, the event is recorded as version 1 and the row moves to version 1: the history is complete, and `replay`, `verify` and `repair` work from then on. If it does not, `VALUE_MISMATCH` names the column and nothing changes. A row the journal already knows, a missing row, or a legacy row that was already written to is `CONFLICT`. Projections run and effects are queued as for any write, because the event is the app's own. Run it once per legacy row, in a migration or a one-off script, before the app writes to the row.

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
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

`initJournal({ tables, meta })` types the command's `tx`, `write`'s `tx`, `events`' `{ tx }` and projection handlers' `tx` with the structural `DbHandle`. To use the app's own Drizzle transaction type instead, so repositories typed against it fit, declare it once: `initJournal.tx<AppTx>().create({ tables, meta })`. `tx` is a type-only step. `run` and `rerun` then take any database that opens `AppTx` transactions; `drain` and `worker` keep taking the root database. To name the root database type as well, see Effects.

### Reducers

Events are read-only. A reducer, projection or effect that tries to change `e.data` or `e.meta` gets a `TypeError`. Copy first: `[...e.data.items].sort()`.

An `.on` reducer receives the reducer-shaped state (`ReducerRow<Tbl, Key>`: the insert shape plus the key column and `version`) and returns a patch, `Partial<ReducerValues<Tbl, Key>> | null`. The patch is merged onto the state. A key set to `undefined` means unchanged. `events(row, { tx })` still receives the stored `Row<Tbl> | null`.

Columns that every `.create` reducer sets are required on the `.on` row. A column one create leaves to its database default, sets on one branch only, or may set to `undefined`, stays optional. The rule: every `.create` comes before the first `.on`. After the first `.on` the builder has no `.create`, and calling one anyway throws, because a later create could leave out a column the `.on` was promised. An `.on` declared before any `.create` sees the plain insert shape.

One event may have both a `.create` and an `.on` reducer, for an event that may open an entity or update it (a grant, a flag). The fold picks by state: no row runs the create reducer, a row runs the on reducer. An event with only a create reducer on an existing row is `ROW_EXISTS`; an event with only an on reducer and no row is `NO_ROW`. Declaring the same event twice in the same mode throws at definition time.

A reducer must produce each value in the form the database stores. If the database would round or trim it, the write is refused with `VALUE_MISMATCH`. The message names the entity, id and column, and shows both values. For a `numeric(10,2)` column, a reducer that returns `"1.234"` is refused, because the database stores `1.23`. Return `"1.23"` instead. Why: `replay` and `repair` recompute the row from reducer output. Later reducers read the stored row. If the two differ, a correct balance drifts. For a JSON column, a reducer may produce plain objects, full arrays, strings, numbers, booleans and `null`. A `Map`, a `Set` or an array with holes is refused, because JSON storage would lose its contents. A custom column may hold a value object: a class instance with an `equals` method, such as a Temporal `Instant` from `@arki/db/temporal`. It is compared with its `equals`, so a value the column rebuilds exactly passes and a value the column changed is refused. The check covers the columns a reducer set in this write. `repair` makes the same check and leaves the row as it was.

Database defaults are not journal state. `write` folds from the stored row, where a default-filled column has its value. `replay` folds from nothing, where that column is `undefined`. That is why such columns are optional in the `.on` row type unless a create sets them. The rule: a reducer must set every column that any reducer later reads. In a `.create` result, a key set to `undefined` is stripped and the default applies. `verify` compares only the columns reducers set.

Every schema the journal takes is a Standard Schema: zod, valibot, arktype or a hand-written `~standard` object. Command input and a command's `meta` are parsed async (`parseAsync`). Everything else is parsed sync (`parse`): the event constructor, `write`'s event data and `meta`, replay and upcasters; an async schema there returns `AsyncSchema`. `initJournal()` without `meta` accepts a plain object and records `{}`.

`write` parses every event's data with its schema, even for a hand-built `{ type, data }`. The schema must accept its own stored output unchanged, because replay parses stored data again; otherwise `write` throws `UNSTABLE_SCHEMA`. The same rule applies to `meta`. An optional key holding `undefined` in event data is not stored: JSON drops it, so the stored event, the reducers and replay all see the key as absent. The check allows this, because absent and `undefined` read the same way. Leaving the key out is the same thing.

An error about one entity's row or history is a `JournalError` with a `code`. Match on the code, never on the message. The message names the entity kind and id, adds the event type and version when the journal knows them, and ends with the next step.

The codes, the usual cause of each and what to do are in one table: [agent guide, Errors](docs/agent-guide.md#errors).

Other errors are not `JournalError`. A wrong definition or a misuse is a plain `Error` whose message starts with `journal:`. Input, event data or `meta` that fails its schema returns `InvalidInput` from `@arki/failure`, with `data.issues`. An async schema in a sync call returns `AsyncSchema`; a throwing validator returns `ValidatorDefect`. Event constructors return these failures too; `write` accepts them in its event array and rolls back before appending anything. An unexpected exception from a command handler, `authorize` or an execution hook becomes `TransactionDefect` with the original private `cause`; the transaction rolls back before it is returned. This includes an awaited `write` callback, reducer or projection inside a command. Direct low-level operations still expose their documented exception contract.

### Upgrading command and durable job outcomes

ID generation uses secure Web Crypto and preserves the existing prefixes and 24-character bodies. `jobId()`, `write`, `adopt`, `drain`, job operation verbs and outgoing webhook subscribe/dispatch/replay can return the original `IdGenerationFailure` from `@arki/contracts`. Check it with `isFailure` before using the success value. Command and workflow runners include these definitions in `COMMAND_FAILURES`; a refused write rolls back its savepoint and a refused claim never leases or acknowledges a job.

Handle `CommandFailure` as part of a runner's inferred result. Receipt key mismatches now return `CommandConflict`; remove exception catches that translate `JournalError` `CONFLICT` around `journal.run`. Declared RPC error maps must include `COMMAND_FAILURES` (spread the definitions into `errorMap`), alongside the command's domain failures. Authorization still runs before every receipt replay, and a refusal or callback defect never creates a receipt.

Workflow step timeouts persist canonical `Deadline` failures. The command transaction owner normalizes unexpected handler, authorize and hook exceptions as `TransactionDefect`; effect and workflow body exceptions become `UnexpectedDefect`. Its original exception is a private `cause`, excluded from persisted JSON and client responses. A throw in an effect or a step is retried by its `retry`, or else by the default (8 tries, 1 s up to 5 minutes), the same rule as `@arki/queue`. The `while` of a `retry` sees the exception itself, not the defect. A returned failure is final, unless that `while` accepts it. A raw queue `JobRunner.run` returns its outcome; a returned failure goes to `retryDelay` unchanged and never acknowledges the job as successful.

Every command uses the existing single-attempt database transaction boundary, including root databases and nested savepoints. It returns canonical database rejection, unavailability, cancellation and uncertain-COMMIT failures without retry. A failed rollback is a defect with the driver error and refused value as private evidence, never a reported refusal. A lost COMMIT acknowledgment is uncertain: reconcile or repeat the same scoped receipt key, rather than claiming the write rolled back or retrying without a receipt.

Durable workflows resume their pinned name and version, with persisted step identities, waits and cancellation. Keep old definitions registered until their runs finish. Missing or structurally incompatible code leaves the run unchanged and persists `WorkflowStranded` (`journal.workflow_stranded`) with its run id, version and reason. Restore the pinned code before an operator retries the dead job. A graph hash only checks structure: changing handler semantics requires a new version even when node names stay the same. External effects are at least once; pass `ctx.key` or `jobId` to the external service as its idempotency key.

### Rejected rules

A rule of the app that rejects a request returns a failure from `@arki/failure`. The journal has four, each with `{ detail }`, the message written for the client: `CommandNotFound` (`journal.not_found`, 404), `CommandInvalid` (`journal.invalid`, 400), `CommandForbidden` (`journal.forbidden`, 403) and `CommandConflict` (`journal.conflict`, 409). An app may return its own `defineFailure` values too. A command handler, its `authorize` and an `events` function can return one. The command's transaction rolls back exactly as for a throw, and `journal.run` returns the same failure instance; its type is inferred from the handler. A child's failure comes back from `context.run` as a value: its savepoint is already rolled back, and the parent returns it on. Once a write's `events` or a child command returned a failure, the command is doomed: it must end with a failure, that one or another. A handler that still returns a success is missing an `if (isFailure(x)) return x;`, so the run returns `TransactionDefect` with a private `JournalError` `IGNORED_FAILURE` cause, which names the write or child and the failure code, and nothing commits. An ignored refusal never commits the rest of the command. An effect whose `ctx.run` returned a failure it did not accept, and that still returns a success, fails its job with that failure: dead after one try by default, not retried, because a retry would run again the commands that did commit. A failure is never stored as an idempotency receipt, so a repeat runs again. It is not a `JournalError`: a `JournalError` is the library's own failure, a command failure is the app saying no.

A handler that meets a refusal and still has a good answer says so with `accept(result)`, on the command context and on an effect's context. Check the value first, then accept it. `accept` lifts only this command's own check: a refused child's savepoint stays rolled back, and the fallback's own refusals are tracked too. It returns nothing and commits nothing by itself: a handler that accepts a failure and then returns it still rolls back. Every refusal is tracked by identity, once per return: two refusals with the same code need two `accept` calls, and so does the same object returned twice. Accepting one and ignoring another is still `IGNORED_FAILURE`. An accepted success is stored as the idempotency receipt like any success. `accept` throws `JournalError` `INVALID_ACCEPT` for a value no `write` or `run` of this handler returned (hand-built, from a helper, a copy, or one only the parent received), for a second call on one return, for a call after the handler finished, and for a value that is not a failure. A parent may accept a failure its child passed up, and a child's `authorize` refusal, since both come back from `run` as the same instance.

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
const placeOrder = j.command('placeOrder', orderInput, async (input, { write, run, accept }) => {
  await write(order, input.orderId, () => [OrderPlaced({ customerId: input.customerId, total: input.total })]);
  const stock = await run(reserveStock, input.line);
  if (OutOfStock.is(stock)) {
    accept(stock); // the child's savepoint is already rolled back; only this command's check is lifted
    const backorder = await run(placeBackorder, { orderId: input.orderId, sku: stock.data.sku, qty: stock.data.short });
    if (isFailure(backorder)) return backorder;
    return { status: 'backordered' as const };
  }
  if (isFailure(stock)) return stock; // any other refusal still refuses the order
  return { status: 'reserved' as const, reservationId: stock.reservationId };
});
// Inferred: { status: 'backordered' } | { status: 'reserved'; reservationId: ... } | the other failures. No 'stock.out'.
```

An oRPC app maps it once, with `@arki/journal/orpc`. `@orpc/server` is an optional peer. The core entry never imports it.

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
// src/core/orpc.ts
import { commandErrors } from '@arki/journal/orpc';

// After the app's own error middleware, so a rejected rule is already an `ORPCError` when that one sees it.
export const publicProcedure = os.use(appErrors).use(commandErrors());
```

`commandErrors()` answers a failure, thrown or returned by the procedure, with the `ORPCError` of its code, status, message and data, and a `JournalError` with code `CONFLICT` with a 409 that asks the client to try again. Every other error passes unchanged. `toORPCError(error)` is the same mapping as a function. A procedure with an output schema, and every contract-first one, hands the command's result to `orThrowRpc(result, errors)` from `@arki/failure/orpc`, with the failures listed in the contract by `errorMap(CommandNotFound, ...)`; the client then gets them typed. A host without oRPC reads the failure's `status`, or matches it with `CommandNotFound.is(result)` and the like. The codes and their HTTP meaning are in the [agent guide](docs/agent-guide.md#rejected-rules).

Other verbs: `replay(db, entity, id, { throughVersion })` (returns the reducer-shaped row), `verify(db, entity, id)`, `repair(db, entity, id)`, `rerun(db, projection, { afterSeq, batchSize })`, `drain(db, { batchSize, signal })`. `drain` and `worker` take the root database (`RootDb`), never a transaction: effects must run after commit. Lease and retry times use the database clock.

### Changing reducers later

`replay`, `verify` and `repair` use today's reducers and today's event schemas. They do not remember the code that ran when the event was written.

So changing how an existing event is reduced changes what `repair` writes for existing rows. `verify` will report those rows as drifted.

For a new meaning, add a new event type. Leave the old reducer as it is.

### Changing events later

Adding an optional field, or one with a default, is safe. Old rows still parse.

For any other change to an event's data, such as a rename, a new required field, or a new structure, keep the old schema and add an upcaster:

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
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

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
export const orderMail = j.effect(
  'order-mail',
  order,
  { mailer: need<Mailer>() },
  {
    OrderPaid: (e, { jobId, mailer }) =>
      mailer.send({ template: 'order-paid', orderId: e.entityId, idempotencyKey: jobId }),
  },
);

export const journal = j.compose({ effects: [orderMail], services: { mailer } });
```

- `need<Mailer>()` comes from `@arki/journal`. It is a marker: it holds the type and no value.
- Each handler gets the service in its context, under the name of the need, with its type.
- The app gives the real services once, in `services`. Every need of every listed effect must be there. A missing one is a compile error, and `compose` throws: `journal: effect "order-mail" needs "mailer", but no service with that name was given; ...`.
- Two effects that use the same name get the same service.
- A need cannot be named `jobId`, `signal`, `db` or `run`. `j.effect` throws.
- An effect that needs nothing has three arguments: `j.effect(name, entity, on)`.

`db` has the library's `RootDb` type unless the app names its own database type once: `initJournal.db<AppDb>().create({ tables, meta })`. Then `ctx.db.query.orders` is typed, and `drain` and `worker` need an `AppDb`. They still refuse a transaction. With `.tx<AppTx>()` they also need a database that opens `AppTx` transactions, because effects run commands on it. The app's own Drizzle database does. `.tx<AppTx>()` and `.db<AppDb>()` are both optional type-only steps and chain in either order: `initJournal.tx<AppTx>().db<AppDb>().create({ tables, meta })`.

### When a job runs

An effect can carry a schedule: `j.effect('receipt', order, handlers).withSchedule({ priority: 10 })`. `priority` (an integer, default 0): among due jobs the higher one is claimed first. It is strict, so a steady stream of high-priority jobs can starve lower ones; use a few levels, not a score. `delaySeconds`: the job is due that long after the write's transaction started (Postgres `now()`), so a long transaction uses part of the delay before commit. `runAt: event => Date`: the job is due at the time the event names, from the app's clock; a time in the past is due at once. Give `delaySeconds` or `runAt`, not both. `when: event => boolean`: the write makes a job only for the events where it returns true, so `withSchedule({ when: e => e.data.total > 10_000 })` queues nothing for small orders. The default is every event of the effect's types. `retry`: a `Backoff` from `@arki/resilience` (re-exported here as `backoff`), the same retry schedule queue jobs and resilience policies take. It says how long a failed job waits before its next try, and when it is dead instead: `withSchedule({ retry: backoff.exponential({ base: 5_000 }).upTo(3).while(error => error instanceof SmtpError) })`. The default is `backoff.exponential({ base: 1000, max: 300_000, jitter: 0.25 }).upTo(7)`: 8 tries, doubling from 1 s to at most 5 minutes. A throw is retried by the effect's `retry`, or by this default. `lastError` records the throw as `UnexpectedDefect`, but the `while` gets the error the handler threw, as is. Retries keep their priority. A handler may also return a failure from `@arki/failure` for an expected outcome, such as a declined card: the job is then dead after one try, because another try would repeat it. It runs again only when the `while` accepts that failure, as in `.while(reason => isFailure(reason) && reason.code === 'db.timeout')`. Its `lastError` is the failure as JSON: code, message, status and data. A bad value throws `BAD_DEFINITION` where the schedule is declared.

## The worker

`journal.worker(db, { pollMs, batchSize })` is a loop around `drain`. When a pass finds no job it sleeps `pollMs` (1000 by default).

- A pass claims one job at a time, right before it runs it, up to `batchSize` jobs. So each job's lease (`leaseSeconds`, default 60) covers its own work only, and a slow job cannot let the lease of a later one run out. A job queued during the pass can run in the same pass.
- While an effect runs, the worker renews its lease every half lease, under its own token. A long effect is safe for as long as its worker is alive. If the renewal finds the lease gone (the worker stalled past a whole lease and another worker reclaimed the job), the effect's `ctx.signal` aborts so it can stop, and its result is not acknowledged: the other worker owns the job now. An effect that does external work should still pass `jobId` on as an idempotency key, because the stall can happen between the work and the ack.
- `stop()` aborts the running effect's `ctx.signal`, claims no further job, and resolves when that effect returns. An effect that does long work should pass `ctx.signal` on (for example to `fetch`) so shutdown does not wait for it.
- Give `drain` or `worker` a `jobs` runner and it claims queue rows too, from the same table, under the same lease, renewal and fenced ack. See [Queue jobs in the jobs table](#queue-jobs-in-the-jobs-table). Without `jobs` it claims effect rows only, as before.
- `drain` and the worker never claim a job whose effect this journal does not have. During a rolling deploy an older worker may still have it. After the deploy, `journal.strandedJobs(db)` lists what is left, counted per effect name (see [Operating the jobs](#operating-the-jobs) for the shape). A non-empty list means an effect was renamed or removed while it had jobs: bring it back under its old name until the count is zero, or delete those rows on purpose.

A wake ends the sleep, so an effect does not wait for the next poll:

- `journal.run(db, ...)` on the root database wakes by itself. The library committed the transaction, so it knows when. It wakes only when the command queued a job.
- With your own transaction (`journal.run(tx, ...)` or `journal.write(tx, ...)`) nothing wakes. The library cannot see your commit. Call `journal.wake()` after you commit.
- `journal.wake()` wakes every running worker this journal started in this process. `worker.wake()` wakes one worker. With no running worker a wake does nothing.
- A wake that arrives while a pass is running is not lost: one more pass runs right after. Many wakes make one extra pass.
- The wake works inside one process only. Other processes pick jobs up by polling.

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
await db.transaction(async tx => {
  await journal.run(tx, payOrder, input, meta);
  await tx.insert(auditLog).values(entry);
});
journal.wake(); // after the commit
```

## Taps and the wake channel

Every commit that recorded events notifies a Postgres channel, `journal.wakeChannel` (`journal_wake`, or `<schema>_journal_wake` for tables in a schema), with the seq range as JSON: `{ "from": 12, "to": 14 }`. Postgres delivers `NOTIFY` at commit, so a listener hears exactly the commits that happened, in every process, including commits of transactions the caller manages, where `journal.wake()` cannot help. The payload is small and bounded; a listener loads what it needs by seq.

A worker hears it through `listen`: `journal.worker(db, { listen })`, where `listen` is `onMessage => unlisten`. `LISTEN` needs a dedicated connection. With a `pg` pool, use `listenOnPool(db.$client, journal.wakeChannel)` from `@arki/db/pg`: it borrows one client for as long as the worker runs, replaces it when the connection drops, and closes it on `stop()`. With PGlite, `onMessage => client.listen(journal.wakeChannel, onMessage)`. `LISTEN` hears only what is sent after it ran, and a connection can drop, so the worker keeps polling (`pollMs`); the channel makes it prompt, not correct. A listening worker drains at once on every commit.

Taps or live queries? A tap reacts to an event in this process, after commit: a metric, a cache, a push to this process's subscribers. A page that shows the current rows of a table wants `@arki/live` instead: a statement trigger publishes every commit to the table, whether a command, a repository, raw SQL or a worker made it, so it needs no tap.

A tap is a handler that fires from that channel: in-process, after commit, lossy. No job row, no retry, no order promised across entities. `j.tap('live-orders', order, { OrderPlaced: (e, { db }) => hub.publish(e) })`, with needs like an effect: `j.tap(name, entity, { hub: need<Hub>() }, handlers)`, given in `compose({ taps, services })`. It fires in every process whose worker listens, for every event in the announced range that it names, in seq order, with the root database and no `run`: a tap may not issue commands, because a lost notification must never mean lost writes. An error in a tap is logged and swallowed; the command already committed. Taps are not wrapped by effect hooks. A journal with taps refuses a worker without `listen`, unless `{ taps: false }` says that worker runs jobs only and another process listens. For a live page, a cache, a metric. For work that must happen, write an effect.

## Hooks

The one way to watch or stop a run from outside is a hook: a wrapper that receives the context and `next`. Register at boot, before any work.

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
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
- Registration is frozen once the journal has run a command, a drain or a worker. A later `around` throws `BAD_DEFINITION`. In a Dot app, a unit that needs the journal attaches in `boot`, which runs before the worker starts.

## Operating the jobs

A job is in one of four states. The state comes from the database clock.

- `ready`: due now, waiting for a worker.
- `delayed`: waiting for its due time.
- `running`: a worker holds its lease.
- `dead`: the worker gave up, because the effect's `retry` said stop (after 8 tries by default, or after one for a returned failure). `lastError` says why.

`pending` means `ready`, `delayed` and `running` together. It is the default filter. `all` adds the dead ones.

**Reads.** They take the root database. A list returns `{ jobs, next }`. `next` is an opaque cursor: pass it back as `after` for the next page, and never build or read it yourself. It is `null` on the last page. A page has 100 jobs by default and at most 200; a larger `limit` is `BAD_ARGUMENT`. The cursor holds the exact Postgres timestamp, so paging never repeats or skips a row.

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
const { jobs, next } = await journal.jobs(db, { status: 'dead', effect: 'sendWelcomeMail', limit: 50 });
const second =
  next === null
    ? undefined
    : await journal.jobs(db, { status: 'dead', effect: 'sendWelcomeMail', limit: 50, after: next });

const detail = await journal.job(db, 'job_abc'); // the row and its state, the event header, attemptLog, the latest operations; undefined if gone
const counts = await journal.jobCounts(db); // per effect or job name: ready, delayed, running, dead, oldestDeadAt
const history = await journal.jobOperations(db, { limit: 20 }); // newest first, same { ..., next } paging
```

`effect` filters effect rows by effect name. `job` filters queue rows by job name. `journal.job` never reads the event payload, only its header. `journal.jobOperations(db, { jobId, limit, after })` lists who did what, newest first.

**Verbs.** Every verb that changes a job takes `op` as its last argument: `{ actor, reason?, executionId? }`. `actor` is a free string you own (a user id, a script name) and must not be empty. `executionId` is the Foreman execution that asked, when there was one. Each verb that changes something writes exactly one row to `journal_job_operations` in the same transaction, so the audit and the change commit together or not at all. A verb that changes nothing writes no row.

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
const op = { actor: user.id, reason: 'provider outage' } as const;

await journal.retry(db, jobId, op); // dead -> pending, due now, attempts and lease cleared, workers woken
await journal.discard(db, jobId, op); // dead job leaves the hot table, archived as 'discarded'
await journal.cancel(db, jobId, op); // ready or delayed job leaves the hot table, archived as 'cancelled'
await journal.retryDead(db, { ids: [firstId, secondId] }, op); // or { effect: 'sendWelcomeMail', limit: 200 }
await journal.purgeDead(db, { olderThan: new Date(Date.now() - 45 * 86_400_000), limit: 500 }, op);
const { jobId: replayedId } = await journal.replayJob(db, archivedId, op); // a NEW job from an archived one
```

Each of `retry`, `discard`, `cancel` and `replayJob` returns `{ operationId }` (`replayJob` also returns the new `jobId`). They throw a `JournalError`:

| Code              | When                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `JOB_NOT_DEAD`    | `retry` or `discard` on a job that is not dead. Retrying a live job would run it twice.  |
| `JOB_NOT_PENDING` | `cancel` on a job that is dead or gone.                                                  |
| `JOB_RUNNING`     | `cancel` on a job a worker holds. Deleting it would not stop its work.                   |
| `JOB_EXISTS`      | `replayJob` while an unfinished job holds the same dedupe key.                           |
| `BAD_ARGUMENT`    | A bad `limit`, a bad cursor, an empty `actor`, or a `purgeDead` bound that is too short. |

Bounds on the batch verbs:

- `retryDead` takes either `ids` (at most 500) or a filter over dead jobs, oldest dead first: `effect`, `job`, `deadBefore`, `limit` (default 100, at most 500). With `ids` it is all or nothing: if one id is not dead, nothing changes. It returns `{ ids, operationId }`. `operationId` is `null` when nothing matched.
- `purgeDead` takes `olderThan` and a `limit` (default 1000, at most 5000). It refuses an `olderThan` that is newer than `retention.retryableFor` allows, with `BAD_ARGUMENT`: that would remove dead jobs an operator may still retry. It moves matching dead jobs to the archive, or deletes them, as the retention policy says. It returns `{ archived, deleted, operationId }`.

**`replayJob` is not `retry`.** `retry` brings back the same job with the same id. `replayJob` makes a new job from a finished job in the archive: same effect or job name, same input, a new id. A provider that deduped on the old `jobId` will not dedupe this run, so its side effect may happen twice. Use it only when you know the first run did not do its work. The new row has `replay_of` set to the archived id, and the operation row says `replay`. It is called `replayJob` because `journal.replay` already rebuilds an entity from its events.

**The audit.** `journal_job_operations` keeps one row per verb: `action`, `actor`, `reason`, `executionId`, the job ids it touched, how many, and when. Discard, cancel and purge archive the job with its attempt log first, so nothing an operator removed is gone. The retention sweeper writes its own rows with the actor `system:retention`. How long the audit lives is `retention.operations` (default `'forever'`).

`journal.strandedJobs(db, { jobs })` finds pending jobs that nothing in this process can run. It returns a list of `{ kind: 'effect' | 'queue', name, jobs }`: the kind of row, the effect or job name, and how many rows wait. Queue rows are counted only when you pass the runner as `jobs`. The journal cannot judge a queue job name without it.

## Retention and archive

A finished job does not have to disappear. Three tables hold the story, each with its own clock.

- `journal_jobs` is the hot table. It holds work that can still run (pending) or be retried (dead). A job row used to be deleted when its handler succeeded. Now the success moves it to the archive, if the policy says to keep it.
- `journal_job_archive` holds finished jobs, with their attempts folded in as `attempt_log`. Its `outcome` is `completed`, `dead`, `discarded` or `cancelled`. Each row has a `keep_until` time, worked out from the policy when the row was archived, so every cleanup is a plain comparison.
- `journal_job_operations` holds who did what (see [Operating the jobs](#operating-the-jobs)).

A third helper table, `journal_job_attempts`, has one row per try. It lives and dies with the hot job row.

Move on success is one statement under the lease fence: the fenced `DELETE` feeds the archive `INSERT`. A worker that lost its lease archives nothing.

**The policy.** Give it to `initJournal`, next to `tables`. Every field is optional. `retention.workflows` is the policy for finished workflow runs (see [Workflows](#retention)).

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
import { ndjsonArchiveSink } from '@arki/journal';

export const sendWelcomeMail = j
  .effect(
    'sendWelcomeMail',
    user,
    { mailer: need<Mailer>() },
    {
      UserSignedUp: (e, { jobId, mailer }) => mailer.send({ to: e.data.email, idempotencyKey: jobId }),
    },
  )
  .withSchedule({ retention: { completed: '1d' } }); // this effect keeps finished rows one day

export const auditTrail = j
  .effect('auditTrail', order, { OrderPlaced: (e, { db }) => writeAudit(db, e) })
  .withSchedule({ retention: { completed: 'untilExported' } }); // kept only until the sink has it

export const j = initJournal({
  tables,
  meta: z.object({ actorId: z.string() }),
  retention: {
    retryableFor: '30d', // a dead job stays retryable this long
    archive: {
      completed: '7d',
      dead: { age: '90d', max: 50_000 }, // dead, discarded, cancelled
      sink: ndjsonArchiveSink({ put: (key, body) => storage.put(key, Buffer.from(body)), prefix: 'journal/archive' }),
    },
    operations: 'forever',
    sweep: { every: '1h', batch: 1000 },
  },
});

// The effects are defined on this `j`, then composed.
export const journal = j.compose({ effects: [sendWelcomeMail, auditTrail], services: { mailer } });
```

`journal.retention` is the policy after parsing, with the defaults filled in. The worker, the verbs and the Foreman module all read it.

| Setting             | Default                        | Meaning                                                                              |
| ------------------- | ------------------------------ | ------------------------------------------------------------------------------------ |
| `retryableFor`      | `'30d'`                        | How long a dead job stays in the hot table, retryable. Then the sweeper archives it. |
| `archive.completed` | `'7d'`                         | How long a successful job is kept.                                                   |
| `archive.dead`      | `'90d'`                        | How long a dead, discarded or cancelled job is kept.                                 |
| `archive.sink`      | none                           | Where archive rows go after the table.                                               |
| `operations`        | `'forever'`                    | How long the operations audit is kept.                                               |
| `sweep`             | `{ every: '1h', batch: 1000 }` | How often the sweeper runs, and how many rows each step takes. `false` turns it off. |

**`Keep` has these forms.** It is used for `completed`, `dead` and `operations`:

| Value                                             | Meaning                                                                                                                                                               |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `false`                                           | Never written. The job is deleted the moment it finishes, as before.                                                                                                  |
| `'forever'`                                       | Kept until someone deletes it.                                                                                                                                        |
| `'untilExported'`                                 | Kept only until the sink has it, then deleted. Needs `archive.sink`, or `compose` throws `BAD_DEFINITION` at boot and names the effect. Not allowed for `operations`. |
| `'30d'`, `'12h'`, `'90m'`, or seconds as a number | Kept this long.                                                                                                                                                       |
| `{ age: '90d', max: 50_000 }`                     | Kept this long, and at most `max` rows per outcome and per effect or job name. The oldest go first. `age` may be `'forever'`.                                         |

A bad age is `BAD_DEFINITION`. `sweep.every` of `0` is too.

**Per effect and per queue job.** An effect overrides the journal with `withSchedule({ retention })`. It takes `completed`, `dead` and `retryableFor`, with the same `Keep` forms. A queue job sets the same thing with `.options({ retention })` in `@arki/queue`; the outbox runner passes it to the journal under the job name. The order is: the effect or job, then the journal, then the default. A single job row cannot set its own retention.

**The sweeper.** Every running worker ticks every `sweep.every`. The first tick comes one interval after the worker starts. A tick runs four steps in this order:

1. `purgeDead`: dead jobs older than `retryableFor` move to the archive (or are deleted).
2. `exportArchive`: unexported archive rows go to the sink.
3. `pruneArchive`: rows past `keep_until` are deleted, then the oldest rows beyond any `max`. `'untilExported'` rows go as soon as they are exported.
4. `pruneOperations`: only when `operations` is not `'forever'`.

Each step takes at most `sweep.batch` rows. A failing step is logged and the next step runs. A step that fills its batch logs a warning: the backlog is growing. Several workers can sweep at once, because rows are taken with `FOR UPDATE SKIP LOCKED`. Steps 1 to 3 write one operation row each when they did something, with the actor `system:retention`. Step 4 writes none, because recording its own deletion would never end.

**An app that schedules the sweep itself.** Set `sweep: false`, and call the three verbs from your own schedule. Each one is public and takes `op` as its last argument; without it the actor is `system:retention`.

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
// initJournal({ tables, retention: { sweep: false, archive: { sink } } })
await journal.purgeDead(db, { olderThan: new Date(Date.now() - 30 * 86_400_000) }, { actor: 'cron:journal' });
await journal.exportArchive(db, { limit: 1000 }, { actor: 'cron:journal' });
await journal.pruneArchive(db, { limit: 1000 }, { actor: 'cron:journal' });
await journal.pruneOperations(db, { limit: 1000 }); // no op: it records nothing
```

Each takes at most 5000 rows per call.

**Sink guarantees.** The table is always the first stop. A sink cannot join a Postgres transaction. `'untilExported'` is how an app keeps rows only elsewhere.

- At-least-once. A row's `exported_at` is set only after `sink.write` resolved. A crash between the write and the mark sends the batch again. Dedupe on the row `id`.
- Never prune unexported. While a sink is set, no row is deleted before `exported_at` is set, whatever its age or `max`. A sink that throws leaves the batch unexported and logs a warning. The table grows instead of losing data. `journal.archiveStatus(db)` shows `rows`, `unexported`, `oldestUnexportedAt` and `pastKeepUntil`.
- Ordered inside a batch by `archived_at`, then `id`. There is no order across workers.

**`ndjsonArchiveSink({ put, prefix? })`** writes one NDJSON file per batch: one JSON line per job. The key is `<prefix>/YYYY/MM/DD/<first archived_at in ms>-<first id>.ndjson` in UTC. `prefix` defaults to `journal-archive`. `put(key, body)` is any function that stores a file, so `@arki/fs` fits with no dependency, as above. A store that overwrites by key makes a resent batch harmless.

**Reading the archive.** `journal.archivedJobs(db, { outcome, effect, job, limit, after })` pages finished jobs, newest first, with the same `{ jobs, next }` shape. `journal.archivedJob(db, id)` returns one with its attempt log, or `undefined`. The archive keeps `args` as the hot table does. A `'untilExported'` row is gone from the table once exported: read the file.

## Queue jobs in the jobs table

A queue row is a job that carries no event. An app writes it in its own transaction, so the job exists if and only if the business write commits. The row sits in `journal_jobs` next to the effect rows. `kind` tells them apart: `'effect'` or `'queue'`.

The journal only stores and claims queue rows. It does not know what a job does. A `JobRunner` does. It is a small port: `names`, `run(job, { db, signal })` and `retryDelay(job, error)`. The typed way to write and run these rows is `@arki/queue/outbox`: `runAfter(tx, job, args)` writes the row, and `outboxRunner` is the runner. See the `@arki/queue` README.

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
import { listenOnPool } from '@arki/db/pg';

const worker = journal.worker(db, {
  listen: listenOnPool(db.$client, journal.wakeChannel),
  jobs: outboxRunner({ registry: jobs, context: () => ({ db }) }),
});
```

The two lanes side by side:

|                | Effect row                        | Queue row                                    |
| -------------- | --------------------------------- | -------------------------------------------- |
| `kind`         | `effect`                          | `queue`                                      |
| Written by     | a journal write                   | `runAfter(tx, job, args)` in any transaction |
| Needs an event | yes (`event_seq`, `effect`)       | no (`job_name`, `args`)                      |
| Run by         | the effect handler in the journal | the `jobs` runner                            |
| Retry          | the effect's `retry`              | the runner's `retryDelay`                    |
| Dedupe         | one row per event and effect      | optional `dedupe_key`, per job name          |

What a queue row promises:

| Promise                 | Holds?          | Boundary                                                                                                                                                                       |
| ----------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Atomic scheduling       | Yes             | The row and the business write share the transaction. A rollback removes both, savepoints included.                                                                            |
| Exactly-once enqueue    | Yes             | One row per awaited call in the committed transaction. With a key, one row per key among unfinished rows of that job.                                                          |
| Request idempotency     | No              | Two committed HTTP retries schedule twice, unless a key or a journal receipt covers the whole operation.                                                                       |
| No early visibility     | Yes             | Other connections cannot claim an uncommitted row.                                                                                                                             |
| At-least-once execution | Yes             | The row stays until the fenced ack. A crash between handler and ack runs it again. Pass the job id on as an idempotency key.                                                   |
| At-most-once execution  | No              | A job can run twice.                                                                                                                                                           |
| Eventual success        | No              | When the retry policy stops, the row is dead. List it with `journal.jobs(db, { status: 'dead' })`. `journal.retry(db, id, op)` requeues it with the same id.                   |
| Fenced state            | Yes             | Renew, ack and retry need the current lease token. A stale worker changes nothing. It cannot undo an external effect.                                                          |
| Due time                | Lower bound     | `available_at` is the transaction's `now()` plus the delay. A long transaction uses part of the delay. A job can run late by up to `pollMs` without a listener, or under load. |
| Order                   | None            | Among due rows: higher priority first, then oldest due time. `SKIP LOCKED` is not FIFO. Strict priority can starve low rows.                                                   |
| Lease                   | 60 s by default | Renewed every 30 s while the handler runs. A stalled worker loses the row after one full lease.                                                                                |
| Cross-process wake      | Yes             | `pg_notify` on `journal.wakeChannel`. It is lossy. Polling is the safety net.                                                                                                  |
| Cancel                  | Pending only    | A running row finishes.                                                                                                                                                        |

Rules:

- A worker without `jobs` never claims a queue row. The claim filter is `effect IN (...)`, which never matches a NULL effect. An older worker is safe during a deploy.
- A worker with `jobs` claims only the names in `runner.names`. A row with another name waits. Rename a job and its old rows are stranded: version the names (`mail.welcome.v1`) instead.
- A row is deleted when its handler succeeds. A key dedupes among unfinished rows (pending, running, dead).
- `cancel(tx, id)` on the outbox deletes a row no worker holds.

## Outgoing webhooks

`@arki/journal/http/webhooks` sends signed webhooks to your partners' endpoints. Delivery is a queue row in `journal_jobs`, run by the same worker as everything else. It is optional, and it runs on Node or Bun (it needs `@arki/http`).

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
import { journalTables } from '@arki/journal/pg';
import { webhookSender, webhookTables } from '@arki/journal/http/webhooks';

export const tables = journalTables();
export const webhookSchema = webhookTables(); // in the schema module: drizzle-kit generate creates the tables

export const webhooks = webhookSender({ tables, webhooks: webhookSchema, encryptionKey: env.WEBHOOK_KEY });

// Once, when a partner registers an endpoint. Show the secret to them now: it is never readable again.
const { id, secret } = await webhooks.subscribe(db, { partner: tenantId, url, events: ['order.placed'] });

// In the business transaction: the webhook exists if and only if the order commits.
await db.transaction(async tx => {
  await journal.run(tx, placeOrder, input, meta);
  await webhooks.dispatch(tx, { partner: tenantId, event: 'order.placed', payload: { orderId } });
});

journal.worker(db, { jobs: combineRunners(outboxRunner(...), webhooks.runner) });
```

- **`dispatch(tx, …)`** needs a transaction. It writes the message once, as the body `{ type, timestamp, data }`, and one delivery row for each active subscription of that partner that lists the event. A payload over `maxPayloadBytes` (default 1 MiB) is refused.
- **Signing failures** return the exact HTTP failure before delivery, record a failed/dead attempt with its safe code, and never acknowledge the job. Returned failures require an explicit retry predicate such as `.while(WebhookCryptoUnavailable)` on the configured backoff; a throw is retried by that backoff.
- **Delivery** signs the stored bytes with [Standard Webhooks](https://www.standardwebhooks.com/). `webhook-id` is the message id, the same on every retry and replay, so a receiver dedupes on it (`verifyWebhook` with `standardWebhooks` from `@arki/http/webhooks` accepts it). It posts through `publicFetch()`, so an endpoint cannot reach a private address, even after a DNS change. Each try has `timeoutMs` (default 10 s). Any 2xx is delivered; anything else is retried.
- **Retries are the worker's.** `retry` (a `Backoff`, default from 5 s doubling to 1 h, 10 retries) sets when the next try runs and when the delivery is dead. A dead delivery stays in `journal_jobs` like any dead job: `journal.jobs(db, { status: 'dead' })` lists it and `journal.retry(db, id, op)` runs it again.
- **Every try is a row** in `webhook_attempts`: `delivered`, `failed` (with `next_at`), `dead`, or `skipped` (the subscription was disabled). Because delivery is at least once, a crash between the send and the ack can add a second row for one try.
- **Auto-disable.** `disableAfter` (default 5) dead deliveries in a row disable the subscription. A success resets the count. `enable(db, id)` turns it back on; `disable(db, id)` stops it by hand. A delivery queued before the subscription was disabled is recorded as `skipped`, not sent.
- **`replay(db, { messageId, subscriptionId })`** sends a stored message again, with the same `webhook-id`. It refuses a subscription of another partner.
- **`rotateSecret(db, id, { windowSeconds })`** returns a new secret. For `windowSeconds` (default a day) both the old and the new secret sign each delivery, so the partner can switch without losing a message.
- **Secrets at rest** are sealed with AES-GCM under `encryptionKey` (32 bytes, base64; keep it out of the database). The subscription id is bound in, so a sealed secret copied onto another row does not open.
- `subscribe` takes public `https` URLs only. `rotateSecret`, `enable`, `disable` and `replay` act on the id they are given: check that the caller owns the subscription first.
- `combineRunners(...)` from `@arki/journal` lets one worker run webhook deliveries and other queue jobs. Two runners that claim the same job name throw `BAD_DEFINITION`.

Migration: add `webhookTables()` (or `webhookTables(schema)` next to `journalTables(schema)`) to the schema module, run `drizzle-kit generate`, and apply the migration before the first `subscribe`. It creates `webhook_subscriptions`, `webhook_messages` and `webhook_attempts`; existing tables are unchanged.

## Inbox

A sender delivers a webhook at least once, and sends it again after a timeout. Make the event id the idempotency key of a journal command. The receipt and the domain write then commit together, so a resent event changes nothing. There is no separate "seen events" table to drift from the data.

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
const scheme = standardWebhooks({ secrets: [process.env.WEBHOOK_SECRET] });
const orderPlaced = route.post('/hooks/orders', {
  id: 'hooks.orders', body: placeOrderInput, failures: WEBHOOK_FAILURES,
});

const engine = buildEngine([
  routes()
    .use(step(verifyWebhook({ scheme })))
    .bind(orderPlaced, async ({ body }, { webhook }) => {
      await journal.run(db, placeOrder, body, { actorId: 'partner' }, { idempotencyKey: `hook:${webhook.id}` });
    }),
]);
```

`WEBHOOK_FAILURES` comes from `@arki/http/webhooks` and declares the exact step failures on the route. `verifyWebhook` returns a canonical failure for an unsigned or wrongly signed request before it reaches the journal. Scope the key by sender if you take events from more than one (`${partner}:${webhook.id}`). The test `src/webhooks-inbox.test.ts` runs this end to end: a resent event writes one event row and keeps one receipt.

## Relay recipe

To pass an event to a queue or a broker, write an effect. The effect runs after commit, at least once, from the job table. Pass `jobId` on as the queue's own job id. The id is the same on every retry, so a retried effect adds the same queue job once.

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
import type { Queue } from 'bullmq';

export const relayOrderPaid = j.effect(
  'relayOrderPaid',
  order,
  { queue: need<Queue>() },
  {
    OrderPaid: (e, { jobId, queue }) => queue.add('order.paid', { orderId: e.entityId }, { jobId }),
  },
);
```

For a broker that dedupes on a message id, use `jobId` the same way. `kv.publish` (Redis Pub/Sub) is a best-effort notification: nobody acknowledges it, and it does not take a job id. Use it for a live page or a cache poke, never for work that must happen. For work that must happen, relay a durable job as above. The journal has no generic broker framework on purpose.

## Workflows

A workflow is a list of steps that runs to the end even when the process dies. Each step runs as a job in `journal_jobs`. When a step finishes, its result is saved (a checkpoint) and the next step is scheduled, in one transaction. A run can wait for a signal from outside, or sleep, for hours or days. When it cannot finish, it undoes the steps it did, newest first (compensation). The run is a journal entity (`workflow.run`), so every move is an event in `journal_events`.

**When to use one.** The work must survive a restart, or it waits for hours or days: use a journal workflow. A loop of steps inside one request or one job: use `createFlow` from `@arki/ai`. `createFlow` runs in memory and is not durable. It stays that way on purpose.

The [agent guide](docs/agent-guide.md#workflows) has the rules, the error codes and the traps.

### Define a workflow

`j.workflow(name, { version, input, output?, needs? })` starts a definition. Each node adds one result, and the types follow: in a later step, `results.hold` has the type the `hold` step returned. `.finish()` ends the definition. The example is one file that runs: it defines a refund, runs it on an in-memory database, and checks what happened.

```ts run
import { z } from 'zod';

import { orThrow } from '@arki/failure';
import { initJournal, need } from '@arki/journal';
import { journalTables } from '@arki/journal/pg';
import { openJournalDb } from '@arki/journal/testing';

/** The payment provider, as the workflow sees it. */
type Payments = {
  hold(paymentId: string, amount: number): Promise<{ holdId: string }>;
  release(holdId: string): Promise<void>;
  refund(paymentId: string, amount: number, idempotencyKey: string): Promise<{ refundId: string }>;
};

const tables = journalTables();
const j = initJournal({ tables, meta: z.object({ actorId: z.string() }) });

const Settled = z.object({ settledAt: z.iso.datetime() });

export const refund = j
  .workflow('payments.refund', {
    version: 1,
    input: z.object({ paymentId: z.string(), amount: z.int().positive() }),
    output: z.object({ refundId: z.string(), settledAt: z.string() }),
    needs: { payments: need<Payments>() },
  })
  // `undo` runs when the run compensates. `result` is what this step returned.
  .step('hold', ({ input, payments }) => payments.hold(input.paymentId, input.amount), {
    undo: ({ result, payments }) => payments.release(result.holdId),
  })
  // `key` is the same on every try of this step: the provider dedupes on it. `output` checks the stored result, so
  // `def.read` types it and an operator can supply it by hand (`resolveStep`).
  .step('payBack', ({ input, key, payments }) => payments.refund(input.paymentId, input.amount, key), {
    output: z.object({ refundId: z.string() }),
  })
  // The run parks here until the provider's webhook sends the signal.
  .waitFor('settled', { signal: 'provider.refund.settled', schema: Settled, timeout: '3d' })
  .finish(({ results }) => ({ refundId: results.payBack.refundId, settledAt: results.settled.settledAt }));
```

The other nodes:

- `.step(name, fn, options?)`. `fn` gets the context: `input`, `results`, `key`, `attempt`, `runId`, `signal` (an `AbortSignal` for a lost lease or a timeout), `db`, `run` (runs a command), `accept`, and the needs by name. `run(command, input)` may leave the meta out: the command then records the `workflowMeta` the app gave `compose`. A meta passed as the third argument is used as given. Options: `undo`, `output` (a schema for the stored result), `key` (your own idempotency key), `retry` (a `Backoff`), `timeout`, `when` and `next`.
- `when: ctx => boolean` skips the step when it returns false. Its result is then `null`, and its type says so (`R | null`).
- `next: 'node'` or `next: ({ result }) => 'node' | 'next'` jumps back to an earlier node, so a loop is a step with `next`. A name later in the list does not compile.
- `.waitFor(name, { signal, schema, timeout?, onTimeout?, when? })` parks the run until `def.signal(name)` delivers the signal. The result is the payload, typed by `schema`. With `onTimeout: 'continue'` a timeout goes on with `null`; the default `'fail'` fails the node. `when` works as on a step: when it returns false the run does not park, the result is `null`, and the type says so (`payload | null`).
- `.sleep(name, '24h')` or `.sleep(name, ctx => date)` parks the run until that time.
- `.child(name, def, { input })` starts another workflow and waits for it. The result is the child's output.
- `.map(name, def, { items, input, wait?, concurrency? })` starts one child per item. The result is the outputs in item order. With `wait: 'any'` the first child to finish wins, and the others are cancelled.
- `.finish(fn?)` works out the output. Without `fn` the output is the last node's result. With an `output` schema, `fn` must return that schema's output, or it does not compile.

```ts continue
const inStock = (orderId: string) => orderId.startsWith('ord_'); // a stand-in for a real stock check

const shipParcel = j
  .workflow('orders.ship-parcel', { version: 1, input: z.object({ parcelId: z.string() }) })
  .step('label', ({ input }) => ({ tracking: `trk_${input.parcelId}` }))
  .finish(); // the output is the last result: { tracking }

export const fulfil = j
  .workflow('orders.fulfil', {
    version: 1,
    input: z.object({ orderId: z.string(), parcels: z.array(z.string()).min(1), gift: z.boolean() }),
  })
  .step('wrap', ({ input }) => ({ paper: 'red', orderId: input.orderId }), { when: ({ input }) => input.gift })
  .sleep('pause', '5m')
  // Not ready yet: back to `pause`, then check again. Each visit gets a new key.
  .step('stock', ({ input }) => ({ ready: inStock(input.orderId) }), {
    next: ({ result }) => (result.ready ? 'next' : 'pause'),
  })
  .map('ship', shipParcel, { items: ({ input }) => input.parcels, input: (_ctx, parcelId) => ({ parcelId }) })
  .child('first', shipParcel, { input: ({ input }) => ({ parcelId: input.parcels[0] ?? input.orderId }) })
  .finish(({ results }) => ({
    wrapped: results.wrap !== null, // `wrap` is `{ paper, orderId } | null`
    tracking: results.ship.map(parcel => parcel.tracking), // `ship` is `{ tracking }[]`
  }));
```

### Compose

Pass the definitions to `compose`, with `workflowMeta`, the meta the runner records on its own checkpoints and on each command a body runs without a meta. The library never invents an actor: the app chose this one. List every workflow a `child` or `map` node starts too. The steps' needs come from `services`, like an effect's. Composing adds two effects (`workflow.step`, `workflow.timer`), one more per workflow with a `startOn` (`workflow.start:<name>`, see [Start on an event](#start-on-an-event)), and one projection (the `workflow_steps` table).

```ts continue
const released: string[] = [];
const payments: Payments = {
  hold: async paymentId => ({ holdId: `hold_${paymentId}` }),
  release: async holdId => void released.push(holdId),
  refund: async (paymentId, _amount, idempotencyKey) => ({ refundId: `re_${paymentId}_${idempotencyKey.length}` }),
};

export const journal = j.compose({
  workflows: [refund],
  workflowMeta: { actorId: 'system:workflow' },
  services: { payments },
});
```

- Compose workflows once per `initJournal()`. A second compose with workflows on the same `j` throws `BAD_DEFINITION`. A new process (a deploy, a restart) runs `initJournal()` again, so it composes again.
- A missing service is a compile error, as for an effect, and `compose` throws `BAD_DEFINITION` naming the workflow and the need. In Dot the feature's `needs` make it a compile error.

### Start, signal, cancel, read

A finished definition has three commands and one read. The commands run through `journal.run`, `journal.bind`, `context.run` or `ctx.run`, like any command.

- `def.start` takes `{ input, id? }` and returns `{ runId }`. The default id is `wfr_<random>`. Give your own id to make the start idempotent: the same id and input return the same run, and another input is a `CommandConflict`.
- `def.signal(name)` takes `{ runId, deliveryId, payload }`. `name` must be a signal one of the `waitFor` nodes declares. `deliveryId` is the sender's own id, such as the webhook event id. It returns a `status`: `woke` (the run moved on), `kept` (stored; the run takes it when it reaches the wait), `duplicate` (this `deliveryId` was seen) or `finished` (the run is over, so it was dropped) or `no-run` (no run of this workflow has that id, or the id belongs to another workflow; nothing is stored). `no-run` is a status, not a failure, so a webhook for a missing run is answered 200 and the provider stops resending. The operator verb `journal.workflows.signal` names a specific run and still refuses an unknown one.
- `def.cancel` takes `{ runId, reason }`. It returns `{ state: 'compensating' }` while the run undoes its steps, or `{ state: 'cancelled' }` when there was nothing to undo.
- `def.read(db, runId)` reads the run back, typed. It checks the input, the output and each result that has a schema (a step `output`, a `waitFor` schema). A result without a schema is `unknown`. A stored value that no longer fits its schema returns the failure `WorkflowReadMismatch` (code `journal.workflow_read_mismatch`). Another workflow's run, or an unknown id, gives `undefined`.

```ts continue
const { db, client } = await openJournalDb(tables); // in an app: the root database
const customer = { actorId: 'usr_1' };

const started = orThrow(
  await journal.run(db, refund.start, { id: 'refund:ord_1', input: { paymentId: 'pay_1', amount: 500 } }, customer),
);
// In an app `journal.worker(db)` runs the jobs. Here `drain` runs what is due.
await journal.drain(db); // hold
await journal.drain(db); // payBack, then the run parks on `settled`

const delivered = orThrow(
  await journal.run(
    db,
    refund.signal('provider.refund.settled'),
    { runId: started.runId, deliveryId: 'evt_1', payload: { settledAt: '2026-10-21T10:00:00Z' } },
    { actorId: 'webhook:provider' },
  ),
);
if (delivered.status !== 'woke') throw new Error('the signal wakes the parked run');
await journal.drain(db);

const done = orThrow(await refund.read(db, started.runId));
if (done?.run.state !== 'completed') throw new Error('the run completes');
// `output` is typed by the workflow's `output` schema, and `results.payBack` by the step's.
if (done.run.output?.settledAt !== '2026-10-21T10:00:00Z') throw new Error('the output holds the settle time');
if (done.run.results.payBack?.refundId === undefined) throw new Error('the checked step result is there');
```

### Failure and compensation

A step that throws is tried again with its `retry` backoff, or else the effects' default: 8 tries, from 1 s up to 5 minutes. Its error records the throw as `UnexpectedDefect`, but the `while` gets the error the body threw, as is: `retry: backoff.exponential({ base: 1000 }).upTo(7).while(reason => reason instanceof TransientError)`. A step that returns a failure from `@arki/failure` is dead at once, unless that `while` accepts the failure. A dead step, or a `waitFor` that timed out with `'fail'`, follows the workflow's `onDeadStep`:

- `'wait'` (the default): the run stays where it is, marked `stuck`, until an operator retries the step, gives its result, or cancels the run.
- `'compensate'`: the run undoes its steps at once and ends `failed`.

Compensation runs the `undo` of each finished step, newest first. A step without `undo` is skipped and listed in `residual`: its work stays done. A child is compensated as a whole run, unless the `child` node has its own `undo`. A `deadline` on the workflow fails a run that has not finished in time, and compensates it.

A cancel stops the run and compensates it the same way, then the run ends `cancelled`. A step that is running finishes first. A step that never started does not run. A wait or sleep the run was parked on is dropped, and a dropped node has no result. Children are cancelled too, unless the `child` node says `onCancel: 'detach'`.

```ts continue
const second = orThrow(await journal.run(db, refund.start, { input: { paymentId: 'pay_2', amount: 300 } }, customer));
await journal.drain(db);
await journal.drain(db); // parked on `settled`

const cancel = orThrow(
  await journal.run(db, refund.cancel, { runId: second.runId, reason: 'customer withdrew' }, customer),
);
if (cancel.state !== 'compensating') throw new Error('hold is undone first');
await journal.drain(db);

const cancelled = orThrow(await refund.read(db, second.runId));
if (cancelled?.run.state !== 'cancelled') throw new Error('the run ends cancelled');
if (released.join() !== 'hold_pay_2') throw new Error('hold is released');
if (cancelled.residual.join() !== 'payBack') throw new Error('payBack has no undo: the refund stays done');
```

### Idempotency

A step can run twice. The worker can die after the provider answered and before the checkpoint committed. Then another worker runs the step again. The journal does not hide this: the step body owns it. Two ways:

- Give the provider an idempotency key. `ctx.key` is the same on every try of one visit of the step, so the provider answers the second call with the first result.
- Look up, then act. Check whether the work is already done (a row, a provider lookup), and do it only when it is not.

A worker whose lease ran out cannot commit a checkpoint: the journal refuses it with `LEASE_LOST`, and nothing is written.

### Versions

A run keeps the version it started with, to the end. To change a workflow's steps, add a new definition with the same name and a higher `version`, and register both: `compose({ workflows: [refundV1, refundV2] })`. New runs start the highest version. Older versions only finish the runs they have. Remove the old one when `journal.workflows.counts(db)` shows none of its runs are left.

A run whose version is no longer registered, or whose definition has other nodes than it started with, is stranded. The runner leaves it alone; it never runs the wrong step. `journal.workflows.stranded(db)` lists them, with the reason (`WORKFLOW_UNKNOWN` or `WORKFLOW_SHAPE_CHANGED`). Put the old code back and `retryStep` resumes the run.

### Operators

`journal.workflows` reads runs and moves them by hand.

| Call                                                       | What it does                                                                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `runs(db, { state?, name?, version?, parentId?, stuck?, limit?, after? })` | `{ runs, next }`: runs, newest first. Pass `next` as `after` for the next page. It is `null` on the last page. |
| `run(db, id)`                                              | One run with its steps, children, `residual` and unconsumed signals. Untyped: `def.read` is the typed form.                                 |
| `counts(db)`                                               | How many runs per name, version and state.                                                                                                  |
| `stranded(db)`                                             | Unfinished runs whose code is missing or changed.                                                                                           |
| `history(db, id)`                                          | The run's events, oldest first.                                                                                                             |
| `retryStep(db, { runId, path, phase }, op)`                | Runs a dead step again, with the same key. A dead child or map node restarts its failed children. A stranded run retries all its dead jobs. |
| `resolveStep(db, { runId, path, result }, op)`             | Gives the result of a dead `do` step by hand, checked by its `output` schema. The run goes on. Needs a step with `output`.                  |
| `checkResult(db, { runId, path, result })`                 | Says whether `resolveStep` would take `result`. Writes nothing.                                                                             |
| `skipUndo(db, { runId, path }, op)`                        | Gives up a failed undo. `op.reason` is required. The path joins `residual` and compensation goes on.                                        |
| `signal(db, { runId, name, deliveryId, payload }, op)`     | Delivers a signal from JSON, checked by the run's own version.                                                                              |
| `cancel(db, { runId, reason }, op)`                        | Cancels a run of any workflow.                                                                                                              |

`op` is `{ actor, reason?, executionId? }`, as for the job verbs. The run's events record it. A step or timer job belongs to its run: the raw job verbs (`journal.retry`, `discard`, `cancel`) refuse it with `JOB_MANAGED`.

```ts continue
// One row per name, version and state: here `payments.refund` v1 has one `completed` and one `cancelled` run.
const counts = await journal.workflows.counts(db);
if (counts.length !== 2) throw new Error('one completed run and one cancelled run');

// A page of runs, newest first, and the cursor of the next page (`null` on the last one).
const { runs, next } = await journal.workflows.runs(db, { name: 'payments.refund', limit: 1 });
if (runs.length !== 1 || next === null) throw new Error('two runs: one on this page, one on the next');

// RunStarted, NodeScheduled, NodeCompleted, ..., Parked, CancelRequested, CompensationStarted, ..., RunCancelled
const { events } = await journal.workflows.history(db, second.runId);
if (events.at(-1)?.type !== 'RunCancelled') throw new Error('the history ends with the cancel');
await client.close();
```

`journalWorkflowsModule({ journal, db, meta, payload? })` from `@arki/journal/foreman` puts the same reads and verbs in Foreman, with previews and approvals. `meta(permit)` gives the meta of the commands it runs; its `actorId` is written on the run's events. The ids are `workflow.runs`, `.run`, `.counts`, `.stranded`, `.history` (permission `workflow:read`), `workflow.retryStep` (`journal:retry`, low risk), `workflow.signal` (`workflow:signal`, medium), `workflow.resolveStep` and `workflow.skipUndo` (`workflow:resolve`, high), and `workflow.cancel` (`workflow:cancel`, high). Its refusals are `JOURNAL_WORKFLOWS_ERROR_CODES`, `ARKI_JOURNAL_E010` to `E017`.

### Start on an event

`startOn: { entity, event, id, input }` starts a run when `entity` records `event`. `id` gives the run id and `input` the run's input, both from the recorded event: `e.entityId` has the entity's key type, `e.data` the event's data, and `input` must return the workflow's input, or it does not compile. Composing adds one effect for it, `workflow.start:<workflow name>`.

- The job is written in the transaction that records the event, so the run starts once, even when that command is retried.
- The run starts with the app's `workflowMeta`, at the highest registered version, like `def.start`.
- An id that already has a run, whatever its input or version, starts nothing. The job ends done, not dead.
- Only the highest registered version may declare `startOn`. A lower one with `startOn` makes `compose` throw `BAD_DEFINITION`.

```ts run
import { integer, pgTable, varchar } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { orThrow } from '@arki/failure';
import { initJournal } from '@arki/journal';
import { journalTables } from '@arki/journal/pg';
import { openJournalDb } from '@arki/journal/testing';

const tables = journalTables();
const j = initJournal({ tables, meta: z.object({ actorId: z.string() }) });

const orders = pgTable('orders', {
  id: varchar('id', { length: 64 }).primaryKey(),
  total: integer('total').notNull(),
  version: integer('version').notNull().default(0),
});
const OrderPlaced = j.event('OrderPlaced', z.object({ total: z.int().positive() }));
const order = j.entity('order', orders).create(OrderPlaced, e => ({ total: e.data.total }));

export const welcome = j
  .workflow('orders.welcome', {
    version: 1,
    input: z.object({ orderId: z.string(), total: z.int() }),
    startOn: {
      entity: order,
      event: OrderPlaced,
      id: e => `welcome:${e.entityId}`, // the order id: one run per order
      input: e => ({ orderId: e.entityId, total: e.data.total }),
    },
  })
  .step('thank', ({ input }) => `thanks for ${input.total}`)
  .finish();

const placeOrder = j.command('orders.place', z.object({ id: z.string(), total: z.int().positive() }), (input, { write }) =>
  write(order, input.id, () => [OrderPlaced({ total: input.total })]),
);

const journal = j.compose({ workflows: [welcome], workflowMeta: { actorId: 'system:workflow' } });
const { db, client } = await openJournalDb({ ...tables, orders });

orThrow(await journal.run(db, placeOrder, { id: 'ord_1', total: 500 }, { actorId: 'usr_1' }));
await journal.drain(db); // workflow.start:orders.welcome starts the run
await journal.drain(db); // thank

const thanked = orThrow(await welcome.read(db, 'welcome:ord_1'));
if (thanked?.run.output !== 'thanks for 500') throw new Error('the order started the run');
await client.close();
```

### Retention

A finished run's row is kept for a while, then the sweeper deletes it. Its events stay. Set the time on `initJournal`, next to the job retention. A workflow's own `retention` option overrides it.

```ts
import { z } from 'zod';

import { initJournal } from '@arki/journal';
import { journalTables } from '@arki/journal/pg';

export const j = initJournal({
  tables: journalTables(),
  meta: z.object({ actorId: z.string() }),
  retention: { workflows: { completed: '30d', failed: '180d', cancelled: '90d' } },
});

export const nightly = j
  .workflow('reports.nightly', { version: 1, input: z.object({}), retention: { completed: '1d' } })
  .step('build', () => 'done')
  .finish();
```

Defaults: `completed` 7 days, `failed` 90 days, `cancelled` the same as `failed`. `'untilExported'` and `max` are refused: a run has no sink. A completed child whose parent has not finished is kept, because the parent may still undo it.

### Workflows in Dot

A feature lists its workflows with `journalWorkflows(core, defs)` in `.entrypoints(...)`, or with `journalHandlers({ workflows })`. The app passes `workflowMeta` to `journal({ j, workflowMeta })`. A step gets the services of the feature that lists its workflow, by need name. The feature must declare each need, or it does not compile. Each workflow is an action in the manifest: `<name>@<version>.run`, with its signals in the meta.

```ts
import { z } from 'zod';

import { defineApp } from '@arki/dot';
import { defineFeature } from '@arki/dot/feature';
import { infra } from '@arki/dot/unit';
import { initJournal, need } from '@arki/journal';
import { journal, journalWorker, journalWorkflows } from '@arki/journal/dot';
import { journalTables } from '@arki/journal/pg';
import { openJournalDb } from '@arki/journal/testing';

type Payments = { refund(paymentId: string, idempotencyKey: string): Promise<{ refundId: string }> };

const tables = journalTables();
const j = initJournal({ tables, meta: z.object({ actorId: z.string() }) });

const refund = j
  .workflow('payments.refund', {
    version: 1,
    input: z.object({ paymentId: z.string() }),
    needs: { payments: need<Payments>() },
  })
  .step('payBack', ({ input, key, payments }) => payments.refund(input.paymentId, key))
  .finish();

const { db } = await openJournalDb(tables); // the app's root database
const stripe = infra({
  name: 'stripe',
  provides: {
    payments: (): Payments => ({ refund: async (paymentId, key) => ({ refundId: `re_${paymentId}_${key}` }) }),
  },
});

// The feature declares what its workflows need, in the core.
const core = defineFeature('refunds').needs({ payments: stripe.provides.payments }).usecases({});
export const refunds = core.entrypoints(journalWorkflows(core, [refund]));

export const app = defineApp('shop')
  .infra(infra({ name: 'db', provides: { db: () => db } }))
  .infra(stripe)
  .infra(journal({ j, workflowMeta: { actorId: 'system:workflow' } }))
  .features([refunds])
  .entrypoints(journalWorker());
```

`journalWorker()` runs the workflow jobs like any effect. A feature has one `journal` entrypoint, so a feature with both effects and workflows lists them together with `journalHandlers`.

### Testing

`workflowHarness({ setup })` from `@arki/journal/testing` gives a test an in-memory database and control of time and crashes. `setup` builds the runtime: `initJournal`, the definitions and the compose. It returns `tables`, `journal` and the definitions the test uses. The harness adds:

- `tick(age)` moves time forward by shifting the stored due times back.
- `drain()` runs jobs until none is due.
- `crash()` is a restart: the rows stay, and `setup` runs again, so the journal and the definitions are new.
- `close()` closes the database.

```ts run
import { z } from 'zod';

import { orThrow } from '@arki/failure';
import { initJournal } from '@arki/journal';
import { journalTables } from '@arki/journal/pg';
import { workflowHarness } from '@arki/journal/testing';

const sent: string[] = [];

const h = await workflowHarness({
  setup: () => {
    const tables = journalTables();
    const j = initJournal({ tables, meta: z.object({ actorId: z.string() }) });
    const reminder = j
      .workflow('trial.reminder', { version: 1, input: z.object({ email: z.string() }) })
      .sleep('wait', '7d')
      .step('remind', ({ input }) => void sent.push(input.email))
      .finish();
    return { tables, journal: j.compose({ workflows: [reminder], workflowMeta: { actorId: 'system' } }), reminder };
  },
});

orThrow(
  await h.journal.run(
    h.db,
    h.reminder.start,
    { id: 'trial_1', input: { email: 'ana@example.com' } },
    { actorId: 'usr_1' },
  ),
);
orThrow(await h.drain()); // parked on `wait`
h.crash(); // the process restarts: new journal, same rows
await h.tick('7d');
orThrow(await h.drain());

console.log(sent, orThrow(await h.reminder.read(h.db, 'trial_1'))?.run.state);
await h.close();
```

Start, signal and read in a test go through the definitions, as in an app. After `crash()`, read `h.journal` and the definitions from the harness again: the old ones belong to the dead runtime.

## Foreman

`@arki/journal/foreman` is the job console for Foreman. `@arki/admin` is an optional peer. `journalJobsModule` serves the job reads and verbs above, with previews and approvals.

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
import { journalJobsModule } from '@arki/journal/foreman';

const jobsModule = journalJobsModule({ journal, db, payload: 'hidden', jobs: queueRunner });
// foreman({ ..., modules: [jobsModule] })
```

Options: `journal` and `db` (the root database) are required. `payload` is `'hidden'` (default) or `'redacted'`: what `journal.job` and `journal.archivedJob` show of a job's input. A list never carries a payload. `jobs` is the worker's runner; with it `journal.strandedJobs` also counts queue rows no handler knows. Error text goes through `redactSecrets`. Archive and purge rules come from `journal.retention`.

| Id                                                                                                                                                                          | Kind   | Permission       | Risk   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------- | ------ |
| `journal.jobs`, `journal.job`, `journal.jobCounts`, `journal.strandedJobs`, `journal.jobOperations`, `journal.archivedJobs`, `journal.archivedJob`, `journal.archiveStatus` | read   | `journal:read`   | read   |
| `journal.retryJob`                                                                                                                                                          | action | `journal:retry`  | low    |
| `journal.retryDead`                                                                                                                                                         | action | `journal:retry`  | medium |
| `journal.discardJob`                                                                                                                                                        | action | `journal:delete` | medium |
| `journal.purgeDead`                                                                                                                                                         | action | `journal:delete` | medium |
| `journal.cancelJob`                                                                                                                                                         | action | `journal:delete` | high   |
| `journal.replayJob`                                                                                                                                                         | action | `journal:retry`  | high   |

Every action previews first. Execute re-checks the revision the approval pinned, runs the journal verb, and records the approver and the execution id in the operations audit. `retryDead` is all or nothing on the previewed set. `journal.replayJob` says in its preview that the new job has a new id.

The refusals are `ModuleError`s (see `@arki/admin`), so Foreman answers each with its own status. The codes are in `JOURNAL_JOBS_ERROR_CODES`:

| Code                | Name            | Status | Meaning                                                               |
| ------------------- | --------------- | ------ | --------------------------------------------------------------------- |
| `ARKI_JOURNAL_E001` | `staleRevision` | 409    | The job or set changed since the preview.                             |
| `ARKI_JOURNAL_E002` | `notDead`       | 409    | The action needs a dead job and it is not dead, or is gone.           |
| `ARKI_JOURNAL_E003` | `boundTooShort` | 400    | `purgeDead` `olderThanDays` is shorter than `retention.retryableFor`. |
| `ARKI_JOURNAL_E004` | `notPending`    | 409    | `cancelJob` needs a ready or delayed job.                             |
| `ARKI_JOURNAL_E005` | `exists`        | 409    | `replayJob` is blocked by a job with the same dedupe key.             |

`journalReceiptStore` and `foremanReceiptTables` live here too. They used to be `@arki/admin/pg`. Import them from `@arki/journal/foreman`.

## Dot

`@arki/journal/dot` connects the journal to an `@arki/dot` app. It exports two adapters and one feature slice. `@arki/dot` is an optional peer. The core entry never imports it.

- `journal(...)`: the infra part, for `.infra()`. It publishes `services.journal`, so features can write through it.
- `journalWorker(...)`: the entrypoint part, for `.entrypoints()`. It runs effects, taps and async projections between `start` and `stop`. With `jobs` it also runs queue rows.
- `journalHandlers(...)`: the feature slice. A feature lists its projections, effects and taps with it.

**Not a Dot app.** List the handlers in one `journal.root.ts`. Start and stop the worker yourself.

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
// src/journal.root.ts — the one place that lists handlers.
export const journal = j.compose({ projections: [customerStats], effects: [orderMail], services: { mailer } });

// src/server.ts
const worker = journal.worker(db);
await worker.start();
// On shutdown:
await worker.stop();
```

**Dot app.** Each feature lists its own handlers with `journalHandlers`. The app lists its features once, in `.features([...])`. Both adapters read that list. There is no root file.

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
// src/features/orders/feature.ts
export const orders = defineFeature('orders')
  .needs({ mailer: mailerInfra.provides.mailer }) // typed handle; service<Mailer>() also works
  .entrypoints(journalHandlers({ projections: [customerStats], effects: [orderMail] }));

// src/app.ts
export const app = defineApp('shop')
  .infra(db())
  .infra(mailer())
  .infra(journal({ j }))
  .features([orders, billing])
  .entrypoints(journalWorker());

// The gateway binds the door once per request, in its context factory. A procedure calls `context.run`.
const run = services.journal.bind(services.db, { actorId: user.id });
await run(payOrder, input);
```

- `journal(...)` boots before the features. It reads their `journalHandlers` declarations, not their booted services, so a feature can `need` the journal and write through it, even in its own `boot`.
- This works because a write never needs an effect's services. A write runs the inline projections, which get only the transaction, and queues each effect's job. The journal is composed with `services: 'worker'`. `journalWorker()` gives each effect and tap its services when it runs it.
- `journal(...)` needs the root database under the `db` key. A transaction there is a compile error.
- `journalWorker()` starts one worker on `start` and stops it on `stop`. Options: `pollMs`, `batchSize`, `leaseSeconds`, `listen`, `taps`, `jobs`. `jobs` is a `JobsSource`: it names the services the runner needs and builds a `JobRunner` once the features have booted. `@arki/queue/dot` ships one, `outboxJobs({ needs, context })`. A `jobs` source adds a `<job>.consume` action per job to the worker's manifest, under the unit `journal-worker`. A process that serves no worker still writes. Its jobs wait for a process that serves one.
- An effect with needs gets them from the booted services of the feature that lists it, by name. The feature must declare each one in its own `needs`, or it does not compile. A missing service fails that feature's boot.
- Two features may use the same need name for two different services. Each effect gets the service of its own feature.
- Every effect is an action in the app manifest (`binding: 'journal'`, id `<name>.run`). Projections are never listed: they run inside the write.
- Two features with the same projection name or the same effect name fail the boot. The message names the duplicate and both features.
- A feature without `journalHandlers` adds nothing. That is allowed.
- An app that composed its journal itself passes it: `journal({ journal })`. Serve `journalWorker()` if it has effects, taps or async projections. `journalHandlers` slices are not read in this mode.
- A second journal uses Dot's `rename`: `rename(journal({ journal: reports }), { journal: 'reportsJournal' }, 'reports-journal')`.
- An effect runs a command with `ctx.run` in both modes. It needs no closure over the journal.

### A `defineFeature` feature

A feature can declare the same handlers by layer. The journal reads them from the feature value before anything boots and folds them into one declaration per feature, so `journal(...)` and `journalWorker()` work as above.

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
// features/orders/feature.ts
export const core = defineFeature('orders')
  .needs({ journal: service<AppJournal>(), db: database.provides.db })
  .infra(mailer, journalProjections(customerStats)) // projections keep read models: infra
  .usecases({ placeOrder }); // commands live here, one file per usecase
export const orders = core.entrypoints(rpc(ordersContract, os, { place: placeProcedure }), orderEffects(core));

// features/orders/entrypoints/journal.ts — `import type` only
export const orderEffects = (c: typeof core) => journalEffects(c, { effects: [orderMail], taps: [] });
```

- `journalProjections(...projections)` is an infra unit that boots nothing; its unit is `<feature>/journal-projections`.
- `journalEffects(core, { effects, taps })` is an entrypoint. An effect's needs come from the feature by name: a need alias, an infra service (the feature's private `mailer` above) or `usecases`. A missing one is a compile error at this call, and a boot error for callers that skip the types.
- Duplicate names are refused across features, naming both.
- `dot explain --as journal-flow` lists which event starts which effect (`OrderPaid → order-mail`, owned by `orders`). It reads the effects' manifest actions; nothing extra is collected. It is the only way to see that paying an order sends a mail, short of reading every file.

**The actor.** `actorRun(select)` from `@arki/journal/orpc` is a middleware that adds `context.run`, the journal's runner bound to the request's database and actor. The app's `select` says who the actor is; the journal assumes no session shape.

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
// core/orpc.ts
export const asActor = actorRun((context: { session: Session | null; journal: AppJournal }) => {
  if (!context.session) throw new ORPCError('UNAUTHORIZED');
  return { actorId: context.session.user.id };
});

// a procedure, after the feature's bind(core) put `journal` and `db` on the context
export const pay = o.pay.use(asActor).handler(({ context, input }) => context.run(payOrder, input));
```

The procedure must have `journal` and a `db` the journal can write through on its context, or `.use(asActor)` does not compile. Binding the actor is not authorization: the command still checks what the actor may do.

## Tables

`journalTables()` returns the tables: `events`, `receipts`, `cursors`, `jobs`, `jobAttempts`, `jobArchive`, `jobOperations`, `workflowRuns`, `workflowSteps` and `workflowSignals`. The app's migrations create them (`drizzle-kit generate`). The library never creates tables at runtime.

**Export every table on its own.** drizzle-kit collects only a schema module's top-level exports, so a table that sits only inside the `journalTables()` object never gets a migration. Export each one, and add `ExportsEveryJournalTable` from `@arki/journal/pg` so a table added in a later version fails the build until you export it:

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
import type * as thisModule from './journal.tables'; // the module itself

const tables = journalTables(schema);
export const journalEvents = tables.events;
// …one export per table
export type JournalTablesCheck = ExportsEveryJournalTable<typeof thisModule>;
```

A missing export reads `Property 'missingJournalTableExports' is missing … required in type '{ missingJournalTableExports: "jobArchive"; }'`. Tables match by type, so the export names are yours. Then run `drizzle-kit generate`.

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
  owner         varchar(64)               -- response cache rows only (@arki/journal/http); null on a command receipt
  expires_at    timestamptz               -- completed response replay only; null while unresolved
  response      jsonb                     -- response cache rows only; null while the request runs

journal_cursors
  name          varchar(128) primary key  -- the async projection
  seq           bigint not null default 0 -- global scan progress
  updated_at    timestamptz not null default now()

journal_jobs
  id            varchar primary key       -- job_xxx; pass it on as an idempotency key
  kind          varchar(8) not null default 'effect' -- 'effect' or 'queue'
  event_seq     bigint references journal_events(seq) -- effect rows only
  effect        varchar(128)                          -- effect rows only
  job_name      varchar(128)                          -- queue rows only
  args          jsonb                                 -- queue rows only; JSON null is allowed
  dedupe_key    varchar(256)                          -- queue rows only; optional
  priority      integer not null default 0 -- from the effect's schedule; higher first
  attempts      integer not null default 0
  available_at  timestamptz not null default now()
  lease_until   timestamptz
  lease_token   varchar
  last_error    text
  dead_at       timestamptz               -- set after 8 failed attempts
  enqueued_at   timestamptz not null default now() -- when the row was written; the archive needs the age
  replay_of     text                      -- the archived job id a replay came from
  unique (event_seq, effect)
  unique (job_name, dedupe_key) where dedupe_key is not null
  check journal_jobs_kind_check             -- an effect row has event_seq and effect and no job_name, args or dedupe_key;
                                            -- a queue row has job_name and args and no event_seq or effect
  index (priority desc, available_at) where dead_at is null

journal_job_attempts
  id            varchar primary key       -- att_xxx
  job_id        varchar not null references journal_jobs(id) on delete cascade
  attempt       integer not null          -- 1, 2, 3 for this job's tries
  started_at    timestamptz not null default now()
  finished_at   timestamptz               -- null while the attempt is open
  outcome       varchar(16)               -- 'ok' | 'retry' | 'dead' | 'superseded'; null while open
  error         text
  index (job_id, started_at)

journal_job_archive
  id            varchar primary key       -- the finished job's id (job_xxx)
  kind, event_seq, effect, job_name, args, dedupe_key, priority   -- as in journal_jobs; no foreign key
  enqueued_at   timestamptz not null
  attempts      integer not null
  last_error    text
  outcome       varchar(16) not null      -- 'completed' | 'dead' | 'discarded' | 'cancelled'
  attempt_log   jsonb                     -- the attempt rows, oldest first
  replay_of     text
  finished_at   timestamptz not null
  archived_at   timestamptz not null default now()
  keep_until    timestamptz               -- from the retention policy; null keeps it forever
  exported_at   timestamptz               -- set once the archive sink has the row
  index (keep_until)
  index (archived_at) where exported_at is null
  index (outcome, coalesce(effect, job_name), archived_at)

journal_job_operations
  id            varchar primary key       -- jop_xxx
  action        varchar(32) not null      -- retry, retryDead, discard, cancel, replay, purgeDead, exportArchive, pruneArchive
  actor         varchar(256) not null
  reason        text
  execution_id  varchar(256)              -- the Foreman execution, when there was one
  job_ids       jsonb not null            -- the ids it touched
  count         integer not null
  at            timestamptz not null default now()
  gin index (job_ids)
```

`kind = 'effect'` rows are the rows the journal always had. `unique (event_seq, effect)` stays. NULLs are distinct, so queue rows never collide on it. The due index serves both kinds. A dedupe key is scoped to its `job_name`.

**Migrating an existing app.** Run `drizzle-kit generate`. The new migration drops `NOT NULL` on `event_seq` and `effect`, adds the four columns and the check, and creates the dedupe index. Every statement is additive or relaxes a constraint. Existing rows take the default `kind = 'effect'` and pass the check. The check scans the table once. The table is small, because rows are deleted on success. If it holds very many dead rows, edit the generated SQL to add the check as `NOT VALID` and run `VALIDATE CONSTRAINT` after.

**Upgrading to job operations and the archive.** Three tables are new (`journal_job_attempts`, `journal_job_archive`, `journal_job_operations`) and `journal_jobs` gains `enqueued_at` and `replay_of`. Generate the migration from `journalTables()`: run `drizzle-kit generate` and review the SQL. Every statement is additive. Old rows get `enqueued_at` at migration time, and no history is invented for them. Dead rows that exist already stay retryable.

Migrate first. Then roll the workers. An old worker on the new schema still works: it does not write attempt rows and it deletes a job on success, as before, so it archives nothing until it is replaced. A new worker on the old schema fails at the first claim, so never roll workers first.

**Rollout order.** Migrate first. Then roll the workers. Then roll the processes that call `runAfter`. This order makes sure a queue row always has a worker. It is not a safety rule: an old worker cannot claim a queue row. To roll back, stop the producers first and let the new workers drain. Never restore `NOT NULL` while queue rows exist.

A job row leaves `journal_jobs` when its handler succeeds. The table holds only pending and dead work. What happens to the finished job is the retention policy's business: see [Retention and archive](#retention-and-archive). The event row is the lasting record.

An entity table needs a string key column that is primary or unique (`id` by default) and `version integer not null default 0`.

## Debugging

`DEBUG=arki:journal:*` prints commands, writes, replays, drains and worker ticks.

## Public imports

| Import                        | What it holds                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `@arki/journal`               | the portable core: `initJournal`, `need`, `jobId`, the command failures                                           |
| `@arki/journal/pg`            | `journalTables()`, the table definitions                                                                          |
| `@arki/journal/errors`        | the command failures, `JournalError`, `isJournalError`. No Drizzle import, for browser code that matches on codes |
| `@arki/journal/dot`           | the optional `@arki/dot` unit and feature slice (see Dot)                                                       |
| `@arki/journal/orpc`          | the optional oRPC error mapping (see Rejected rules)                                                              |
| `@arki/journal/http`          | `responseCache`, the Postgres cache for HTTP idempotency                                                          |
| `@arki/journal/http/webhooks` | outgoing webhooks on the job table                                                                                |
| `@arki/journal/foreman`       | the Foreman job console and workflow console                                                                      |
| `@arki/journal/projection`    | the projection entry for Dot tooling                                                                              |
| `@arki/journal/testing`       | `openJournalDb(schema)`: in-memory PGlite with the schema pushed; `workflowHarness`, for workflow tests           |

## Failure behaviour

Rules and misuse fail in three ways:

- A rule that rejects a request **returns a failure** (`CommandNotFound`, `CommandInvalid`, `CommandForbidden`, `CommandConflict`, or the app's own). The command rolls back. `journal.run` returns the failure, typed. Check it with `isFailure(result)`.
- A broken write, a schema error, or a misuse **throws** a `JournalError` with a `code`. Match with `isJournalError(error, 'CONFLICT')`. Never match on the message.
- App code that throws passes through unchanged.

The agent guide has the [error table](docs/agent-guide.md#errors) and the [recovery verbs](docs/agent-guide.md#recovery-verbs). With `commandErrors()` from `@arki/journal/orpc`, a returned failure answers the client with its code and status.

## Limits

- **One operation at a time.** One journal operation per transaction. Await every `write` and `run`. `Promise.all` over writes is a misuse.
- **Effects are at least once.** A job may run twice. Use the `jobId` as the idempotency key of the outside call.
- **Root database only.** `drain` and `worker` take the root database, never a transaction.
- **Receipt keys.** A key is at most 256 characters (`journal_receipts.key`). A longer key fails.
- **Version 1** means the journal created the row. A row that existed before starts at version 2.
- **Any worker claims any job.** Run the worker in the process that holds what its effects talk to.
- **The job table holds pending and dead work only.** Finished jobs leave. Retention decides what is kept.
- **Workflow steps are at least once.** A step can run again after a crash. The step body owns idempotency (`ctx.key`).
- **Workflow values are small JSON.** The input, each result, each signal payload and the output must stay under `limits.payload` (65 536 bytes by default). A larger input makes `start` return `CommandConflict`; a larger result fails its step with `WORKFLOW_LIMIT`. A value must also come back from JSON unchanged (no `Date`, no class instance), or it is `UNSTABLE_SCHEMA`. Store big data elsewhere and keep a reference.

## Documentation

The [agent guide](docs/agent-guide.md) has the model, a task map, the rules and the errors. Upgrade guides are in [`docs/upgrades/`](docs/upgrades/): the latest is [0.3.0 to 0.4.0](docs/upgrades/0.3.0-to-0.4.0.md). The [design spec](https://github.com/arki-labs/arki/blob/main/packages/journal/docs/specs/2026-10-09-journal-design.md) explains intent.

## Support

Questions and bugs: <https://github.com/arki-labs/arki/issues>. Include the package version, the error `code` and the output of `DEBUG=arki:journal:*`.
