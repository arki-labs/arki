# @arki/journal

A journal keeps two things and writes them together.
Every change is one immutable row in `journal_events`, unless the entity is declared `events: 'transient'` (see Transient events).
Each entity also has a normal row in its own Drizzle table.
A command is the way to write: `j.command` defines one, `journal.run` runs it.
`journal.bind` is the door for a request or a job: it fixes the database and the actor once.
Inside the command, `write` validates the event data, appends the events, runs the reducers, saves the row, runs inline projections and queues jobs for async effects, all in one transaction.
Reads are plain Drizzle queries. Replay exists for checks and repair, not for reading.

**Agents: start at [`llms.txt`](llms.txt).** For constants, error codes and the event graph helpers, see the [API reference](docs/api-reference.md). Then open the part of the [agent guide](docs/agent-guide.md) that fits the task:

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

Optional peers: `@arki/dot`, `@orpc/server`, `@arki/http`, `@kurrent/kurrentdb-client` (only for `@arki/journal/kurrentdb`), `@electric-sql/pglite` and `drizzle-kit` (only for `@arki/journal/testing`).

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
  { writes: [OrderPaid] },
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

// Async lane: after commit, at least once. The context also has `db`, the root database.
// An effect only reaches out: it runs no command. It lists what it needs and gets it in the context.
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

The core and `@arki/journal/errors` hold no driver. They load on Node, Bun, Deno and in the browser. `bun run test:runtimes` proves that. The write path needs a Drizzle database on Postgres, so it runs where your driver runs (Node, Bun). `@arki/journal/testing` runs an in-memory PGlite for tests. `@arki/journal/kurrentdb` runs where `@kurrent/kurrentdb-client` runs (gRPC: Node and Bun); its tests use Node.

## Commands

`j.command(name, inputSchema, options, handler)` returns a plain value with `name`, `input` (the schema, so a procedure can reuse or `.pick` it), `writes` and the handler. Nothing is registered anywhere. The handler gets the parsed input and a context:

- `tx`: the command's transaction. Use it for reads, or for writes outside any entity.
- `meta`: the parsed metadata. Every `write` in the command records it.
- `write(entity, id, events)`: `journal.write` bound to `tx` and `meta`. `events` is `(row, { tx }) => pending events`, sync or async.
- `run(child, input)`: run another command in a savepoint of the same transaction, with the same `meta`.

`options.writes` lists the events the handler writes, and it is required. `write` takes only those events: anything else is a type error, and `writes: []` is a command that only runs child commands, whose lists are their own. The list stays on the command value as an exact tuple (`placeOrder.writes`), so code can read it before the journal boots.

A handler that gets past the types is stopped at run time: the first undeclared event fails the run with `BAD_DEFINITION`, naming the command and the event, and nothing commits, even when the handler catches the error. A helper that takes `write` names what it writes: `CommandWrite<Meta, Tx, typeof OrderPlaced | typeof OrderPaid>`, or `Pick<CommandContext<Meta, Tx, typeof OrderPlaced>, 'write' | 'tx'>`. A command can pass its `write` to a helper only when it declares at least those events. The types do not catch the other direction: an event in `writes` that the handler never writes compiles and runs.

`journal.run(source, command, input, meta)` parses `input` with the command's schema (`parseAsync`; a schema failure returns before the handler runs) and `meta` with the app schema, then calls the handler inside `source.transaction(...)`. The root database opens a transaction. A transaction opens a savepoint, so the caller still decides the commit. It returns what the handler returns. Errors pass through unchanged.

`journal.bind(source, meta)` is the door. It returns `(command, input) => journal.run(source, command, input, meta)`, so a request context or a job fixes the database and the actor once, and every call site passes only the command and its input. The caller still gives `meta`: the library never picks an actor. `source` follows the rules of `run`: a root database commits and wakes, a transaction joins and leaves the commit to the caller. `meta` is parsed on every call, not once at bind time. A bound runner is then exactly `journal.run`: a default in the meta schema is new for each command, and a bad `meta` rejects the call. The runner has the type `CommandRunner`, the type of a command context's `run`, so it can be passed to code that takes one.

Await every `write` and `run` before the handler returns. `run` waits for any operation still running, then fails the command and rolls back, because a transaction must not close with work in flight. If the handler threw, the handler's own error is reported. The low-level `journal.write` inside your own `db.transaction(...)` has no such guard: await every journal call before your transaction callback returns.

Inside a command, an uncaught failure anywhere rolls back everything the command did. A child failure the parent catches rolls back only that child. A command may touch no entity, one, or several; it may return any value. Command input is not stored, so it may hold Dates and transforms. Event data and `meta` keep the storage rules below.

The types are all inferred: the handler's `input` from the schema, `journal.run`'s `input` as the schema's input type, the return type from the handler, `row`, id and events in `write` from the entity, `tx` from `initJournal.tx<AppTx>()`, `meta` from the meta schema.

### Tracing

Every recorded event says where it came from. The library stamps three columns; the app never sets them.

- `commandId`: the `cmd_` id of the run that wrote the event. A child run gets its own. A bare `journal.write` has none.
- `causeSeq`: inside a workflow step's `ctx.run`, the `seq` of the event the job was for. So a reaction points at what it reacts to.
- `correlationId`: one id for the whole chain. A run from a workflow step continues the cause event's chain. A root run starts a new chain, unless `journal.run(db, cmd, input, meta, { correlationId })` or `journal.bind(db, meta, { correlationId })` seeds it, for example with the request id. A bare write starts its own chain.

The command context exposes `commandId` and `correlationId` for logs. To read a chain: `select * from journal_events where correlation_id = $1 order by seq`. Rows written before these columns existed have `null` in all three.

**OpenTelemetry spans.** The journal emits three spans through `@opentelemetry/api`, with the tracer `@arki/journal`. It installs no SDK: with none installed, the spans cost nothing and export nothing.

| Span              | Around                                                                               | Attributes                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `journal.command` | one command run, inside its transaction, around the command hooks                    | `journal.command.name`, `journal.command.id`, `journal.correlation_id`, `journal.command.idempotent`                                              |
| `journal.effect`  | one effect attempt, inside its lease, around the effect hooks                        | `journal.effect.name`, `journal.job.id`, `journal.job.attempt`, `journal.event.type`                                                              |
| `journal.step`    | the body or the undo of one workflow step attempt, inside its `workflow.step` effect | `journal.workflow.name`, `journal.workflow.version`, `journal.workflow.run_id`, `journal.step.name`, `journal.step.attempt`, `journal.step.phase` |

Each span ends with `journal.outcome`: `ok`, `failure` (a returned failure, with `failure.code`) or `defect` (a throw). A failure is not recorded as an exception event. Inputs, payloads, meta, results and error messages are never attributes. The span is the active span while the work runs, so a command that an effect or a step runs is its child. A tracer or context manager that throws changes nothing: the work runs once and its result passes through.

### Idempotent commands

A webhook or a retried request can run the same command twice. `journal.run(db, cmd, input, meta, { idempotencyKey })` makes the second run answer like the first and write nothing. The first run records the key, the command name, the parsed input and its result in `journal_receipts`, inside its own transaction, so a receipt exists exactly when the run committed. A later run with the same key and the same input returns the stored result without running the handler; hooks still run and see `ctx.idempotencyKey`. The same key with another input, or with another command, returns `CommandConflict` (`journal.conflict`). A concurrent repeat waits for the first to commit, then replays it. A key cannot be reused inside its own run.

The result must survive JSON, because the replay returns the stored form; a result with a `Date` or a class instance fails the first run with `UNSTABLE_SCHEMA`. Return plain data: an id, a status, a version. A key from outside is scoped by the app: `${tenant}:${eventId}`, never the bare client value. A bound runner and a workflow step's `ctx.run` take the key per call: `runAs(cmd, input, { idempotencyKey })`.

A replay does not run the handler, so a permission check inside the handler does not run either. Put it in the command's `authorize` option: `j.command(name, input, { writes, authorize: (input, { tx, meta }) => ... }, handler)`. It runs inside the transaction on every call, a replay included, before the stored result is returned; it returns a failure (`CommandForbidden`, usually) to refuse, and a refused replay changes nothing. `journal.run` returns that failure, and the command's type includes it. A throw refuses too.

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
| Task      | `run(command, input, { actorId: 'system' })`                      | See below. A task never imports the journal root.                         |
| Script    | `journal.run(db, command, input, { actorId: 'script:backfill' })` | One call per item; each is its own transaction.                           |
| Test      | `journal.run(db, command, input, meta)`                           | No procedure, no HTTP. The same validation and transaction.               |

An event that must run a command starts a task or a workflow. An effect only reaches out: its context has no `run`, so that call does not compile.

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
// src/features/orders/tasks.ts
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

// src/journal.root.ts
export const journal = j.compose({ workflows: [closeAfterPayment], workflowMeta: { actorId: 'system:workflow' } });
```

- `run(command, input, meta)` is `journal.run` on the root database that the worker or `drain` was given. It opens its own transaction and commits before it returns.
- `meta` names the actor. A workflow body may leave it out: the command then records the `workflowMeta` the app gave `compose`. The library never picks an actor.
- If the command throws, nothing of the command is committed, and `run` returns the throw as `TransactionDefect`. A body that throws it on is tried again by its retry policy. A body that returns it fails: a returned failure is final.
- If the body fails after `run` returned, the command stays committed and the body runs again. So the command can run twice. Make it safe: check the row and return `[]`, or pass `key` from the context in the input and store it. Or use a [command node](#command-nodes), which commits the command with its checkpoint, so it runs exactly once.
- A command that queues a job wakes the worker. A chain of jobs does not wait for the poll.

## The low-level write

`journal.write(tx, entity, id, { meta, events })` is what a command's `write` calls. Use it directly only when there is no command: a one-off migration step, or a test that needs a specific `meta` per write. `events` is the function that looks at the locked row, checks the rules, and returns the events to append. It runs after the row is locked, inside the write's savepoint, and receives that savepoint as `{ tx }`, so it can read related rows under the lock. It may be async. It only accepts events declared on the entity; the row type, the id type and the event data types are all inferred. When a rule says no, `events` returns a failure instead, such as `CommandNotFound({ detail: 'Order not found' })`: the savepoint rolls back, nothing is written, and `write` returns that failure. A command handler returns it on (`if (isFailure(paid)) return paid;`), and the whole command rolls back. Going on to a success is `IGNORED_FAILURE` (see Rejected rules).

`expectedVersion` is the row version the caller saw. If the stored version differs (0 for no row), the write is refused with `CONFLICT` before `events` runs. A command passes it on: `write(order, id, events, { expectedVersion: input.version })`. The client sends the version it rendered; `commandErrors()` turns the refusal into a 409 that asks it to reload. This is how concurrent editors and stale game moves are caught without a hand-written version compare.

A row insert that hits a unique constraint is `CONFLICT` too, for every entity: a create that lost a race, or a column value another row already holds. The write rolls back with its events. To give the caller a clear answer on the retry, check a value that must be unique inside `events` and return a failure when it is taken.

`write` returns `{ row, events }`, or the failure `events` returned: the stored row after the write (`null` after a delete) and the recorded events, each with `seq`, `id`, `entityId`, `version`, `meta`, `recordedAt` the trace `commandId`, `causeSeq`, `correlationId` (see Tracing), and `erasedAt` (see Erasure). An entity can be created again after a delete; its version continues from the last event.

### Transient events

By default every entity keeps its events: `initJournal({ tables })` means `initJournal({ tables, events: 'stored' })`. An entity whose history is worth nothing (a draft, a cursor, a row that is rebuilt anyway) can skip the log. The setting is a journal default with a per-entity override, either way:

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
const j = initJournal({ tables, events: 'stored' }); // the journal default; 'transient' flips every entity
const draft = j.entity('draft', drafts, { events: 'transient' }); // this entity keeps no events
const order = j.entity('order', orders, { events: 'stored' }); // stored, even under a transient default
```

A transient write does everything a stored write does except the `journal_events` insert: the append lock, the row lock, `expectedVersion`, the rules in `events`, the reducers, the row save, inline projections and effect jobs. The recorded events exist in memory. They get a real `seq` from the events table's own sequence, so `seq` stays the global write order across both kinds, and `recordedAt` from the transaction's `now()`; the write returns them as usual. An effect job for such an event has `event_seq` null and the event's copy in `args`, as every effect job does. Two creates of one id that race are `CONFLICT`, caught by the row's own key instead of the log's index.

