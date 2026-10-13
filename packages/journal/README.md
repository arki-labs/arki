# @arki/journal

A journal keeps two things and writes them together.
Every change is one immutable row in `journal_events`.
Each entity also has a normal row in its own Drizzle table.
A command is the way to write: `j.command` defines one, `journal.run` runs it.
`journal.bind` is the door for a request or a job: it fixes the database and the actor once.
Inside the command, `write` validates the event data, appends the events, runs the reducers, saves the row, runs inline projections and queues jobs for async effects, all in one transaction.
Reads are plain Drizzle queries. Replay exists for checks and repair, not for reading.

Exports: `@arki/journal` (portable core), `@arki/journal/pg` (table definitions), `@arki/journal/dot` (optional `@arki/dot` plugin and feature slice, see Dot), `@arki/journal/orpc` (optional oRPC error mapping, see Rejected rules).

**Agents: start at [`llms.txt`](llms.txt).** Then open the part of the [agent guide](docs/agent-guide.md) that fits the task:

| Task                                                                            | Read                                                                                                                       |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Understand the model and the three objects (`j`, the entity builder, `journal`) | [The model](docs/agent-guide.md#the-model), [Three objects](docs/agent-guide.md#three-objects)                             |
| Set the journal up in an app                                                    | [Setup](docs/agent-guide.md#setup)                                                                                         |
| Add an event and react to it in the same transaction                            | [Add an event](docs/agent-guide.md#add-an-event-and-react-in-the-same-transaction)                                         |
| Add an entity, with create and delete                                           | [Add an entity](docs/agent-guide.md#add-an-entity-with-create-and-delete)                                                  |
| Add an effect that runs after commit                                            | [Add an effect](docs/agent-guide.md#add-an-effect-that-runs-after-commit)                                                  |
| Add a command and run it from a request or a job                                | [Add a command](docs/agent-guide.md#add-a-command-and-run-it)                                                              |
| Find out why a write failed                                                     | [Find out why](docs/agent-guide.md#find-out-why-a-write-failed), [Errors](docs/agent-guide.md#errors)                      |
| Check or repair a row, rebuild a read model                                     | [Recovery verbs](docs/agent-guide.md#recovery-verbs)                                                                       |
| Wire it in a Dot app, or ship journal pieces from a package                     | [Dot](docs/agent-guide.md#dot), [Shared packages](docs/agent-guide.md#shared-packages)                                     |
| Change code inside this package                                                 | [Rules that bite](docs/agent-guide.md#rules-that-bite), [Do not clean these up](docs/agent-guide.md#do-not-clean-these-up) |

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

`write` returns `{ row, events }`: the stored row after the write (`null` after a delete) and the recorded events, each with `seq`, `id`, `entityId`, `version`, `meta` and `recordedAt`. An entity can be created again after a delete; its version continues from the last event.

### Rows that existed before the journal

A row the journal creates gets version 1 from its create event. A row that was there first (stored `version` 0, no events in the log) can still be written to, but its history starts at version 2: the first write treats the row as version 1 and records its event as version 2. Version 1 therefore always means "created from nothing". `replay`, `verify` and `repair` need a history that starts at version 1 and throw `NO_HISTORY` otherwise, because folding a partial history from nothing would pick the wrong reducers and build the wrong row. They also need every version up to the top, and a live row no newer than its log, and throw `HISTORY_GAP` otherwise: an event lost after it was written must be restored, not folded around.

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

Adding an optional field, or one with a default, is safe. Old rows still parse.

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

## The worker

`journal.worker(db, { pollMs, batchSize })` is a loop around `drain`. When a pass finds no job it sleeps `pollMs` (1000 by default).

- A pass claims one job at a time, right before it runs it, up to `batchSize` jobs. So each job's 60-second lease covers its own work only, and a slow job cannot let the lease of a later one run out. A job queued during the pass can run in the same pass.
- `stop()` aborts the running effect's `ctx.signal`, claims no further job, and resolves when that effect returns. An effect that does long work should pass `ctx.signal` on (for example to `fetch`) so shutdown does not wait for it.
- A job longer than the 60-second lease can still be claimed by a second worker. Keep effects short, or split the work.
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

## Dot

`@arki/journal/dot` connects the journal to an `@arki/dot` app. It exports the plugin `journal(...)` and the feature slice `journalHandlers(...)`. `@arki/dot` is an optional peer. The core entry never imports it.

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

**Dot app.** Each feature lists its own handlers with `journalHandlers`. The plugin builds the journal from the feature list. There is no root file: `features.ts` is the only list.

```ts
// src/features/orders/feature.ts
export const orders = defineFeature('orders', {
  needs: { mailer: service<Mailer>() },
  use: [journalHandlers({ projections: [customerStats], effects: [orderMail] })],
});

// src/app.ts
export const app = defineApp('shop')
  .use(db())
  .use(mailer())
  .useAll(plugs(features))
  .use(journal({ j, tables: journalTables(), features: tokens(features) }));

// The gateway binds the door once per request, in its context factory. A procedure calls `context.run`.
const run = services.journal.bind(services.db, { actorId: user.id });
await run(payOrder, input);
```

- `journal(...)` publishes `services.journal`. It needs the root database under the `db` key. A transaction there is a compile error.
- It starts one worker on `start` and stops it on `stop`. Options: `worker: false` (no worker in this process), `pollMs`, `batchSize`.
- `effects` is a list. An effect with needs gets them from the booted services of the feature that lists it, by name. The feature must declare each one in its own `needs`, or it does not compile.
- Two features may use the same need name for two different services. Each effect gets the service of its own feature.
- Every effect is an action in the app manifest (`binding: 'journal'`, id `<name>.run`). Projections are never listed: they run inside the write.
- Two features with the same projection name or the same effect name fail the boot. The message names the duplicate and both features.
- A feature without `journalHandlers` adds nothing. That is allowed.
- The feature tokens are needs at run time only. A feature mounted after `journal(...)`, or not mounted, fails at boot and not at compile time.
- An app that composed its journal itself passes it: `journal({ journal })`.
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
  unique (kind, entity_id, version)

journal_jobs
  id            varchar primary key       -- job_xxx; pass it on as an idempotency key
  event_seq     bigint not null references journal_events(seq)
  effect        varchar(128) not null
  attempts      integer not null default 0
  available_at  timestamptz not null default now()
  lease_until   timestamptz
  lease_token   varchar
  last_error    text
  dead_at       timestamptz               -- set after 8 failed attempts
  unique (event_seq, effect)
  index (available_at) where dead_at is null
```

A job row is deleted when its handler succeeds. The table holds only pending and dead work. The event row is the lasting record.

An entity table needs a string key column that is primary or unique (`id` by default) and `version integer not null default 0`.

## Debugging

`DEBUG=arki:journal:*` prints commands, writes, replays, drains and worker ticks.