| Feature                                                              | `stored` | `transient`                                                  |
| -------------------------------------------------------------------- | -------- | ------------------------------------------------------------ |
| Row, version check, `expectedVersion`, inline projections, receipts | works    | works                                                        |
| Effects                                                              | works    | works; `event_seq` null, the event in `args`                 |
| `replay`, `verify`, `repair`, `forget`, `adopt`                      | works    | `NO_HISTORY`                                                 |
| Async projections, taps                                              | works    | refused at `compose` with `BAD_DEFINITION`                   |
| `rerun`                                                              | works    | `NO_HISTORY`                                                 |
| Durable workflows                                                    | works    | works: `workflow.run` always stores its events               |
| Audit by command or correlation id, an event browser                 | works    | nothing to show                                              |

Two things to know. `version` counts one row's lifetime, not the id's: a transient entity created again after a delete starts at version 1, where a stored entity continues from its last event. And `forget` is refused, so personal data in a transient event lives only in the effect jobs' `args`, until the job leaves the archive (`retention.archive`).

To switch an entity to `'stored'` later, change the setting and `journal.adopt` each row before its first write: the row keeps its values, gets a create event as version 1, and its version becomes 1 (see Rows that existed before the journal). A row written to after the switch and before its adopt has a log that starts above 1; adopt refuses it with `CONFLICT`, and that row's history stays partial.

### Events in another store

`events` also takes an event log: an object with `append`, `stream` and `highestVersion`, and optionally a global order (`all`) and `erase` (the `EventLog` type). It can live in another Postgres database, an event store or any append-only store. Check an adapter with the suite in `@arki/journal/event-log-contract`: `eventLogContract(makeLog)` returns plain `{ name, run }` cases for any test runner, and a case that does not apply to the log throws `ContractSkip`.

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
const order = j.entity('order', orders, { events: kurrentLog }); // this entity's events go to that log
```

A log that joins the row's transaction (`canJoinTransaction: true`, `bind(db)`) is written with the row, as `'stored'` is. A log that cannot join is **forwarded**. The write commits the row, inline projections, effect jobs and one `forward` job that carries its events, all in the app database. The worker appends them to the log after the commit. The row is always right; the log lags.

- **Order.** One entity's forward jobs form a stream (`stream` and `stream_position` on `journal_jobs`). A job runs only once no earlier job of its stream is left in the table, dead ones included, so the log never gets a hole.
- **The ladder.** Before it appends, the worker reads the log's top. Below the job's version: an earlier batch has not landed, so the job waits and tries again; it never dies of waiting. At or above: `append` takes the batch, or acks it when the same event ids are already there. Other events at those versions are `FORWARD_DIVERGED`: something else wrote to the log, and the job dies at once.
- **A diverged stream.** Find what wrote to the log. Then `discard` the dead job (it is allowed only once the log holds every version the job carries) and `repair` the row from the log, or remove the foreign events and `retry` the job. `cancel` never takes a forward job, and `purgeDead` keeps a dead job that later jobs of its stream wait behind.
- **Lag.** `journal.forwardLag(db)` returns `{ pending, dead, oldestEnqueuedAt }`. Effects run from the write's own events, so an effect may run before the log has its event.
- **Versions.** A create on a missing row continues the version count: from the last pending forward job, or from the log when none is pending. That one read of the log happens while the write holds the append lock.

| Feature                                                   | forwarded                                                  |
| --------------------------------------------------------- | ---------------------------------------------------------- |
| Row, version check, inline projections, effects, receipts | works                                                      |
| `replay`, `verify`, `repair`                              | read the log; `FORWARD_PENDING` while a forward job waits  |
| `forget`                                                  | needs `erase`; `FORWARD_PENDING` while a forward job waits |
| Async projections, `rerun`                                | need `all`; all of a projection's entities share one log   |
| Taps                                                      | refused at `compose`: they read only `journal_events`      |
| Durable workflows                                         | `workflow.run` always uses the built-in log                |

One entity kind has one log: declaring it twice with two different logs is `BAD_DEFINITION`. A forward job carries the write's events in `args`, and the archive keeps finished jobs (7 days by default): `forget` erases the archived copy too, and the archive sink gets only the event headers.

#### Another Postgres database

`postgresEvents` from `@arki/journal/postgres` keeps an entity's events in a second Postgres database. Put `eventLogTables()` from `@arki/journal/pg` in that database's schema module and migrate it there. The log cannot join the app's transaction, so its entities are forwarded.

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
import { eventLogTables } from '@arki/journal/pg';
import { postgresEvents } from '@arki/journal/postgres';

export const eventStoreTables = eventLogTables(); // in the event store's schema module
const storeLog = postgresEvents({ db: eventStoreDb, tables: eventStoreTables });
const order = j.entity('order', orders, { events: storeLog });
```

It has every part of the log: `all`, so async projections and `rerun` work, and `erase`, so `forget` works. Workers append to different entities at the same time, so a later row can commit before an earlier one. `all` therefore orders events by the appending transaction (`transaction_id`, then `seq`), and reads only rows below the oldest transaction still open on that server. A reader never moves past a row that could still commit behind it. The cost: one long transaction on that Postgres server holds async projections back until it ends. Its positions look like `"transaction id:seq"` and have no `distance`.

#### KurrentDB

`kurrentEvents` from `@arki/journal/kurrentdb` keeps an entity's events in KurrentDB (formerly EventStoreDB), through `@kurrent/kurrentdb-client`. Its entities are forwarded.

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
import { KurrentDBClient } from '@kurrent/kurrentdb-client';
import { kurrentEvents } from '@arki/journal/kurrentdb';

const client = KurrentDBClient.connectionString`kurrentdb://localhost:2113?tls=false`;
const order = j.entity('order', orders, { events: kurrentEvents({ client }) });
```

- **Streams.** One entity is one stream, `<kind>-<entityId>`, so KurrentDB's `$ce-<kind>` category groups a kind. A kind must not contain `-` (`BAD_DEFINITION`). `prefix` puts every stream of the log under one name, such as `'billing.'`, for several apps or test runs on one cluster.
- **Events.** The event's type and data are KurrentDB's own fields; everything else of the journal event sits in its metadata under `journal`. Data must be a JSON object, array or string. KurrentDB takes only UUID event ids, so each event gets a UUIDv5 of its journal id, and a retried append carries the same ids.
- **Appends.** Each batch is one atomic append with the stream's expected revision. A repeat KurrentDB does not recognise is read back and acked when the same journal events are there.
- **Order.** `all` reads `$all`, which is KurrentDB's commit order. Positions look like `"commit:prepare"` and have no `distance`.
- **forget** is refused (`NO_HISTORY`): KurrentDB cannot rewrite an event in place. A `copyLog` into KurrentDB carries an erased event's erased data, without the erase stamp.

#### Switching an entity's store

Changing `events` on an entity that already has events is a migration, not a setting. After a switch to a new log, the first forward job expects version N, the new log is at 0, and the job waits forever. A switch back would make the next write leave a gap. Copy the history first:

1. Pause writes to the kind and drain its forward jobs.
2. `await journal.copyLog(db, order, { to: storeLog })` copies the kind's events from the log it uses now into `to` (`'stored'` is the built-in log). Ids, versions, seqs and schema versions stay as they are, and an erased event is erased again where `to` can erase. It is refused while forward jobs of the kind wait (`FORWARD_PENDING`), onto the log the kind already uses (`BAD_DEFINITION`), and from a log without `all`. It is safe to run again after a crash: an event that is already there is skipped.
3. Flip the entity's `events` setting, deploy, and resume writes.
4. `reset` the async projections that read the kind: their positions belong to the old log.

The old log keeps its copy. Delete it yourself if it holds personal data, because `forget` reaches only the log the entity uses.

### Rows that existed before the journal

A row the journal creates gets version 1 from its create event. A row that was there first (stored `version` 0, no events in the log) can still be written to, but its history starts at version 2: the first write treats the row as version 1 and records its event as version 2. Version 1 therefore always means "created from nothing". `replay`, `verify` and `repair` need a history that starts at version 1 and throw `NO_HISTORY` otherwise, because folding a partial history from nothing would pick the wrong reducers and build the wrong row. They also need every version up to the top, and a live row no newer than its log, and throw `HISTORY_GAP` otherwise: an event lost after it was written must be restored, not folded around.

To bring such a row in properly, adopt it before its first write. `journal.adopt(tx, entity, id, { meta, events })` takes a row at any version whose log is empty, calls `events(row)` for exactly one create event built from the stored row, and checks that the event's `.create` reducer rebuilds the row exactly, column by column (`version` aside). If it does, the event is recorded as version 1 and the row moves to version 1: the history is complete, and `replay`, `verify` and `repair` work from then on. If it does not, `VALUE_MISMATCH` names the column and nothing changes. A missing row is `CONFLICT`. So is a row whose log is not empty: the journal already knows it, or it was written to after its events started being stored, and its history cannot be completed any more. Projections run and effects are queued as for any write, because the event is the app's own. Run it once per row, in a migration or a one-off script, before the app writes to the row.

The same call switches an entity from `events: 'transient'` to `'stored'`: change the setting, then adopt each row before its first write. A row the transient entity left at version 12 comes out at version 1, because its history starts there; a client that still holds `expectedVersion: 12` gets `CONFLICT` once and reads the row again.

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

A workflow run that waited for one of the entity's events keeps no copy of it: the run stores a pointer to the event, so the erased form is what every run reads after `forget` (see [Wait for an event](#wait-for-an-event)).

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

A handler that meets a refusal and still has a good answer says so with `accept(result)`, on the command context and on a workflow step's context. Check the value first, then accept it. `accept` lifts only this command's own check: a refused child's savepoint stays rolled back, and the fallback's own refusals are tracked too. It returns nothing and commits nothing by itself: a handler that accepts a failure and then returns it still rolls back. Every refusal is tracked by identity, once per return: two refusals with the same code need two `accept` calls, and so does the same object returned twice. Accepting one and ignoring another is still `IGNORED_FAILURE`. An accepted success is stored as the idempotency receipt like any success. `accept` throws `JournalError` `INVALID_ACCEPT` for a value no `write` or `run` of this handler returned (hand-built, from a helper, a copy, or one only the parent received), for a second call on one return, for a call after the handler finished, and for a value that is not a failure. A parent may accept a failure its child passed up, and a child's `authorize` refusal, since both come back from `run` as the same instance.

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
const placeOrder = j.command('placeOrder', orderInput, { writes: [OrderPlaced] }, async (input, { write, run, accept }) => {
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

`commandErrors()` answers a failure, thrown or returned by the procedure, with the `ORPCError` of its code, status, message and data, and a `JournalError` with code `CONFLICT` with a 409 that asks the client to try again. The `TransactionDefect` that `journal.run` returns for such a conflict gets the same 409. Every other error passes unchanged. `toORPCError(error)` is the same mapping as a function. A procedure with an output schema, and every contract-first one, hands the command's result to `orThrowCommand(result, errors)` from `@arki/journal/orpc`. The contract lists its business failures with `errorMap(OrderRefused, ...)`, and the client gets them typed. The journal's own failures (`CommandFailure`: bad input, a lost race, a failed transaction) need no listing: they answer through `toORPCError`. `orThrowRpc(result, errors)` from `@arki/failure/orpc` is the stricter form, for a contract that lists every failure. A host without oRPC reads the failure's `status`, or matches it with `CommandNotFound.is(result)` and the like. The codes and their HTTP meaning are in the [agent guide](docs/agent-guide.md#rejected-rules).

Other verbs: `replay(db, entity, id, { throughVersion })` (returns the reducer-shaped row), `verify(db, entity, id)`, `repair(db, entity, id)`, `rerun(db, projection, { after, batchSize })`, `drain(db, { batchSize, signal })`. `drain` and `worker` take the root database (`RootDb`), never a transaction: effects must run after commit. Lease and retry times use the database clock.

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

A projection runs inline by default: inside the write's transaction, so the read model is exact. A slow or large one can run later instead: `j.projection('leaderboard', game, handlers, { lane: 'async' })`. The write then only wakes the worker. The worker, after every drain pass, gives each async projection one batch: it locks the projection's row in `journal_cursors`, scans the next `batchSize` events in commit order, applies the matching ones on that same transaction, and moves the cursor to the last event scanned. Progress and the read model's writes commit together, so a crash cannot apply a batch twice or skip one. The cursor counts every event, matching or not, so `journal.cursors(db)` reports an honest answer: each cursor's `position` in the log (the built-in log writes a seq as text), `behind` while newer events exist, and `distance` in seqs. `behind: false` means caught up. A projection whose batch throws is skipped that pass and tried again next pass; the others go on.

`journal.catchUp(db, { batchSize })` runs one batch per async projection by hand, for tests and scripts. `journal.reset(db, projection, async tx => { await tx.delete(table) })` empties the read model and rewinds the cursor in one transaction, with the cursor locked first, so no batch lands in between. To rebuild with no downtime, deploy the projection under a new name into a new table, wait until it is no longer `behind`, switch reads, then drop the old one. `rerun` is for inline projections only. `forget` locks every async cursor before it rewrites, so a batch in flight cannot commit erased data after it.

## Effects

An effect runs after the commit, at least once, from a row in `journal_jobs`. An effect reaches out: a mail, a webhook, a provider. A handler gets the event and a context: `(e, { jobId, signal, db })`.

- `jobId` stays the same across retries. Pass it on as an idempotency key.
- `signal` is the `signal` given to `drain`.
- `db` is the root database given to `drain` or `worker`: the same object. Use it to read committed rows. The effect needs no closure for the database.
- There is no `run`. An event that must run a command starts a task or a workflow. See [Where commands run from](#where-commands-run-from).

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

- `need<Mailer>()` comes from `@arki/journal`. It is a marker: it holds the type and no value. In a Dot feature, `needsOf((_: Deps) => ['mailer'])` makes the same record with the type read from the feature (see [A `defineFeature` feature](#a-definefeature-feature)).
- Each handler gets the service in its context, under the name of the need, with its type.
- The app gives the real services once, in `services`. Every need of every listed effect must be there. A missing one is a compile error, and `compose` throws: `journal: effect "order-mail" needs "mailer", but no service with that name was given; ...`.
- Two effects that use the same name get the same service.
- A need cannot be named `jobId`, `signal`, `db` or `run`. `j.effect` throws.
- An effect that needs nothing has three arguments: `j.effect(name, entity, on)`.

`db` has the library's `RootDb` type unless the app names its own database type once: `initJournal.db<AppDb>().create({ tables, meta })`. Then `ctx.db.query.orders` is typed, and `drain` and `worker` need an `AppDb`. They still refuse a transaction. With `.tx<AppTx>()` they also need a database that opens `AppTx` transactions, because effects run commands on it. The app's own Drizzle database does. `.tx<AppTx>()` and `.db<AppDb>()` are both optional type-only steps and chain in either order: `initJournal.tx<AppTx>().db<AppDb>().create({ tables, meta })`.

### When a job runs

An effect can carry a schedule: `j.effect('receipt', order, handlers).withSchedule({ priority: 10 })`. `priority` (an integer, default 0): among due jobs the higher one is claimed first. It is strict, so a steady stream of high-priority jobs can starve lower ones; use a few levels, not a score. `delaySeconds`: the job is due that long after the write's transaction started (Postgres `now()`), so a long transaction uses part of the delay before commit. `runAt: event => Date`: the job is due at the time the event names, from the app's clock; a time in the past is due at once. Give `delaySeconds` or `runAt`, not both. `priority` may also be a function of the event, `priority: event => number`, so each job gets its own on the same scale; workflows use it so each run's jobs carry that run's `priority`. A value outside 32 bits throws `BAD_DEFINITION` when that job is written. `when: event => boolean`: the write makes a job only for the events where it returns true, so `withSchedule({ when: e => e.data.total > 10_000 })` queues nothing for small orders. The default is every event of the effect's types. `retry`: a `Backoff` from `@arki/resilience` (re-exported here as `backoff`), the same retry schedule queue jobs and resilience policies take. It says how long a failed job waits before its next try, and when it is dead instead: `withSchedule({ retry: backoff.exponential({ base: 5_000 }).upTo(3).while(error => error instanceof SmtpError) })`. The default is `backoff.exponential({ base: 1000, max: 300_000, jitter: 0.25 }).upTo(7)`: 8 tries, doubling from 1 s to at most 5 minutes. A throw is retried by the effect's `retry`, or by this default. `lastError` records the throw as `UnexpectedDefect`, but the `while` gets the error the handler threw, as is. Retries keep their priority. A handler may also return a failure from `@arki/failure` for an expected outcome, such as a declined card: the job is then dead after one try, because another try would repeat it. It runs again only when the `while` accepts that failure, as in `.while(reason => isFailure(reason) && reason.code === 'db.timeout')`. Its `lastError` is the failure as JSON: code, message, status and data. A bad value throws `BAD_DEFINITION` where the schedule is declared.

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

A worker hears it through `listen`: `journal.worker(db, { listen })`, where `listen` is `onMessage => unlisten`. `LISTEN` needs a dedicated connection. With a `pg` pool, use `listenOnPool(db.$client, journal.wakeChannel)` from `@arki/db/pg`: it borrows one client for as long as the worker runs, replaces it when the connection drops, and closes it on `stop()`. When `DB_URL` goes through a pooler (Neon, Supabase), pass `services.sessionPool` from the `db()` plugin instead of `db.$client`: through the pooler, `LISTEN` hears nothing ([Hosted Postgres](../db/README.md#hosted-postgres)). With PGlite, `onMessage => client.listen(journal.wakeChannel, onMessage)`. `LISTEN` hears only what is sent after it ran, and a connection can drop, so the worker keeps polling (`pollMs`); the channel makes it prompt, not correct. A listening worker drains at once on every commit.

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
journal.hooks.step.around(async (ctx, next) => {
  // ctx: { workflow, version, runId, step, attempt, phase }, frozen; phase is 'do' (the body) or 'undo'
  const started = performance.now();
  await next();
  log.debug('step %s (%s) of %s took %d ms', ctx.step, ctx.phase, ctx.runId, performance.now() - started);
});
```

The rules, all enforced:

- Call `next` exactly once. A second call throws. Returning without calling it throws: throw before `next` to stop the run instead.
- A rejection of `next` is the hook's rejection too. A hook that catches it and returns still fails, with the original error: a rolled-back command cannot look like a success to the caller.
- The context is frozen, and the result is the handler's own. A hook cannot change the input or the result.
- Hooks run in registration order, the first one outermost. Command hooks run inside the transaction, around the handler, so a throw rolls the command back cleanly; a child run is wrapped again, with its own `commandId` and the same `correlationId`. Effect hooks run inside the lease, around the handler, so a throw fails the job like a handler failure: it is retried with backoff and recorded on the job row.
- Step hooks wrap each workflow step body and each undo, inside the `journal.step` span, so a span a hook starts is a child of the step. They see no input and no result, as the span does. A throw fails that attempt of the step like a throw from the body: it is retried with the step's `retry`. A step's `when` and `key` functions run outside them. A node with no body of its own (a `sleep`, a `waitFor`, the start of a `child` or a `map`) is not wrapped.
- Registration is frozen once the journal has run a command, a drain or a worker. A later `around` throws `BAD_DEFINITION`. Step hooks are frozen by the first drain or worker. In a Dot app, a unit that needs the journal attaches in `boot`, which runs before the worker starts.

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

|                | Effect row                                          | Queue row                                    |
| -------------- | --------------------------------------------------- | -------------------------------------------- |
| `kind`         | `effect`                                            | `queue`                                      |
| Written by     | a journal write                                     | `runAfter(tx, job, args)` in any transaction |
| Needs an event | yes: its copy in `args` (and `effect`; `event_seq` when the event is stored) | no (`job_name`, `args`)                      |
| Run by         | the effect handler in the journal                   | the `jobs` runner                            |
| Retry          | the effect's `retry`                                | the runner's `retryDelay`                    |
| Dedupe         | one row per event and effect                        | optional `dedupe_key`, per job name          |

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

### Tasks

Most durable work is one unit: send the email, summarize the document, call the API. `j.task(name, options, run)` is that case. It is a workflow of one step named `run`: it builds `j.workflow(name, options).step('run', run, { retry, timeout, undo, key }).finish()`. So a task is a workflow definition in every way: `compose`, `start`, `startBatch`, `signal`, `cancel`, `read`, `child`, `map`, versions, concurrency, retention, `startOn`, the run fields and Foreman all work the same. `options` are the workflow's options (`version`, `input`, `output?`, `deadline?`, `concurrency?`, `retention?`, `limits?`, `needs?`, `startOn?`, `onDeadStep?`) plus the step's `retry?`, `timeout?`, `undo?` and `key?`. `run` gets the step context. The output is what `run` returns; with an `output` schema, `run` must return that schema's output, or the call does not compile. Use `j.workflow` when the work has more than one step, waits for a signal or sleeps.

```ts run
import { z } from 'zod';

import { orThrow } from '@arki/failure';
import { initJournal } from '@arki/journal';
import { journalTables } from '@arki/journal/pg';
import { openJournalDb } from '@arki/journal/testing';

const tables = journalTables();
const j = initJournal({ tables, meta: z.object({ actorId: z.string() }) });

const summarize = j.task(
  'docs.summarize',
  {
    version: 1,
    input: z.object({ docId: z.string() }),
    output: z.object({ summary: z.string() }),
    // The step's own options sit next to the workflow's.
    timeout: '10m',
  },
  async ({ input }) => ({ summary: `summary of ${input.docId}` }),
);

const journal = j.compose({ workflows: [summarize], workflowMeta: { actorId: 'system:workflow' } });
const { db, client } = await openJournalDb(tables);

const started = orThrow(await journal.run(db, summarize.start, { input: { docId: 'doc_1' } }, { actorId: 'usr_ada' }));
await journal.drain(db);
const done = orThrow(await summarize.read(db, started.runId));
// `output` is typed by the task's `output` schema.
if (done?.run.output?.summary !== 'summary of doc_1') throw new Error('the task completes with its output');
await client.close();
```

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

- `.step(name, fn, options?)`. `fn` gets the context: `input`, `results`, `key`, `attempt`, `runId`, `signal` (an `AbortSignal` for a lost lease or a timeout), `db`, `run` (runs a command), `accept`, `metadata` and `tags` (change the run's fields, below), and the needs by name. `run(command, input)` may leave the meta out: the command then records the `workflowMeta` the app gave `compose`. A meta passed as the third argument is used as given. Options: `undo`, `output` (a schema for the stored result), `key` (your own idempotency key), `retry` (a `Backoff`), `timeout`, `when` and `next`.
- `when: ctx => boolean` skips the step when it returns false. Its result is then `null`, and its type says so (`R | null`).
- `next: 'node'` or `next: ({ result }) => 'node' | 'next'` jumps back to an earlier node, so a loop is a step with `next`. A name later in the list does not compile.
- `.command(name, command, ({ input, results }) => commandInput, options?)` runs one command exactly once. See [Command nodes](#command-nodes).
- `.waitFor(name, { signal, schema, timeout?, onTimeout?, when? })` parks the run until `def.signal(name)` delivers the signal. The result is the payload, typed by `schema`. With `onTimeout: 'continue'` a timeout goes on with `null`; the default `'fail'` fails the node. `when` works as on a step: when it returns false the run does not park, the result is `null`, and the type says so (`payload | null`).
- `.waitFor(name, { on, timeout | until, onTimeout?, when? })` parks the run until one of the app's own events is recorded. See [Wait for an event](#wait-for-an-event).
- `.sleep(name, '24h')` or `.sleep(name, ctx => date)` parks the run until that time. `.sleep(name, until, { next })` loops back as a step's `next` does: an earlier node, `'next'`, or a function of `{ runId, input, results }` that picks one.
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

Pass the definitions to `compose`, with `workflowMeta`, the meta the runner records on its own checkpoints and on each command a body runs without a meta. The library never invents an actor: the app chose this one. List every workflow a `child` or `map` node starts too. The steps' needs come from `services`, like an effect's. Composing adds three effects (`workflow.step`, `workflow.timer`, `workflow.limitTimer`), one more per workflow with a `startOn` (`workflow.start:<name>`, see [Start on an event](#start-on-an-event)), one more per entity a wait watches (`workflow.wake:<entity kind>`, see [Wait for an event](#wait-for-an-event)), and one projection (the `workflow_steps` table).

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

- `def.start` takes `{ input, id?, scope?, tags?, metadata?, delay?, ttl?, maxAttempts?, timeout?, priority? }` and returns `{ runId }`. The default id is `wfr_<random>`. Give your own id to make the start idempotent: the same id and input return the same run, and another input or another `scope` is a `CommandConflict`.
- The run fields describe the run, not its work. `scope` is the key of the tenant or owner the run belongs to (1 to 256 characters). `tags` are up to 10 labels of 1 to 128 characters, to find runs by. `metadata` is a JSON object of at most 256 KiB (default `{}`). A field outside these limits is refused (`InvalidInput`; metadata that is too large is `CommandInvalid`), and no run starts. The limits are `RUN_FIELD_LIMITS`. A child run (`child`, `map`) takes its parent's `scope` and no tags or metadata. Each run stores `rootId`: null for a run with no parent, else the id of the top run of its tree. The readers return all four fields; a run in a list leaves out `metadata`.
- `delay` and `ttl` time the start. `delay` is an age (seconds, or `'5m'`, `'2h'`, `'1d'`) or a `Date`: the first node is due that much later (a time in the past is now). The run is stored at once in state `running`, holds its concurrency slot, and the readers show `delayedUntil` (the planned start while it is ahead and the first node has not started; else `null`). The deadline counts from the planned start. `ttl` is an age longer than 0: when a worker picks up the first node's first try after `ttl` has passed since the run was due, the body does not run and the run ends in the state `expired` (event `RunExpired`, the node skipped with cause `expired`). An expired run frees its concurrency slot. A run whose first node has started never expires. A bad value is `InvalidInput` and starts nothing. A child run takes no delay and no ttl. `journal.workflows.reschedule` (§ Operators) moves a start that has not happened yet.
- `maxAttempts`, `timeout` and `priority` override how this run's steps run, for the run's whole life (`RunOverrides`). A step's retry and timeout are code, so a run can only narrow them. `maxAttempts` (a whole number, 1 to `RUN_OVERRIDE_LIMITS.maxAttempts`, 100) caps the tries of every step: the step's `retry` (or the default) still picks the wait and which errors retry, but a step that reached `maxAttempts` tries is dead, and the run follows `onDeadStep`. `timeout` is an age longer than 0 (at most `RUN_OVERRIDE_LIMITS.timeoutMs`, about 24 days): each step and undo attempt is aborted after it, or after the step's own `timeout` when that is shorter. `priority` is an integer within 32 bits, the scale of an effect's `priority` (§ When a job runs): the run's step and timer jobs, retries included, are claimed in that order among due jobs (default 0, higher first). A bad value is `InvalidInput` and starts nothing. A child run takes none of them: it runs as its definition says. The run stores them as `maxAttempts`, `stepTimeoutMs` and `priority` (null when not given), and the readers return them.
- A step or an undo changes its run's metadata and tags with `ctx.metadata` and `ctx.tags`: `set(patch)` merges a JSON object into the top level, `increment(key, by = 1)` adds to a number (a missing key counts as 0), `append(key, value)` pushes onto an array (a missing key starts one), `remove(key)` drops a key, and `tags.add(...tags)` adds the tags the run does not have yet. Each call is its own command and one event on the run (`MetadataChanged` with the `change`, or `RunTagged` with the new tags; a call that adds no tag writes none). It commits at once, not with the step's checkpoint, so a reader sees the progress while the step still runs, under the attempt's fence: an attempt that has ended writes nothing. A call never rejects, so it may be left un-awaited (`void ctx.metadata.increment('done')`). It returns `{ metadata }` or `{ tags }` after the change, or a refusal: `CommandConflict` once the run has finished, `CommandInvalid` for a value of the wrong type (`increment` on a non-number, `append` on a non-array), metadata over 256 KiB after the change, or more than 10 tags. A database failure or a lost fence is returned as a failure too. None of these fail the step, even when they arrive after it settled, and none needs `accept`. A retried attempt runs its calls again: `set` and `remove` end with the same metadata, `increment` and `append` apply once more per attempt. Changes are allowed while the run is running, parked or compensating. `journal.workflows.setMetadata` and `addTags` (§ Operators) make the same changes from outside a run.
- `def.startBatch` takes `{ items, batchId? }` and starts many runs of one workflow in one transaction. Each item is what `def.start` takes, and there are 1 to `BATCH_LIMIT` (1000) items. It returns `{ batchId, runs }`: `runs[i]` is item i's outcome, `{ runId }` or its refusal (`WorkflowBusy`, `CommandConflict`, `CommandInvalid`). Each item runs in its own savepoint, so a refused item rolls back only itself and the others start. An item that does not fit the start schema, or a wrong number of items, is a caller bug: the whole batch is `InvalidInput` and nothing starts. The default batch id is `wfb_<random>`; every run stores it in `batchId`. `journal.workflows.batch(db, batchId)` counts its runs by state, and `runs(db, { batchId })` lists them (§ Operators).
- `def.signal(name)` takes `{ runId, deliveryId, payload }`. `name` must be a signal one of the `waitFor` nodes declares. `deliveryId` is the sender's own id, such as the webhook event id. It returns a `status`: `woke` (the run moved on), `kept` (stored; the run takes it when it reaches the wait), `duplicate` (this `deliveryId` was seen) or `finished` (the run is over, so it was dropped) or `no-run` (no run of this workflow has that id, or the id belongs to another workflow; nothing is stored). `no-run` is a status, not a failure, so a webhook for a missing run is answered 200 and the provider stops resending. The operator verb `journal.workflows.signal` names a specific run and still refuses an unknown one.
- `def.cancel` takes `{ runId, reason }`. It returns `{ state: 'compensating' }` while the run undoes its steps, or `{ state: 'cancelled' }` when there was nothing to undo.
- `def.read(db, runId)` reads the run back, typed. It checks the input, the output and each result that has a schema (a step `output`, a `waitFor` schema, the events of an event wait, a command's `output`, a sleep's `null`, and a child or `map` whose workflow declares an `output`; a `map` that waits for all checks every item). A result without a schema is `unknown`, and so is a child chosen by a function. A stored value that no longer fits its schema returns the failure `WorkflowReadMismatch` (code `journal.workflow_read_mismatch`). Another workflow's run, or an unknown id, gives `undefined`.

```ts continue
const { db, client } = await openJournalDb(tables); // in an app: the root database
const customer = { actorId: 'usr_ada' };

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

`journal.workflows` reads runs and moves them by hand. A run's `state` (`RunState`) is one of `queued` (waiting for a slot, `onBusy: 'queue'`), `running`, `parked`, `compensating`, `completed`, `failed`, `cancelled` or `expired`. `runs` filters by it, and `counts` and `batch` count by it.

| Call                                                       | What it does                                                                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `runs(db, { state?, name?, version?, parentId?, stuck?, tag?, scope?, rootId?, batchId?, from?, to?, limit?, after? })` | `{ runs, next }`: runs, newest first. Pass `next` as `after` for the next page. It is `null` on the last page. `tag` keeps runs that have that tag; `rootId` keeps the runs below that top run; `batchId` keeps the runs of one `startBatch`; `from` and `to` are `Date`s on the start time (`from` included, `to` not). |
| `batch(db, batchId)`                                       | `{ batchId, total, states, runIds, more }`: how many runs of the batch are in each state (`states.completed`, ...), and their ids, oldest first. `runIds` holds at most `BATCH_LIMIT` (1000) ids; `more` says there are more (several `startBatch` calls gave the same `batchId`): page them with `runs(db, { batchId })`. An unknown batch has `total: 0`. |
| `run(db, id)`                                              | One run with its steps, children, `residual` and unconsumed signals. Untyped: `def.read` is the typed form.                                 |
| `counts(db)`                                               | How many runs per name, version and state.                                                                                                  |
| `stranded(db)`                                             | Unfinished runs whose code is missing or changed.                                                                                           |
| `history(db, id)`                                          | The run's events, oldest first.                                                                                                             |
| `retryStep(db, { runId, path, phase }, op)`                | Runs a dead step again, with the same key. A dead child or map node restarts its failed children. A stranded run retries all its dead jobs. |
| `resolveStep(db, { runId, path, result }, op)`             | Gives the result of a dead `do` step by hand, checked by its `output` schema. The run goes on. Needs a step with `output`.                  |
| `checkResult(db, { runId, path, result })`                 | Says whether `resolveStep` would take `result`. Writes nothing.                                                                             |
| `skipUndo(db, { runId, path }, op)`                        | Gives up a failed undo. `op.reason` is required. The path joins `residual` and compensation goes on.                                        |
| `signal(db, { runId, name, deliveryId, payload }, op)`     | Delivers a signal from JSON, checked by the run's own version.                                                                              |
| `cancel(db, { runId, reason }, op)`                        | Cancels a run of any workflow. A queued run ends `cancelled` at once: nothing ran, so nothing is undone.                                    |
| `setMetadata(db, { runId, change }, op)`                   | Changes the metadata of an unfinished run, like `ctx.metadata`. `change` is `{ kind: 'set', patch }`, `{ kind: 'increment', key, by }`, `{ kind: 'append', key, value }` or `{ kind: 'remove', key }`. Returns `{ metadata }`. |
| `addTags(db, { runId, tags }, op)`                         | Adds tags to an unfinished run, like `ctx.tags.add`. Returns `{ tags }`.                                                                    |
| `replay(db, { runId, overrides? }, op)`                    | Starts a new run of the run's workflow at the newest registered version, under a new id, with the old run's input, `scope`, `tags` and `metadata`; `overrides` replaces any of them and may add `delay` and `ttl`. The old run's `maxAttempts`, `timeout` and `priority` are kept too, unless `overrides` gives others. Works for a finished or an unfinished run. The new run's `replayOf` is the old id and its `RunStarted` carries the operator; the old run is unchanged. Its children are not copied: the new run starts its own. It is a start: the input is checked by the newest input schema (`InvalidInput` when it no longer fits), and the concurrency gate applies (`WorkflowBusy`; with `onBusy: 'join'`, the running run's id). Returns `{ runId }`. `CommandNotFound` for no such run. |
| `reschedule(db, { runId, delay } \| { runId, at }, op)`     | Moves the start of a run whose first node has not started: the first node is due at the new time (`delay` from now, or `at`; a past time is now), and `ttl` and the deadline count from it. One `RunRescheduled` event. Returns `{ startAt }` (ISO). A queued run moves too: it stays queued, and its first node is due at the new time once it is promoted. `CommandConflict` once the first node has started, `CommandNotFound` for no such run. |

`op` is `{ actor, reason?, executionId? }`, as for the job verbs. The run's events record it. A step or timer job belongs to its run: the raw job verbs (`journal.retry`, `discard`, `cancel`) refuse it with `JOB_MANAGED`.

`journal.limits` reads and changes the limits of `concurrency` (§ Concurrency and limits). A name is a `j.limit` name or `workflow/<workflow name>`. An unknown name is `CommandNotFound`. Each verb records `op` on its event and returns the limit after it.

| Call | What it does |
| --- | --- |
| `list(db)` | Every limit the registered workflows hold, by name. Each one: `workflows` (the ones that hold it), `code` (the values in code), `override` (an operator's `total` and `perKey`), `keys` (key overrides that have not expired, each `{ key, perKey, until }`), `effective` (what a start is checked against), `paused`, `running` (the unfinished runs that hold a slot now) and `queued` (the queued runs that wait for one). |
| `get(db, name)` | One limit, as `list` shows it. |
| `override(db, { name, total?, perKey? }, op)` | Replaces the code's `total` or `perKey` until `reset`; at least one, each 0 or more. `CommandInvalid` for a workflow without `concurrency`, or a `perKey` where no start has a key. |
| `override(db, { name, key, perKey, ttl? }, op)` | Sets the `perKey` of one key until `ttl` runs out (default `'7d'`, at most `'30d'`). A `ttl` past 30 days is `InvalidInput`. |
| `reset(db, { name, key? }, op)` | Back to the code values: of one key, or without `key` all the overrides of the limit. The pause stays. |
| `pause(db, { name }, op)` | Admits no new run that holds the limit. Running runs finish. |
| `resume(db, { name }, op)` | Admits runs again. |

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

`journalWorkflowsModule({ journal, db, meta, payload? })` from `@arki/journal/foreman` puts the same reads and verbs in Foreman, with previews and approvals. `meta(permit)` gives the meta of the commands it runs; its `actorId` is written on the run's or limit's events. Each verb has its own permission, so an operator who may tag runs may not replay them or pause a limit:

| Id                                                                                                                                         | Kind   | Permission            | Risk   |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------ | --------------------- | ------ |
| `workflow.runs`, `workflow.run`, `workflow.counts`, `workflow.stranded`, `workflow.history`, `workflow.limits.list`, `workflow.limits.get` | read   | `workflow:read`       | read   |
| `workflow.retryStep`                                                                                                                       | action | `journal:retry`       | low    |
| `workflow.setMetadata`, `workflow.addTags`                                                                                                 | action | `workflow:metadata`   | low    |
| `workflow.signal`                                                                                                                          | action | `workflow:signal`     | medium |
| `workflow.reschedule`                                                                                                                      | action | `workflow:reschedule` | medium |
| `workflow.replay`                                                                                                                          | action | `workflow:replay`     | medium |
| `workflow.resolveStep`, `workflow.skipUndo`                                                                                                | action | `workflow:resolve`    | high   |
| `workflow.cancel`                                                                                                                          | action | `workflow:cancel`     | high   |
| `workflow.limits.pause`, `workflow.limits.resume`, `workflow.limits.override`, `workflow.limits.reset`                                     | action | `workflow:limits`     | high   |

The run reads show `scope`, `tags`, `rootId`, `batchId`, `replayOf`, `startAt`, `delayedUntil`, `ttlAt` and the overrides (`maxAttempts`, `stepTimeoutMs`, `priority`); `metadata` is shown as the `payload` option allows. `workflow.runs` filters by `state` (`queued` and `expired` too), `name`, `version`, `parentId`, `stuck`, `tag`, `scope`, `rootId`, `batchId`, `from` and `to`. A run action's approval is taken on the run's revision: its version less its metadata and tag changes, so `setMetadata` and `addTags` void no approval, not even each other's, while any event that moves the run does. A limit action's approval is taken on the limit's `version` (`LimitView.version`), which only operator changes move; runs that take or free a slot do not. `workflow.replay` also takes a finished run. Its refusals are `JOURNAL_WORKFLOWS_ERROR_CODES`, `ARKI_JOURNAL_E010` to `E017` (a stale limit approval is `E010` too). The newer verbs answer the journal's own refusals with their codes and statuses: `journal.not_found` (an unknown limit), `journal.invalid` (too many tags, an override of a limit that caps nothing), `journal.conflict` (a reschedule of a run that has started) and `journal.workflow_busy` (a replay at a busy key, with its `limitName` and `reason`).

### Wait for an event

A signal comes from outside the app. An event wait is for the app's own events: it parks the run until an entity records one, with no effect in between. A process waits for `PaymentSettled` the way a person waits for a reply.

```ts
import { integer, pgTable, varchar } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { initJournal } from '@arki/journal';
import { journalTables } from '@arki/journal/pg';

type PrayerId = `pry_${string}`;
const prayers = pgTable('prayers', {
  id: varchar('id', { length: 256 }).primaryKey().$type<PrayerId>(),
  version: integer('version').notNull().default(0),
});
const j = initJournal({ tables: journalTables(), meta: z.object({ actorId: z.string() }) });

const PrayerReminderSet = j.event('PrayerReminderSet', z.object({ everyHours: z.int().positive() }));
const PrayerAnswered = j.event('PrayerAnswered', z.object({ how: z.string() }));
const prayer = j
  .entity('prayer', prayers)
  .create(PrayerReminderSet, () => ({}))
  .on(PrayerReminderSet, () => ({}))
  .on(PrayerAnswered, () => ({}));

export const reminder = j
  .workflow('prayer-reminder', {
    version: 1,
    input: z.object({ prayerId: z.templateLiteral(['pry_', z.string()]), everyHours: z.int().positive() }),
    startOn: {
      entity: prayer,
      event: PrayerReminderSet,
      id: e => `reminder:${e.entityId}:${e.seq}`,
      input: e => ({ prayerId: e.entityId, everyHours: e.data.everyHours }),
      timing: 'with-event',
    },
  })
  .step('due', ({ input }) => ({ at: new Date(Date.now() + input.everyHours * 3_600_000).toISOString() }))
  // Sleeps until the reminder is due, and any of these events cuts the sleep short.
  .waitFor('stop', {
    on: {
      prayer: {
        entity: prayer,
        events: [PrayerAnswered, PrayerReminderSet],
        match: ({ input }) => input.prayerId,
      },
    },
    until: ({ results }) => new Date(results.due.at),
    onTimeout: 'continue',
  })
  // `when` skips the push once an event stopped the wait, and a skipped step ignores `next`, so the run ends.
  .step('remind', ({ key }) => key, { when: ({ results }) => results.stop === null, next: 'due' })
  .finish(({ results }) => {
    if (results.stop === null) return 'no reminder left';
    // `via` names the label, and `event.type` narrows `data`.
    return results.stop.event.type === 'PrayerAnswered' ? results.stop.event.data.how : 'replaced';
  });
```

- `on` has one label per thing to watch. `entity` and `events` must belong together, and `match` must return that entity's id type: both are compile errors otherwise, and `workflow()` throws `BAD_DEFINITION` for a caller who skips the types. `match` runs once per visit, when the run gets to the wait.
- `where: ({ input, results, event }) => boolean` on a label passes over the events it refuses. It must decide from its arguments alone: it runs again on every read of the log.
- The result is `{ via: label, event }`, a union with one member per label. `event` is the recorded event, typed by the entity and the listed events, decoded as a job's event is, so its upcasters apply. `def.read` gives the same type, and checks the stored value with the event's schema.
- `timeout` is an age and `until` a function that gives a `Date`. Give one or neither. `onTimeout: 'fail'` (the default) fails the node. `onTimeout: 'continue'` goes on with `null`, which is how a wait doubles as a sleep that an event cuts short. `when` works as on a step.
- An entity must keep its events in `journal_events`, because a wait reads them there. A wait on a `'transient'` entity, or one with its own event log, throws `BAD_DEFINITION`.

**Which events count.** A wait counts every event since the run was admitted: after the event that started it for a `startOn`, after `RunStarted` for a direct start. So an event recorded before the worker reaches the wait is kept, and the run takes it on arrival without parking. A wait takes the oldest event it finds. A later visit in a `next` loop reads on from the last event that wait took, and a deadline moves nothing, so an event recorded between two rounds of a loop is there for the next round. One event is taken once per run, as a signal is: a second wait for the same type needs a second event.

**No wake-up is lost.** A parked wait writes one row per label in `workflow_waits`. Composing adds the effect `workflow.wake:<entity kind>`, with a job for every recorded event of a watched type, and the app writes none of this. A park takes a lock on the key `(entity kind, entity id)`, reads the log, and writes its row; the wake takes the same lock, then reads the rows. Whichever commits second sees the other. The rows are indexed by that key, so a wake never scans the running runs. Retention keeps what a wait needs: the sweeper never touches `journal_events` or a run that has not ended, and a run's rows go with the run.

**One winner.** A deadline and an event contend on the run's row, so one moves the run and the other finds it moved. An event that committed before the timer ran wins, even with its wake job still queued. A repeat of a wake job finds the event taken. `WaitEventTaken` on the run records each one, with the event's id as `deliveryId`.

**Costs.** Each recorded event of a watched type queues one job, whether or not a run waits for it. A changed `on` changes the shape hash, so it needs a new `version`.

**No copy of the event.** The node's result is stored as a pointer, `{ via, seq }`, and the event is read from `journal_events` when a body, `def.read` or an operator view asks for it. So `forget` on the entity reaches every run that took its events: an event with an erased form reads in that form in a parked run, a running run and a finished one, and no `workflow_runs`, `workflow_steps` or run event row holds the original. A run keeps going after its event is erased and reads the erased form from then on. What a body derives from the event (a step result, the output) is the workflow's own data, and `forget` does not rewrite it: derive nothing personal, or give that step its own retention.

### Stop a loop with `limits.transitions`

A `next` loop can run for as long as its condition holds, so every workflow has a cap: `limits: { transitions }`, 1000 by default. A **transition** is the first try of a node. Each visit of a node in a loop is one, and so is a node its `when` skips. A retry of a step and an undo are not. The run counts them in `workflow_runs.transitions`, written by the same event that schedules the node, so the count survives a crash and a restart.

A node that would be transition `transitions + 1` does not run. The run compensates, as it does for a deadline, and ends `failed` with `WorkflowTransitionLimit` as its error (`journal.workflow_transition_limit`, with `data.limit` and `data.transitions`). This holds whatever `onDeadStep` says: a loop that must stop does not wait for an operator. The stopped node's body never runs, so no work is done and lost. `transitions` on the stopped run is `limit + 1`: it counts the node that was refused.

Size the cap from the loop. A loop of `spin` then `rest` for `n` rounds makes `2n` transitions, plus the nodes before and after it. A reminder that goes round once a day for years needs `rounds * nodes in the loop`, and the prayer reminder above sets `limits: { transitions: 50_000 }` for that reason. A cap that is too low fails a healthy run, and one that is too high lets a bug loop for long. A run is checked against the cap in the code that runs it, so raising the cap in code lets the runs that are still open go on. A run that already ended `failed` stays failed.

### Start on an event

`startOn: { entity, event, timing, id, input }` starts a run when `entity` records `event`. `id` gives the run id and `input` the run's input, both from the recorded event: `e.entityId` has the entity's key type, `e.data` the event's data, and `input` must return the workflow's input, or it does not compile. Composing adds one effect for it, `workflow.start:<workflow name>`.

- `timing` is required. `'after-commit'`: a job written with the event starts the run after the commit. `'with-event'`: the run itself is written with the event.
- The job is written in the transaction that records the event, so the run starts once, even when that command is retried.
- The run starts with the app's `workflowMeta`, at the highest registered version, like `def.start`.
- An id that already has a run, whatever its input or version, starts nothing. The job ends done, not dead.
- Only the highest registered version may declare `startOn`. A lower one with `startOn` makes `compose` throw `BAD_DEFINITION`.

`timing: 'with-event'` writes `RunStarted`, the first scheduled node and its job in the event's transaction, through the same write path as inline projections. No body runs inline: the job runs after the commit, as always. What it changes is the moment the run exists. A rollback of the command removes the run, and a read after the commit finds it.

- A paused limit, or a join with nothing to join, queues the run. It never refuses, because the caller of the event has nobody to hand a refusal to. So `concurrency.onBusy: 'refuse'` with `'with-event'` is a type error, and `workflow()` throws `BAD_DEFINITION`.
- An input that fails the workflow's schema refuses the write with the schema's failure. An input over the payload limit is a bug in the mapping: it throws, and the transaction rolls back.

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
      timing: 'after-commit',
      id: e => `welcome:${e.entityId}`, // the order id: one run per order
      input: e => ({ orderId: e.entityId, total: e.data.total }),
    },
  })
  .step('thank', ({ input }) => `thanks for ${input.total}`)
  .finish();

const placeOrder = j.command(
  'orders.place',
  z.object({ id: z.string(), total: z.int().positive() }),
  { writes: [OrderPlaced] },
  (input, { write }) => write(order, input.id, () => [OrderPlaced({ total: input.total })]),
);

const journal = j.compose({ workflows: [welcome], workflowMeta: { actorId: 'system:workflow' } });
const { db, client } = await openJournalDb({ ...tables, orders });

orThrow(await journal.run(db, placeOrder, { id: 'ord_1', total: 500 }, { actorId: 'usr_ada' }));
await journal.drain(db); // workflow.start:orders.welcome starts the run
await journal.drain(db); // thank

const thanked = orThrow(await welcome.read(db, 'welcome:ord_1'));
if (thanked?.run.output !== 'thanks for 500') throw new Error('the order started the run');
await client.close();
```

### Command nodes

A step runs at least once: a crash after its `run` and before its checkpoint runs the body, and the command, again. A command node has no body. The command runs as a savepoint inside the checkpoint's transaction, so the command's writes, the checkpoint and the next node's job commit together. A crash leaves all of them or none, and a job that runs again finds the node settled. Exactly once per node, on one condition: everything the command does is a write in that transaction. A command that calls a provider belongs in a step.

```ts run
import { integer, pgTable, varchar } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { defineFailure, isFailure, orThrow } from '@arki/failure';
import { initJournal } from '@arki/journal';
import { journalTables } from '@arki/journal/pg';
import { openJournalDb } from '@arki/journal/testing';

const tables = journalTables();
const j = initJournal({ tables, meta: z.object({ actorId: z.string() }) });

const orders = pgTable('orders', {
  id: varchar('id', { length: 64 }).primaryKey(),
  held: integer('held').notNull(),
  version: integer('version').notNull().default(0),
});
const FundsHeld = j.event('FundsHeld', z.object({ amount: z.int() }));
const FundsReleased = j.event('FundsReleased', z.object({}));
const order = j
  .entity('order', orders)
  .create(FundsHeld, e => ({ held: e.data.amount }))
  .on(FundsReleased, () => ({ held: 0 }));
const OverLimit = defineFailure('orders.over_limit', { status: 402, data: z.object({ limit: z.int() }) });

const hold = j.command(
  'orders.hold',
  z.object({ orderId: z.string(), amount: z.int() }),
  // `output` is what the run stores. The node's `results.hold` comes from it.
  { writes: [FundsHeld], output: z.object({ orderId: z.string() }) },
  async (input, { write }) => {
    if (input.amount > 100) return OverLimit({ limit: 100 });
    const held = await write(order, input.orderId, () => [FundsHeld({ amount: input.amount })]);
    return isFailure(held) ? held : { orderId: input.orderId };
  },
);
const release = j.command(
  'orders.release',
  z.object({ orderId: z.string() }),
  { writes: [FundsReleased] },
  (input, { write }) => write(order, input.orderId, () => [FundsReleased({})]),
);

export const checkout = j
  .workflow('orders.checkout', { version: 1, input: z.object({ orderId: z.string(), amount: z.int() }) })
  .command('hold', hold, ({ input }) => input, {
    accept: [OverLimit],
    undo: { command: release, input: ({ result }) => ({ orderId: result.orderId }) },
  })
  .step('tell', ({ results }) => (OverLimit.is(results.hold) ? `limit ${results.hold.data.limit}` : 'held'))
  .finish();

const journal = j.compose({ workflows: [checkout], workflowMeta: { actorId: 'system:workflow' } });
const { db, client } = await openJournalDb({ ...tables, orders });
const operator = { actorId: 'usr_ada' };

orThrow(await journal.run(db, checkout.start, { id: 'co_1', input: { orderId: 'ord_1', amount: 500 } }, operator));
await journal.drain(db); // the command is refused: its savepoint rolls back, the failure is the node's result
await journal.drain(db); // tell

const over = orThrow(await checkout.read(db, 'co_1'));
if (over?.run.output !== 'limit 100') throw new Error('the refusal is a real failure for later nodes');
await client.close();
```

- The input function, `when` and `undo.input` get plain data: `{ runId, key, input, results }`. They run no command and read no database, so the node stays one command.
- The result is what the command's `output` schema gives: `j.command(name, input, { writes, output }, handler)`. A command with no `output` stores `null`. The schema must fit what the handler returns: another schema does not compile. A result that fails the schema, or does not survive JSON, rolls the command back and fails the attempt.
- A refused command rolls back its savepoint, and the node's failure still commits. The node then fails like a step that returned a failure: `retry` with a `while` that accepts it tries again, and without one the step is dead, so `onDeadStep` decides (`'compensate'` fails the run, `'wait'` leaves it for an operator).
- `accept: [OverLimit]` names failures the run goes on from. Only failures the command returns compile. The savepoint stays rolled back and the failure is the node's result, so `results.x` and `def.read` have the type `Output | ReturnType<typeof OverLimit>`. The stored JSON is checked: a code no definition in `accept` knows reads as `WorkflowReadMismatch`.
- A last node with `accept` needs a function in `.finish`: a run's output is never a failure. `.finish()` without one does not compile (a definition built past the types throws `BAD_DEFINITION`).
- `undo: { command, input }` runs in compensation, in reverse order, exactly once, the same way. `input` also gets `result`, the stored result. A node that ended in an accepted failure did nothing, so its undo is skipped.
- `when` skips the node: the command does not run and the result is `null`. `retry` works as on a step. There is no `timeout`: a transaction is not the place to wait.
- The shape stores the kind `command` and the command names, so changing a node's command is a new shape. Bump the version.
- The input function's return gets no help from the command's type for literals, the same as `.child`. Write `kind: 'card' as const` for a field that takes a union of strings.

### Continue on a step's failure

A step that returns a failure is dead at once and follows `onDeadStep`. When a failure is a normal answer, such as a declined card, list it and the run goes on from it:

- `failures: [Declined]` lists the failure definitions the step may return. `onFailure: 'continue'` makes a listed failure the step's result. Any other returned failure still fails the step.
- The result type is the step's `output` plus the listed failures, so `Declined.is(results.card)` narrows it. The failure is stored as its own envelope (`serialize`) and read back with its own `dataSchema` (`revive`), also by `def.read`. A code the list no longer names reads as `WorkflowReadMismatch`.
- `onFailure: 'continue'` needs an `output` schema, so the stored result can be checked on read. A definition with `onFailure` and no `failures`, `failures` and no `onFailure`, or no `output` throws `BAD_DEFINITION` when it is built. The list is not tied to the body's return type.
- A continued failure did nothing to undo, so the step's `undo` is skipped for it, as for a command's accepted failure.
- A run's output is never a failure. A last node that can be a failure (a command with `accept`, a step with `onFailure: 'continue'`) needs a function in `.finish`, and `.finish()` without one does not compile. The definition still throws `BAD_DEFINITION` for an erased caller.

### Get an outcome: `settled` and `startAndWait`

A caller that must answer with the result, such as a request, can wait for a run. Both forms need the root database (a transaction handle is a type error and throws `BAD_ARGUMENT`), and neither ever cancels the run. A caller should normally take the run id; a bounded wait is a convenience.

- `def.settled(db, runId, { within })` returns the run, typed as `def.read` types it, once it has ended (`completed`, `failed`, `cancelled` or `expired`). If `within` passes first it returns the failure `WorkflowPending { runId }`. A run that does not exist, or belongs to another workflow, is `CommandNotFound`.
- `def.startAndWait(db, args, { meta, timeout, signal })` starts the run with `start`, then waits. It returns the output (`null` for a run with no output; `unknown` when the workflow declares no `output` schema, because nothing checks it), or `WorkflowRunFailed { runId, state, error }` for a run that ended `failed` or `expired`, `WorkflowRunCancelled { runId, reason }`, or `WorkflowPending { runId }` on a timeout or when `signal` aborts. A refusal of `start` or of the read comes back as it is.
- `within` and `timeout` are seconds, above 0 and at most 30 (`SETTLE_LIMIT_SECONDS`). A missing, zero or longer value throws `BAD_ARGUMENT`: a wait that long is a job, so take the run id.
- It polls the run, from a 10 ms pause growing to 250 ms. Nothing here wakes a worker: run one (`journal.worker`, or `drain` in a test).
- `startAndWait` needs the workflow in `compose({ workflows })`, which gives it the journal to start with. Otherwise it throws `WORKFLOW_UNKNOWN`.

```ts run
import { z } from 'zod';

import { defineFailure, isFailure, orThrow } from '@arki/failure';
import { initJournal, WorkflowPending, WorkflowRunFailed } from '@arki/journal';
import { journalTables } from '@arki/journal/pg';
import { openJournalDb } from '@arki/journal/testing';

const tables = journalTables();
const j = initJournal({ tables, meta: z.object({ actorId: z.string() }) });
const Declined = defineFailure('pay.declined', { status: 402, data: z.object({ reason: z.string() }) });

export const charge = j
  .workflow('pay.charge', { version: 1, input: z.object({ amount: z.int() }), output: z.string() })
  .step('card', ({ input }) => (input.amount > 100 ? Declined({ reason: 'over the limit' }) : { chargeId: 'ch_1' }), {
    output: z.object({ chargeId: z.string() }),
    failures: [Declined],
    onFailure: 'continue',
  })
  .finish(({ results }) => (Declined.is(results.card) ? `declined: ${results.card.data.reason}` : results.card.chargeId));

const journal = j.compose({ workflows: [charge], workflowMeta: { actorId: 'system:workflow' } });
const { db, client } = await openJournalDb(tables);
const caller = { actorId: 'usr_ada' };

// A worker, as an app runs one. In a test `journal.drain` does the same.
let working = true;
const worker = (async () => {
  while (working) {
    orThrow(await journal.drain(db));
    await new Promise(resolve => setTimeout(resolve, 5));
  }
})();

const answer = await charge.startAndWait(db, { input: { amount: 500 } }, { meta: caller, timeout: 5 });
if (answer !== 'declined: over the limit') throw new Error('the declined card is the run\'s answer, not a failure');

const started = orThrow(await journal.run(db, charge.start, { input: { amount: 20 } }, caller));
const settled = await charge.settled(db, started.runId, { within: 5 });
if (isFailure(settled)) throw new Error(`not settled: ${settled.code}`);
if (settled.run.output !== 'ch_1') throw new Error('the typed run carries the output');

working = false;
await worker;
await client.close();
void WorkflowPending;
void WorkflowRunFailed;
```

### Concurrency and limits

`concurrency: { key, limit, onBusy }` on the workflow caps how many unfinished runs share one key, such as one sync per account. `key` gets the parsed input and returns a string of 1 to 256 characters. A parked run counts: it still holds its slot until it ends.

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
const sync = j
  .workflow('accounts.sync', {
    version: 1,
    input: z.object({ accountId: z.string() }),
    concurrency: { key: ({ accountId }) => accountId, limit: 1, onBusy: 'refuse' },
  })
  .step('pull', ({ input }) => pull(input.accountId))
  .finish();
```

- At the limit, `onBusy: 'refuse'` returns `WorkflowBusy` (`journal.workflow_busy`, status 409). Its data names the key, the limit and the running run ids of the caller's own `scope`, oldest first. No run is created.
- At the limit, `onBusy: 'join'` returns the oldest running run of the caller's own `scope` instead of a new one, so the caller follows the run already under way. With none in its scope, the start is `WorkflowBusy`.
- At the limit, `onBusy: 'queue'` creates the run all the same, in the state `queued`, and returns its `{ runId }`. Its events are `RunStarted` and `RunQueued` (which names the busy limit and `reason`). No node is scheduled and no job exists for it, so it does no work and holds no slot: no limit counts a queued run. Below, § Queued runs.
- The limit counts every run with the key, whatever its scope, so a key can cap work across tenants. What a start gets back never crosses its scope: the key comes from input, and two tenants can share one.
- The same start again (same `id`, same input) is the same run, never a busy key.
- A child run (`child`, `map`) is never joined: the run it would join reports to another parent. A busy child is `WorkflowBusy`, and its parent's node fails like any child that cannot start. A child of a workflow with `onBusy: 'queue'` queues instead, and its parent stays parked until it is promoted and ends.
- A `startOn` start that is busy and refused leaves its job dead with `WorkflowBusy`.
- The check runs inside the start's transaction, under a transaction-scoped advisory lock on the workflow name and the key. Two starts of one key on two connections take turns, so a race never overfills a key.

`concurrency` takes more limits than one per key. A start is admitted only when every limit it holds has room.

- `limit` caps the unfinished runs per `key` (it needs `key`), and `total` caps all unfinished runs of the workflow, whatever the key. Together they are the workflow's own limit, named `workflow/<workflow name>`.
- `shared` lists at most two limits made with `j.limit({ name, total?, perKey? })`. Each one counts every unfinished run that holds it, across all the workflows that list it. Its `perKey` counts the runs with this start's `key`, so a workflow that lists a limit with `perKey` needs a `key`.
- `onBusy: 'join'` joins only when the workflow's own `limit` is full: it answers the oldest run of the same workflow, key and scope. A full `total` or shared limit is `WorkflowBusy`.
- `onBusy: 'queue'` queues on any limit that blocks the start: full or paused, its own or a shared one.
- `WorkflowBusy` data also names the limit (`limitName`) and why (`reason`, one of `LIMIT_BUSY_REASONS`: `'full'` or `'paused'`). `limit` is the count that is reached, and `key` is `null` for a start without a key (only a `total` limit can block one).
- Every limit name a definition uses is known once it is composed: no separate registration. Two `j.limit`s with one name and other values make `compose` throw `BAD_DEFINITION`.
- Each limit has its own lock. A start takes it shared, then an exclusive lock per count it makes (`total`, or `perKey` of its key), in one sorted order. So two starts that count the same thing take turns, and starts of other keys do not wait.

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
// Three uploads at a time in all, and one per account, whichever workflow starts them.
const uploads = j.limit({ name: 'uploads', total: 3, perKey: 1 });

const importCsv = j
  .workflow('imports.csv', {
    version: 1,
    input: z.object({ accountId: z.string() }),
    concurrency: { key: ({ accountId }) => accountId, total: 10, shared: [uploads], onBusy: 'refuse' },
  })
  .step('load', ({ input }) => load(input.accountId))
  .finish();
```

An operator changes a limit at runtime with `journal.limits` (§ Operators), without a deploy. The change is stored in `journal_limits` with an event on the `journal.limit` entity that names the operator.

- `override(db, { name, total?, perKey? }, op)` replaces the code values until `reset`. `override(db, { name, key, perKey, ttl? }, op)` sets the `perKey` of one key, for `ttl` (`LIMIT_KEY_TTL`: 7 days by default, at most 30 days). An expired key override is ignored. `0` admits no run, so `perKey: 0` on a key blocks it.
- `pause(db, { name }, op)` admits no new run of any workflow that holds the limit: `WorkflowBusy` with `reason: 'paused'`, and no join (a workflow with `onBusy: 'queue'` queues the run). Runs that already hold it go on to their end. `resume` admits runs again. Pausing `workflow/<name>` stops one workflow, also one without `concurrency`: such a start reads only its pause, one primary-key lookup that finds nothing when no operator changed the limit.
- A verb takes the limit's lock exclusive, so it waits for the starts that are reading the limit. Once it returns, every new start sees the change.

#### Queued runs

A queued run waits for a slot. It starts (is promoted) when a slot can free, in the same transaction as the change that freed it:

- a run that held one of its limits ends (`completed`, `failed`, `cancelled` or `expired`): first the queued runs of that run's key, then any that hold one of its limits;
- an operator raises or resets an override, or resumes the limit (`journal.limits`, below): the queued runs of that limit;
- a key override runs out: it has no event of its own, so each `LimitKeyOverridden` queues a `workflow.limitTimer` job at its `until`, which looks at the queued runs of the limit then.

Promotion checks every limit of the candidate with the same gate and locks a start uses. The oldest queued run goes first (by when it was queued, then id). A candidate that still does not fit stays queued, and so do the later ones that the same busy limit blocks (of the same key, for a `perKey`): runs of one key start in the order they queued, and another key does not wait behind them. Each promotion checks at most `LIMIT_BOUNDS.promoteTries` (50) candidates; the rest wait for the next run end or operator change. So a run blocked only by a `total` can wait for several later changes when more than 50 older queued runs are blocked on other keys. Promotion never waits for a lock: a candidate that needs a limit lock another transaction holds (one the change has not taken already) stays queued for a later change, so a run end and a start never wait on each other in opposite orders. A promoted run gets `RunDequeued` and its first `NodeScheduled`, due at its `delay` start (`start_at`) when that is still ahead, else now.

- A queued run's `ttl` counts from when it was due, as for any run. If it is still queued at `ttl_at`, its `workflow.timer` job ends it `expired` (`RunExpired`, with no node skipped: it never had one). Promotion skips a run past its `ttl_at`.
- A deadline counts from when the run was due too: a queued run past it fails, like any run.
- `cancel` ends a queued run `cancelled` at once (`CancelRequested`, `RunCancelled`): nothing ran, so nothing is undone. It frees nothing.
- `reschedule` moves a queued run's `start_at` (and its `ttl_at` and deadline, which count from it). It stays queued; once promoted, its first node is due at the new time.
- `replay` is a start: through the gate, so it may queue.
- `journal.limits.get` and `list` show `queued`, the queued runs that hold the limit, next to `running`.

### Lifecycle hooks

`on: { success, failure, cancel, expired, complete }` on a workflow's options (or a task's) says what runs when a run ends. Each hook gets the run that ended (`runId`, `workflow`, `version`, `scope`, `tags`, `metadata`, the typed `input`, and `state`), the context of its job (`db`, `run`, `accept`, `signal`, `jobId`, `attempt`), and the definition's needs by name, as a step does. `success` also gets `output`: the `output` schema's output, checked again as `def.read` checks it, or `unknown` without a schema. `failure` gets `error`, the text of the run's error. `complete` runs for every end, after the specific hook, or alone; `ctx.state` says which end it was.

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
const charge = j.task(
  'billing.charge',
  {
    version: 1,
    input: z.object({ orderId: z.string() }),
    output: z.object({ receiptId: z.string() }),
    needs: { mailer: need<Mailer>() },
    on: {
      success: ({ input, output, mailer }) => mailer.receipt(input.orderId, output.receiptId),
      failure: ({ input, error, run }) => run(markUnpaid, { orderId: input.orderId, reason: error }),
      complete: ({ runId, state }) => log.debug('charge %s ended %s', runId, state),
    },
  },
  ({ input, key }) => payments.charge(input.orderId, { idempotencyKey: key }),
);
```

Hooks are durable, not callbacks:

- Composing adds one effect, `workflow.on`, when at least one definition declares `on`. A run end queues one job of it, in the transaction that ends the run. So a hook runs only after that commit: an end whose transaction rolls back runs nothing.
- The job calls the hooks of the run's own version, even after a newer version is deployed. A stranded run (its version is not registered) has a dead hook job, retried by an operator once the code is back.
- A hook runs at least once. A throw is retried as an effect's is (8 tries, 1 s up to 5 min), and a retry runs the specific hook again before `complete`. A returned failure is final: the job is dead. Make a hook idempotent, with `ctx.jobId` as the key of what it sends.
- The run has ended: a hook never changes its state, and `ctx.metadata` is the metadata as it ended. `ctx.run(command, input)` without a meta records the app's `workflowMeta`, as in a step.
- The end events do not name the workflow, so the job is queued for every run end of a compose with hooks; a run whose definition has no hook for that end ends its job as done. A compose with no `on` at all queues nothing.

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

Defaults: `completed` 7 days, `failed` 90 days, `cancelled` and `expired` the same as `failed`. `'untilExported'` and `max` are refused: a run has no sink. A completed child whose parent has not finished is kept, because the parent may still undo it.

### Workflows in Dot

A feature lists its workflows with `journalHandlers(core, { workflows })` in `.usecases(...)`, with its effects and taps. The app passes `workflowMeta` to `journal({ j, workflowMeta })`. A workflow picks its deps from the feature with `needsOf((_: Deps) => ['payments'])`. A step gets the services of the feature that lists its workflow. A dep the feature lacks does not compile. Each workflow is an action in the manifest: `<name>@<version>.run`, with its signals in the meta.

```ts
import { z } from 'zod';

import { defineApp } from '@arki/dot';
import type { DepsOf } from '@arki/dot/feature';
import { defineFeature } from '@arki/dot/feature';
import { infra } from '@arki/dot/unit';
import { initJournal } from '@arki/journal';
import { journal, journalHandlers, journalWorker, needsOf } from '@arki/journal/dot';
import { journalTables } from '@arki/journal/pg';
import { openJournalDb } from '@arki/journal/testing';

type Payments = { refund(paymentId: string, idempotencyKey: string): Promise<{ refundId: string }> };

const tables = journalTables();
const j = initJournal({ tables, meta: z.object({ actorId: z.string() }) });

const { db } = await openJournalDb(tables); // the app's root database
const stripe = infra({
  name: 'stripe',
  provides: {
    payments: (): Payments => ({ refund: async (paymentId, key) => ({ refundId: `re_${paymentId}_${key}` }) }),
  },
});

// The feature declares what its workflows may use, in the core.
const core = defineFeature('refunds').needs({ payments: stripe.provides.payments });

const refund = j
  .workflow('payments.refund', {
    version: 1,
    input: z.object({ paymentId: z.string() }),
    needs: needsOf((_: DepsOf<typeof core>) => ['payments']),
  })
  .step('payBack', ({ input, key, payments }) => payments.refund(input.paymentId, key))
  .finish();

export const refunds = core.usecases({}, journalHandlers(core, { workflows: [refund] })).entrypoints();

export const app = defineApp('shop')
  .infra(infra({ name: 'db', provides: { db: () => db } }))
  .infra(stripe)
  .infra(journal({ j, workflowMeta: { actorId: 'system:workflow' } }))
  .features([refunds])
  .entrypoints(journalWorker());
```

`journalWorker()` runs the workflow jobs like any effect. A feature has one `journal` contribution, so it lists its effects, taps and workflows in one `journalHandlers` call.

### Testing

`workflowHarness({ setup })` from `@arki/journal/testing` gives a test an in-memory database and control of time, jobs and crashes. `workflowHarnessOn(db, { setup })` does the same on a database the test opened, such as a real Postgres with two pools for a race: the schema is the test's to push, and `close()` leaves it open. `setup` builds the runtime: `initJournal`, the definitions and the compose. It returns `tables`, `journal` and the definitions the test uses. The harness adds:

- `tick(age)` moves time forward by shifting the stored due times back. Now stays now, so a body that reads `Date.now()` and a query that reads `now()` keep agreeing.
- `tickTo(at)` moves time forward to `at`, read from a row `tick` moves, such as a run's `wakeAt`.
- `drain()` runs jobs until none is due.
- `dueJobs()` lists what a worker could claim now, in claim order. `release(job => boolean)` runs the first job the function picks and no other, so a test can put an event, a wake and a timer in the order it wants to see.
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
    { actorId: 'usr_ada' },
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

`@arki/journal/dot` connects the journal to an `@arki/dot` app. It exports two adapters, one infra unit for projections and one application contribution. `@arki/dot` is an optional peer. The core entry never imports it.

- `journal(...)`: the infra part, for `.infra()`. It publishes `services.journal`, so features can write through it.
- `journalWorker(...)`: the only entrypoint, for `.entrypoints()`. It runs effects, taps and async projections between `start` and `stop`. With `jobs` it also runs queue rows.
- `journalProjections(...)`: a feature's projections, for its `.infra(...)`.
- `journalHandlers(core, { effects, taps, workflows })`: a feature's reactions, for its `.usecases(factories, …)`. An effect is application code, not an entrypoint.
- `needsOf((_: Deps) => ['mailer'])`: the deps an effect, tap or workflow picks from its feature, typed from the selector's parameter.

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

**Dot app.** Each feature lists its own projections with `journalProjections` and its own reactions with `journalHandlers`. The app lists its features once, in `.features([...])`. Both adapters read that list. There is no root file.

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
// src/features/orders/feature.ts
export const core = defineFeature('orders')
  .needs({ mailer: mailerInfra.provides.mailer }) // typed handle; service<Mailer>() also works
  .infra(journalProjections(customerStats));
export const orders = core.usecases({}, journalHandlers(core, { effects: [orderMail(core)] })).entrypoints();

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

- `journal(...)` boots before the features. It reads their `journalProjections` and `journalHandlers` declarations, not their booted services, so a feature can `need` the journal and write through it, even in its own `boot`.
- `journal({ j })` has typed handles before any app is built. Name the journal once, `const appJournal = journal({ j })`, mount it with `.infra(appJournal)`, and need it by handle: `.needs({ journal: entrypointOnly(appJournal.provides.journal) })`. `Provided<typeof appJournal.provides.journal>` is the composed journal's type.
- This works because a write never needs an effect's services. A write runs the inline projections, which get only the transaction, and queues each effect's job. The journal is composed with `services: 'worker'`. `journalWorker()` gives each effect and tap its services when it runs it.
- `journal(...)` needs the root database under the `db` key. A transaction there is a compile error.
- `journalWorker()` starts one worker on `start` and stops it on `stop`. Each app that mounts it gets its own worker, also when two apps share one `journalWorker()` value. Options: `pollMs`, `batchSize`, `leaseSeconds`, `listen`, `taps`, `jobs`. `jobs` is a `JobsSource`: it names the services the runner needs and builds a `JobRunner` once the features have booted. `@arki/queue/dot` ships one, `outboxJobs({ needs, context })`. A `jobs` source adds a `<job>.consume` action per job to the worker's manifest, under the unit `journal-worker`. A process that serves no worker still writes. Its jobs wait for a process that serves one.
- An effect picks its deps with `needsOf((_: Deps) => keys)`: a need that is not `entrypointOnly`, a private infra service or a domain service of the feature that lists it. A dep the feature lacks is a compile error. A missing service fails that feature's boot, and the message names it.
- Two features may use the same need name for two different services. Each effect gets the service of its own feature.
- Every effect is an action in the app manifest (`binding: 'journal'`, id `<name>.run`). Projections are never listed: they run inside the write.
- Two features with the same projection, effect, tap or workflow name fail the boot. The message names the duplicate and both features.
- A feature without `journalHandlers` adds nothing. That is allowed.
- An app that composed its journal itself passes it: `journal({ journal })`. Serve `journalWorker()` if it has effects, taps or async projections. Feature declarations are not read in this mode.
- A second journal uses Dot's `rename`: `rename(journal({ journal: reports }), { journal: 'reportsJournal' }, 'reports-journal')`.
- A task or a workflow step runs a command with `ctx.run` in both modes. It needs no closure over the journal.

### A `defineFeature` feature

A feature declares its handlers by layer. The journal reads them from the feature value before anything boots and folds them into one declaration per feature, so `journal(...)` and `journalWorker()` work as above.

Application code is organised by business behaviour. A behaviour file in `usecases/` holds the decision (the command) and the reactions it owns:

```text
orders/
  model/order.ts             event schemas, the entity and its fold
  usecases/place-order.ts    placeOrder (the command) and sendReceipt (its effect)
  infra/placed-count.ts      the read-model projection
  entrypoints/procedures.ts  transport: context.run(placeOrder, input)
  feature.ts
```

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
// usecases/place-order.ts
export const placeOrder = j.command('orders.place', placeOrderInput, { writes: [OrderPlaced] }, async (input, { write }) => {
  const written = await write(order, input.id, () => [OrderPlaced({ customerId: input.customerId, total: input.total })]);
  return isFailure(written) ? written : { id: input.id };
});

// reactions/send-receipt.ts — `import type { Deps }` only, so there is no import cycle.
import type { Deps } from '../feature';

export const sendReceipt = j.effect('send-receipt', order, needsOf((_: Deps) => ['mailer']), {
  OrderPlaced: (event, { mailer, signal }) =>
    mailer.sendReceipt({ orderId: event.entityId, idempotencyKey: `receipt:${event.id}`, signal }),
});

// entrypoints/procedures.ts — a procedure runs a command; no command list.
export const procedures = (impl: typeof rpcImplementer) => ({
  place: impl.place.use(asActor).handler(({ context, input, errors }) => orThrowCommand(context.run(placeOrder, input), errors)),
});

// feature.ts
export const core = defineFeature('orders')
  .needs({
    db: entrypointOnly(database.provides.db),
    journal: entrypointOnly(appJournal.provides.journal),
  })
  .infra(mailer, journalProjections(placedCount)); // projections keep read models: infra

export type Deps = DepsOf<typeof core>; // the stage before `.usecases()`: what a reaction may ask for

const logic = core.usecases({}, journalHandlers(core, { effects: [sendReceipt] }));
export const rpcImplementer = implement(ordersRpcContract).with(logic);
export const orders = logic.entrypoints(rpc(ordersRpcContract, rpcImplementer, procedures));
```

- `journalProjections(...projections)` is an infra unit that boots nothing; its unit is `<feature>/journal-projections`.
- `journalHandlers(core, { effects, taps, workflows })` is an application contribution, the second argument of `.usecases(factories, …)`. It binds once, at the feature's boot, to what a usecase sees: the needs that are not `entrypointOnly`, the private infra and the domain services. It is never a `context.usecases` member, so a procedure cannot call an effect.
- `needsOf((_: Deps) => ['mailer'])` picks the deps. Its types come from the selector's annotation, with no type arguments. `needsOf` calls the selector once to read the keys and never reads its argument. An `entrypointOnly` key or a key the feature lacks is a compile error. A key missing at runtime fails the feature's boot and names the key.
- A reaction file is a plain exported value: `export const sendReceipt = j.effect(…)`. It imports `Deps` as a type only, so the feature may import it in either order.
- A domain service types its deps from the `.infra()` stage, never from `Deps`. It is part of `Deps`, so TypeScript reports TS7022 on the feature.
- A task that runs a command names a system actor: `ctx.run(cmd, input, { actorId: 'system' })`.
- `journalWorker()` is the only journal entrypoint. Entrypoints still see only the usecases and the `entrypointOnly` needs.
- Duplicate names are refused across features, naming both.
- A reaction that serves several behaviours gets its own business-named file in `usecases/`. A reaction that crosses features belongs to the consuming feature. Keeping a command and its reactions in one file assigns ownership. It never limits who subscribes, and it never implies one transaction.

**The event graph.** `dot explain --as journal-flow` prints, per event, the entity fold, the projections and the reactions. Each line gives the timing, the owner feature, the deps and the retry policy:

```text
OrderPlaced
  fold order  [same transaction]
  projection placed-count  [same transaction]  owner orders
  effect send-receipt  [after commit, at least once]  owner orders; deps mailer; retry default, 7 retries
```

It is derived from the declarations when the app is configured; nothing is collected at runtime. With `--json` it is one graph for the whole app: `nodes` (`event`, `entity`, `projection`, `effect`, `tap`, `workflow`, `feature`) and `edges` that read subject to object (`folds`, `projects`, `reacts`, `owned-by`), each edge to an event with its `timing` and `delivery`. A workflow without `startOn` is listed under "Started by no event".

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

`journalTables()` returns the tables: `events`, `receipts`, `cursors`, `jobs`, `jobAttempts`, `jobArchive`, `jobOperations`, `workflowRuns`, `workflowSteps`, `workflowSignals`, `workflowWaits` and `limits`. The app's migrations create them (`drizzle-kit generate`). The library never creates tables at runtime.

`workflowRuns` has three nullable columns for start timing: `start_at` (the planned start of a delayed run), `ttl_at` (when a run that has not started expires) and `ttl_ms` (the `ttl`, so `reschedule` can move `ttl_at`). Its `state` may be `expired`. An app upgrading from an earlier version generates a migration for them.

`workflowRuns` also has `batch_id` (the batch of `def.startBatch` that started the run, indexed by `workflow_runs_batch_id_idx`) and `replay_of` (the run that `journal.workflows.replay` started this one from). Both are nullable `varchar(256)`. An app upgrading generates a migration for them; old runs keep `null`.

`workflowRuns` has three nullable `integer` columns for the run's overrides: `max_attempts`, `step_timeout_ms` and `priority`, from `def.start`. An app upgrading generates a migration for them (`drizzle-kit generate`); old runs keep `null`, so their steps run as their definitions say.

`workflowRuns.state` may be `queued` (`onBusy: 'queue'`), and a partial index on the queued runs, `workflow_runs_queued_idx` on `(started_at, id) where state = 'queued'`, finds the oldest one a freed slot promotes. An app upgrading generates a migration for it (`drizzle-kit generate`).

`workflowRuns` has `transitions` (`integer not null default 0`): how many nodes the run started on a first try, which `limits.transitions` caps. An app upgrading generates a migration for it (`drizzle-kit generate`), and backfills the runs that are still open (see the upgrade note).

`workflowRuns` has `limits` (`text[] not null default '{}'`): the shared limits (`concurrency.shared`) the run holds, with a GIN index on the unfinished runs (`workflow_runs_limits_idx`). A workflow's own limit is not listed: it counts the runs by `name`, so runs started before this column count too. `limits` (`journal_limits`) is the `journal.limit` entity: `name varchar(256) primary key`, `paused boolean not null default false`, `total integer`, `per_key integer`, `keys jsonb not null default '{}'` (per key `{ perKey, until }`) and `version`. A limit nobody changed has no row. An app upgrading generates a migration for both (`drizzle-kit generate`).

**Export every table on its own.** drizzle-kit collects only a schema module's top-level exports, so a table that sits only inside the `journalTables()` object never gets a migration. Export each one, and add `ExportsEveryJournalTable` from `@arki/journal/pg` so a table added in a later version fails the build until you export it:

```ts skip="fragment: part of an app (schema, features, journal root), not a standalone module"
import type * as thisModule from './journal.tables'; // the module itself

const tables = journalTables(schema);
export const journalEvents = tables.events;
// …one export per table
export type JournalTablesCheck = ExportsEveryJournalTable<typeof thisModule>;
```

A missing export reads `Property 'missingJournalTableExports' is missing … required in type '{ missingJournalTableExports: "jobArchive"; }'`. Tables match by type, so the export names are yours. Then run `drizzle-kit generate`.

`seq` is commit order, not only insert order. Every write takes one advisory transaction lock (`pg_advisory_xact_lock`, namespace `0x4a524e4c`) at its start and holds it until the transaction commits, so a transaction that took a lower `seq` always commits first. A reader that remembers the last `seq` it saw, as an async projection's cursor does, therefore misses nothing. The cost: event appends across the whole app commit one transaction at a time, and a transaction that writes events and then does slow work holds every other writer until it commits. Keep writes near the end of a transaction, or keep the transaction short.

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
  event_seq     bigint references journal_events(seq) -- effect rows of a stored event; null for a transient entity's event
  effect        varchar(128)                          -- effect rows only
  job_name      varchar(128)                          -- queue rows only
  args          jsonb                                 -- queue rows: the input (JSON null is allowed); effect rows: the job's copy of its journal_events row
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
  unique ((args->>'id'), effect) where kind = 'effect' -- one job per event and effect, transient events included
  unique (job_name, dedupe_key) where dedupe_key is not null
  check journal_jobs_kind_check             -- an effect row has effect and args (and event_seq when the event is stored) and no job_name or dedupe_key;
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

`kind = 'effect'` rows are the rows the journal always had. `unique (event_seq, effect)` stays. NULLs are distinct, so queue rows never collide on it. A transient entity's effect rows have no `event_seq`; `unique ((args->>'id'), effect) where kind = 'effect'` keeps one job per event and effect for them too, archive replay included. The due index serves both kinds. A dedupe key is scoped to its `job_name`.

**Effect rows carry their event.** `args` holds the `journal_events` row the write inserted, as JSON. The worker, `journal.job` and the workflow runner read the event from there and never join `journal_events`, so a job runs the same whether or not its entity keeps event rows. The copy is decoded as replay decodes a row, so upcasters apply to a job queued before a release. `StoredEventRow` from `@arki/journal/pg` parses `args` back to the row type (its timestamps come back as `Date`). The copy is also in `journal_job_archive` for as long as the archive keeps the job (7 days by default): `forget` rewrites both copies in the same transaction as the event row.

**Migrating an existing app.** Run `drizzle-kit generate`. The new migration drops `NOT NULL` on `event_seq` and `effect`, adds the four columns and the check, and creates the dedupe index. Every statement is additive or relaxes a constraint. Existing rows take the default `kind = 'effect'` and pass the check. The check scans the table once. The table is small, because rows are deleted on success. If it holds very many dead rows, edit the generated SQL to add the check as `NOT VALID` and run `VALIDATE CONSTRAINT` after.

**Upgrading to job operations and the archive.** Three tables are new (`journal_job_attempts`, `journal_job_archive`, `journal_job_operations`) and `journal_jobs` gains `enqueued_at` and `replay_of`. Generate the migration from `journalTables()`: run `drizzle-kit generate` and review the SQL. Every statement is additive. Old rows get `enqueued_at` at migration time, and no history is invented for them. Dead rows that exist already stay retryable.

Migrate first. Then roll the workers. An old worker on the new schema still works: it does not write attempt rows and it deletes a job on success, as before, so it archives nothing until it is replaced. A new worker on the old schema fails at the first claim, so never roll workers first.

**Rollout order.** Migrate first. Then roll the workers. Then roll the processes that call `runAfter`. This order makes sure a queue row always has a worker. It is not a safety rule: an old worker cannot claim a queue row. To roll back, stop the producers first and let the new workers drain. Never restore `NOT NULL` while queue rows exist.

A job row leaves `journal_jobs` when its handler succeeds. The table holds only pending and dead work. What happens to the finished job is the retention policy's business: see [Retention and archive](#retention-and-archive). The event row is the lasting record.

An entity table needs a string key column that is primary or unique (`id` by default) and `version integer not null default 0`.

## Debugging

`DEBUG=arki:journal:*` prints commands, writes, replays, drains and worker ticks.

## Public imports

| Import                             | What it holds                                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `@arki/journal`                    | the portable core: `initJournal`, `need`, `jobId`, the command failures                                           |
| `@arki/journal/pg`                 | `journalTables()`, the table definitions                                                                          |
| `@arki/journal/errors`             | the command failures, `JournalError`, `isJournalError`. No Drizzle import, for browser code that matches on codes |
| `@arki/journal/contract`           | browser-safe, for oRPC contracts: `COMMAND_FAILURES`, the command and workflow failures, `CommandFailure`         |
| `@arki/journal/dot`                | the optional `@arki/dot` unit and feature slice (see Dot)                                                         |
| `@arki/journal/orpc`               | the optional oRPC error mapping (see Rejected rules)                                                              |
| `@arki/journal/http`               | `responseCache`, the Postgres cache for HTTP idempotency                                                          |
| `@arki/journal/http/webhooks`      | outgoing webhooks on the job table                                                                                |
| `@arki/journal/foreman`            | the Foreman job console and workflow console                                                                      |
| `@arki/journal/projection`         | the projection entry for Dot tooling                                                                              |
| `@arki/journal/testing`            | `openJournalDb(schema)`: in-memory PGlite with the schema pushed; `workflowHarness`, for workflow tests           |
| `@arki/journal/zod`                | the Zod schemas that decode stored values: `storedEventRowSchema`, `forwardArgsSchema`, `eventLogPositionSchema`  |
| `@arki/journal/postgres`           | `postgresEvents`: an event log in another Postgres database                                                       |
| `@arki/journal/kurrentdb`          | `kurrentEvents`: an event log in KurrentDB (optional peer `@kurrent/kurrentdb-client`)                            |
| `@arki/journal/event-log-contract` | `eventLogContract`, `ContractSkip`: the conformance suite for an event log adapter                                |

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
- **A loop is capped by `limits.transitions`** (1000 by default). A run that would pass it compensates and ends `failed` with `WorkflowTransitionLimit`. See [Stop a loop with `limits.transitions`](#stop-a-loop-with-limitstransitions).
- **Workflow values are small JSON.** The input, each result, each signal payload and the output must stay under `limits.payload` (65 536 bytes by default). A larger input makes `start` return `CommandConflict`; a larger result fails its step with `WORKFLOW_LIMIT`. A value must also come back from JSON unchanged (no `Date`, no class instance), or it is `UNSTABLE_SCHEMA`. Store big data elsewhere and keep a reference.

## Documentation

The [agent guide](docs/agent-guide.md) has the model, a task map, the rules and the errors. Upgrade guides are in [`docs/upgrades/`](docs/upgrades/): the latest is [0.3.0 to 0.4.0](docs/upgrades/0.3.0-to-0.4.0.md). The [design spec](https://github.com/arki-labs/arki/blob/main/packages/journal/docs/specs/2026-10-09-journal-design.md) explains intent.

## Support

Questions and bugs: <https://github.com/arki-labs/arki/issues>. Include the package version, the error `code` and the output of `DEBUG=arki:journal:*`.
