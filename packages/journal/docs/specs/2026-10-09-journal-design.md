# `@arki/journal` — design

Date: 2026-10-09. Status: approved by the founder for build.
Replaces `@arki/event-sourcing` and removes `@event-driven-io/emmett` and
`@event-driven-io/emmett-postgresql` from the monorepo.

Sources: two independent designs (`.work/hybrid-events/design-fable.md`,
`.work/hybrid-events/design-astra.md`) and two fact digests in the same folder.

## 1. What this is

A journal keeps two things and writes them together:

- **The log.** Every change is one row in `journal_events`. Rows are never edited.
- **The row.** Each entity also has a normal row in its own Drizzle table.

One call, `journal.write`, validates the event data, appends the events, runs the
reducers, and saves the row, inside the caller's Drizzle transaction. Both land or neither does.

Reads are plain Drizzle queries on the row. Nobody replays to read. Replay exists for
checks and repair.

This is not strict event sourcing, and the package does not claim to be.

## 2. Words

| Word       | Meaning                                                               |
| ---------- | --------------------------------------------------------------------- |
| event      | One fact about one entity. Immutable. Has a Zod schema for its data.  |
| entity     | A kind (`'order'`) plus the Drizzle table that holds its current row. |
| row        | The current state of one entity. A plain Drizzle select row.          |
| journal    | The log table, and the object you call to write.                      |
| projection | Inline handler. Runs inside the write's transaction.                  |
| effect     | Async handler. Runs after commit, at least once.                      |
| job        | One pending run of one effect for one event. A row in `journal_jobs`. |
| command    | A name, an input schema and a handler. The way to write.              |
| run        | Parse the input and `meta`, then call a command in one transaction.   |

Verbs: `command`, `run`, `write`, `create` / `on` (declare reducers), `replay`,
`verify`, `repair`, `rerun`, `drain`. Not used: `emit`, `evolve`, `send`, `dispatch`,
bus, stream, aggregate.

## 3. Founder decisions

| Decision           | Choice                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name               | `@arki/journal`                                                                                                                                   |
| API shape          | Chain of reducers (`.create` / `.on`) plus `events: (row, { tx }) => pending events`, called from a command. The library loads and locks the row. |
| Async lane         | One job row per effect per event, written in the same transaction.                                                                                |
| Old emmett history | Fresh start everywhere. No import from `emt_messages`.                                                                                            |

## 4. The example

```ts
// src/journal.ts — once per app. `meta` is the app-wide metadata schema.
import { initJournal } from '@arki/journal';

export const j = initJournal({ meta: z.object({ actorId: userId.schema }) });
// Or: initJournal.tx<AppTx>().create({ meta }) — types `tx` everywhere with the app's transaction type.

// src/features/orders/tables.ts — a normal table with `id` and `version`.
// A table keyed by another column: j.entity('profile', profiles, { id: 'accountId' }).
export const orders = schema.table('orders', {
  id: orderId.primaryColumn(),
  customerId: userForeignKeys.required('customer_id'),
  total: integer('total').notNull(),
  status: varchar('status', { enum: ['placed', 'paid', 'cancelled'] }).notNull(),
  version: integer('version').notNull().default(0),
});

// src/features/orders/order.ts
export const OrderPlaced = j.event('OrderPlaced', z.object({ customerId: userId.schema, total: z.int().positive() }));
export const OrderPaid = j.event('OrderPaid', z.object({ amount: z.int().positive() }));
export const OrderCancelled = j.event('OrderCancelled', z.object({ reason: z.string().min(1) }));

export const order = j
  .entity('order', orders)
  .create(OrderPlaced, e => ({ customerId: e.data.customerId, total: e.data.total, status: 'placed' }))
  .on(OrderPaid, () => ({ status: 'paid' })) // a patch: only the columns that change
  .on(OrderCancelled, () => null); // null deletes the row; the events stay

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

// Async lane: after commit, at least once. Dependencies come in by closure.
export const orderMail = (mailer: Mailer) =>
  j.effect('order-mail', order, {
    OrderPaid: (e, { jobId }) => mailer.send({ template: 'order-paid', orderId: e.entityId, idempotencyKey: jobId }),
  });

// src/features/orders/commands.ts — a command needs only `j`, entities and events.
export const payOrder = j.command(
  'payOrder',
  z.object({ orderId: orderIdSchema, amount: z.int().positive() }),
  (input, { write }) =>
    write(order, input.orderId, row => {
      if (!row) throw new NotFoundError('order', input.orderId);
      if (row.status !== 'placed') throw new InvalidStateError(`order ${input.orderId} is ${row.status}`);
      return [OrderPaid({ amount: input.amount })]; // [] means: write nothing
    }),
);

// src/journal.root.ts — the one place that lists handlers.
export const journal = j.create({
  tables: journalTables(schema),
  projections: [customerStats],
  effects: [orderMail(mailer)],
});

// A procedure. The schema is reused; the actor comes from the session.
await journal.run(db, payOrder, input, { actorId: ctx.user.id });

// A read. Plain Drizzle.
const row = await db.query.orders.findFirst({ where: { id } });

// Boot. One worker per process runs the async lane.
const worker = journal.worker(db);
await worker.start();
```

## 5. Public API

Export paths: `.` (portable core), `./pg` (table definitions only), `./dot` (optional
`@arki/dot` plugin). No Node-only imports anywhere.

```ts
function initJournal<Meta extends z.ZodObject>(options?: { meta?: Meta }): JournalInit<Meta, Db>;
// Type-only step: the app's Drizzle transaction type. `Tx` is `Db` without it.
initJournal.tx<Tx>().create<Meta>(options?: { meta?: Meta }): JournalInit<Meta, Tx>;

type JournalInit<Meta, Tx> = {
  event<T extends string, D extends z.ZodType>(type: T, data: D): EventDef<T, D>;
  entity<K extends string, Tbl extends IdTable>(kind: K, table: Tbl): EntityBuilder<K, Tbl, never, 'id'>; // key column `id`
  entity<K extends string, Tbl extends EntityTable, Key extends KeyName<Tbl>>(kind: K, table: Tbl, options: { id: Key }): EntityBuilder<K, Tbl, never, Key>; // Key: a property name of a non-null string column
  projection<E extends AnyEntity>(name: string, entity: E | E[], on: Handlers<E, [tx: Tx]>): Projection<Tx>;
  effect<E extends AnyEntity>(name: string, entity: E | E[], on: EffectHandlers<E>): Effect;
  create(config: { tables: JournalTables; projections?: Projection<Tx>[]; effects?: Effect[] }): Journal<Meta, Tx>;
};

// Calling an event definition validates the data and returns a pending event.
type EventDef<T, D> = { readonly type: T; readonly schema: D } & ((data: z.input<D>) => Pending<T, z.output<D>>);

// Names: an entity kind, an event type and an effect name are non-empty and well-formed.
// At most 64 characters for a kind, 128 for an event type or an effect name.
// What reducers and handlers receive. `Id` is the entity's key type; the log stores the string.
type Recorded<T, Data, Meta, Id extends string = string> = {
  seq: number; id: string; kind: string; entityId: Id; version: number;
  type: T; data: Data; meta: Meta; recordedAt: Date;
};

// A table qualifies when it has an integer `version` and a string key column that is primary or unique.
// `Key` is the key column's property name, `id` by default. `Created` collects the `.create` return types.
type EntityBuilder<K, Tbl, E, Key, Created = never> = EntityDef<K, Tbl, E, Key> & {
  create<D extends AnyEventDef, R extends NewRow<Tbl, Key>>(event: D, reduce: (e: RecordedOf<D, EntityId<Tbl, Key>>) => R): EntityBuilder<K, Tbl, E | D, Key, Created | R>;
  on<D extends AnyEventDef>(event: D, reduce: (row: OnRow<Tbl, Key, Created>, e: RecordedOf<D, EntityId<Tbl, Key>>) => Patch<Tbl, Key> | null): EntityBuilder<K, Tbl, E | D, Key, Created>;
};
type Row<Tbl> = Tbl['$inferSelect'];
type EntityId<Tbl, Key> = Row<Tbl>[Key]; // the key column's own type
type NewRow<Tbl, Key> = Omit<Tbl['$inferInsert'], Key | 'version'>; // the library sets the key and version
type Replayed<Tbl, Key> = NewRow<Tbl, Key> & Record<Key, EntityId<Tbl, Key>> & { version: number }; // reducer-shaped state; columns with defaults may be absent
type OnRow<Tbl, Key, Created> = Replayed<Tbl, Key> & Required<Pick<NewRow<Tbl, Key>, CreatedKeys<Created>>>; // keys every create sets are required
type Patch<Tbl, Key> = Partial<NewRow<Tbl, Key>>; // merged onto the state; a key set to undefined is unchanged
type RootDb = Db & { rollback?: undefined }; // the database, never a transaction
type Transaction<Tx> = Db & { transaction<T>(run: (tx: Tx) => Promise<T>): Promise<T> }; // opens `Tx` transactions

type WriteEvents<Tbl, E, Tx> = (row: Row<Tbl> | null, ctx: { tx: Tx }) => Pending[] | Promise<Pending[]>; // looks at the locked row, checks the rules, returns the events
type Command<S, R, MetaOut, Tx> = { name: string; input: S; handler: (input: z.output<S>, context: CommandContext<MetaOut, Tx>) => R }; // from j.command(name, schema, handler)
type CommandContext<MetaOut, Tx> = {
  tx: Tx; meta: MetaOut;
  write(entity, id: EntityId, events: WriteEvents): Promise<{ row: Row | null; events: Recorded[] }>; // bound to tx and meta
  run(child: Command, input: z.input<S>): Promise<Awaited<R>>; // a savepoint of tx, same meta
};

type Journal<Meta, Tx> = {
  run(source: Transaction<Tx>, command: Command<S, R, z.output<Meta>, Tx>, input: z.input<S>, meta: z.input<Meta>): Promise<Awaited<R>>; // parse, then the handler in one transaction (root db) or savepoint (tx)
  write(tx: Tx, entity, id: EntityId, input: { meta: z.input<Meta>; events: WriteEvents }): Promise<{ row: Row | null; events: Recorded[] }>;
  replay(db, entity, id: EntityId, opts?: { upTo?: number }): Promise<{ row: Replayed | null; events: Recorded[] }>;
  verify(db, entity, id: EntityId): Promise<{ ok: true } | { ok: false; expected: Replayed | null; actual: Row | null }>;
  repair(db, entity, id: EntityId): Promise<Row | null>;
  rerun(db: Transaction<Tx>, projection, opts?: { from?: number; batch?: number }): Promise<{ events: number }>;
  drain(db: RootDb, opts?: { limit?: number; signal?: AbortSignal }): Promise<number>; // one batch of jobs
  worker(db: RootDb, opts?: { pollMs?: number; limit?: number }): { start(): Promise<void>; stop(): Promise<void> };
  catalog: { entities: EntityInfo[]; projections: string[]; effects: string[] };
};

class JournalError extends Error {
  code: 'CONFLICT' | 'NO_ROW' | 'ROW_EXISTS' | 'UNKNOWN_EVENT' | 'VERSION_MISMATCH' | 'NO_HISTORY' | 'REPLAY_FAILED' | 'UNSTABLE_SCHEMA' | 'VALUE_MISMATCH' | 'ID_MISMATCH';
  kind: string; entityId: string;
}

// ./pg
function journalTables(schema?: PgSchema): { events: PgTable; jobs: PgTable };
// ./dot
function journalPlugin(options: { journal: Journal; worker?: boolean }): Plugin;
```

`Db` is a structural type. Both a Drizzle database and a Drizzle transaction fit it.
`RootDb` fits the database only. `drain` and `worker` take `RootDb`, and also check at
runtime: inside a transaction the claim would be a savepoint, and handlers would run
before the outer transaction commits.

What is inferred:

- Event data type, from the Zod schema passed to `j.event`.
- Row type and id type, from the Drizzle table.
- The events an entity accepts, from the `.create` / `.on` chain. `events` cannot
  return an event the entity does not declare.
- Handler map keys and each handler's event type, from the entity passed in.
- `meta` everywhere, from the `initJournal` schema.
- A command's handler input from its schema; `run`'s input argument as the schema's
  input type; `run`'s result from the handler's return type.

Events are read-only at runtime: `decode` deep-freezes each one, so a reducer, projection or effect that changes `e.data` or `e.meta` gets a `TypeError`.

A `.create` reducer receives no row and returns the full `NewRow`. An `.on` reducer
always receives the reducer-shaped state, `Replayed<Tbl, Key>`: the insert shape plus
the key column and `version`. Columns with database defaults may be absent, because
replay has no database. So reducers never check for a missing row. An `.on` reducer
returns a patch: the columns that changed. The patch is merged onto the state. `null`
deletes the row. A key set to `undefined` is stripped and means unchanged; to clear a
nullable column, return `null` for it. `events(row, { tx })` still receives the stored
`Row<Tbl> | null`; `tx` is the write's savepoint, open after the row is locked.

The key column is `id` unless `j.entity` names another by its property name,
`{ id: 'accountId' }`. The name is typed as the table's non-null string column names,
and must be one name: a union is rejected, because `NewRow` would omit every member.
The column must be not null and the primary key or unique, on the column or as a
single-column table-level constraint or unique index without a `where` (a partial
index is unique only inside its subset); `j.entity` checks and throws otherwise. The id argument, the key on the `.on` row and `entityId` on recorded events
all have the column's own type.

- The id must be the exact stored form of the key. The journal refuses another spelling with `ID_MISMATCH` in `write`, `verify` and `repair`; a create whose stored key differs from the id is refused too and rolls back. For `uuid` keys pass lower-case.
- An id must be well-formed UTF-16. An id with an unpaired surrogate is refused with `ID_MISMATCH` before any database access, because the driver would store it as U+FFFD and it would reach the history of another id. Nothing is replaced or stripped.
- The key column must be a plain `text`, `varchar` or `uuid` column, not a custom column type, because a custom type's mapping can change the string. `j.entity` refuses any other (`citext`, `char(n)`, numbers) because it can treat two different strings as one key. An id is at most 256 characters, or the column's own limit if smaller, and not empty; `write`, `replay`, `verify` and `repair` refuse any other with `ID_MISMATCH`. A `text` or `varchar` key must use the database's default, exact comparison, not a case-insensitive collation. A `uuid` id must be lower-case and hyphenated; `write`, `replay`, `verify` and `repair` refuse another spelling with `ID_MISMATCH` before any database access.

Columns that every `.create` reducer sets are required on the `.on` row (`OnRow`).
Sound because a patch cannot unset a key and `undefined` values are stripped. A
column one create leaves out, sets on one branch only, or may set to `undefined` stays
optional. Every `.create` comes before the first `.on`: after it the builder type has
no `.create` and the runtime throws, because a later create could leave out a column
the `.on` was promised. `.on` declared before any `.create` sees the plain insert shape.

One event may have both reducers. The fold picks by state: no row runs the create
reducer, a row runs the on reducer. Declaring the same event twice in one mode throws
at definition time.

Database defaults are not journal state. `write` folds from the stored row, so a
reducer there sees a default-filled column. `replay` folds from nothing, so the same
column is `undefined`. That is why such columns are optional in the `.on` row type
unless every create sets them.
The rule: a reducer must set every column that any reducer later reads. A `.create`
result follows the patch rule too: a key set to `undefined` is stripped, the default
applies, and the column is not journal state. `verify` compares only the columns
reducers set.

## 6. Storage

Two tables. The app's own migrations create them (`drizzle-kit generate`). The library
never creates tables at runtime.

```ts
journal_events
  seq          bigserial primary key          -- global order, used by rerun
  id           varchar not null unique        -- evt_xxx
  kind         varchar(64) not null
  entity_id    varchar(256) not null
  version      integer not null               -- 1, 2, 3 per entity
  type         varchar(128) not null
  data         jsonb not null
  meta         jsonb not null
  recorded_at  timestamptz not null default now()
  unique (kind, entity_id, version)

journal_jobs
  id            varchar primary key           -- job_xxx; pass it on as an idempotency key
  event_seq     bigint not null references journal_events(seq)
  effect        varchar(128) not null
  attempts      integer not null default 0
  available_at  timestamptz not null default now()
  lease_until   timestamptz
  lease_token   varchar
  last_error    text
  dead_at       timestamptz                   -- set when attempts run out
  unique (event_seq, effect)
  index (available_at) where dead_at is null
```

A job row is deleted when its handler succeeds. So `journal_jobs` holds only pending
and dead work. The event row is the lasting record.

An entity table needs `id` (string primary key) and `version integer not null default 0`.
Every other column is the app's business.

## 7. Write algorithm

`journal.write(tx, entity, id, { meta, events })`, also what a command's bound `write` calls:

1. Parse `meta` with the app schema.
2. Open a savepoint on `tx`. A failure inside rolls back this write even if the caller
   catches the error.
3. Lock and load: `SELECT * FROM <table> WHERE <key column> = $1 FOR UPDATE`. Row or `null`.
4. Find the base version. Row found: `row.version`. No row: the highest `version` in
   the log for `(kind, id)`, or `0`. This lets a deleted entity be created again.
5. `pending = await events(row, { tx: savepoint })`. Empty list: return `{ row, events: [] }`.
6. Check each event. It must be declared on this entity (`UNKNOWN_EVENT`). Parse its
   data with the declared schema; a `ZodError` passes through. The JSON round trip of
   the output must parse to the same value, or `UNSTABLE_SCHEMA`. The same round-trip
   rule applies to `meta`. With no row, the first event must have a `.create` reducer
   (`NO_ROW`). With a row, it must have an `.on` reducer (`ROW_EXISTS`). After a
   reducer returns `null`, only an event with a `.create` reducer may follow.
7. Append all events with one `INSERT ... RETURNING`. A unique violation on
   `(kind, entity_id, version)` becomes `JournalError('CONFLICT')`.
8. Reduce in memory. For each recorded event, call the reducer and merge its patch.
   Write and replay share this fold, so they agree on every column a reducer set.
9. Save the row. Create: `INSERT`. Update: `UPDATE ... WHERE id AND version = $old`;
   zero rows changed is `VERSION_MISMATCH`. Delete: `DELETE ... WHERE id AND version = $old`.
   Delete then create in one write: `DELETE` then `INSERT`, so columns the create omits
   get their defaults, the same as two separate writes.
   Then compare, for each column a reducer set in this write, the value the reducers
   produced with the value `RETURNING` gave back, using `verify`'s comparison. Any
   difference is `VALUE_MISMATCH` and rolls the savepoint back. `repair` does the same
   after it saves the replayed row. For a JSON column a reducer may produce plain objects,
   full arrays, strings, numbers, booleans and `null`; a `Map`, a `Set` or an array with
   holes is refused.
10. Run projections. For each event in order, call each projection that declares its
    type with `(tx, event)`. A throw rolls everything back.
11. Insert one job row for each effect that declares the event's type.
12. Release the savepoint. Return `{ row, events }`. The caller commits.

Cases:

- **Several events in one write.** `events` returns `[A, B]`. One insert, one row save.
- **Several entities in one transaction.** Call `write` twice with the same `tx`. Keep a
  consistent order inside a feature to avoid deadlocks.
- **Two writers at once.** The second waits at step 3. No retry code in apps. The unique
  index catches the one case the lock cannot: two creates of the same new id.
- **Doing the same thing twice.** `events` sees the row and returns `[]`.

## 8. Async lane

Guarantee: **at least once, nothing lost after commit, no ordering promise.**

Job rows are inserted in the write's transaction. A crash after commit leaves them
pending. A rollback leaves neither events nor jobs.

`drain` does one batch:

1. In a short transaction, claim due rows with `FOR UPDATE SKIP LOCKED`. Set a fresh
   `lease_token`, set `lease_until = now() + 60s`, bump `attempts`. Commit.
2. Run each handler outside any transaction, with `(event, { jobId, signal })`. A
   claimed job whose effect has no handler for the event type fails like any handler error.
3. Success: delete the row, matching on `lease_token`.
4. Failure: store `last_error`, set `available_at` to now plus backoff (doubling with
   jitter, capped at 5 minutes). After 8 attempts set `dead_at` instead.

Every time here is database time (`now()` in SQL): due checks, `lease_until`,
`available_at`, `dead_at`. A worker with a skewed clock cannot take a live lease.

A job whose lease runs out is claimed again by the next drain. A dead job stays in the
table until a human clears `dead_at` or deletes it. A job naming an effect the process
does not know stays pending; it is never dropped silently.

`worker` is a loop around `drain` with a poll delay. `stop()` finishes the current batch.
The library installs no signal handlers and never calls `process.exit`.

Effects must be safe to run twice. Use `jobId` as the idempotency key for outside calls.
An effect that needs order should read the current row instead of trusting the event.
BullMQ is not required. An effect may enqueue a job: `OrderPaid: e => queue.add(...)`.

## 9. Replay, repair, and changing events

- `replay` reads the entity's events in version order, parses each with its current
  schema, and folds the reducers. It returns the reducer-shaped row (`Replayed`): no
  database defaults. `upTo` gives the state at an earlier version.
- `verify` replays and compares with the stored row, on the columns reducers produce.
  A column filled only by a database default is not compared: it is not journal state
  (section 5). A reducer that reads such a column sees the default during `write` and
  `undefined` during `replay`; that reducer breaks the rule, and `verify` reports it.
- `repair` locks the row, replays, and saves the result. It writes no event, runs no
  projection, and creates no job.
- `rerun` walks the log from a `seq` and calls one projection's handlers, a batch per
  transaction. The app clears the target table first.
- Rows that existed before the journal have no create event. `replay`, `verify`, and
  `repair` throw `JournalError('NO_HISTORY')` for them. Writes work: such a row (stored
  `version` 0, no events) is treated as version 1, so its history starts at version 2.
  Version 1 is reserved for a create from no row, and replay, verify and repair require
  a history that starts at 1. A version-0 row whose log is not empty is `CONFLICT`.
- A row removed outside the journal while its log (starting at 1) folds to a row is
  `CONFLICT` on the next create: write would pick `.create` where replay picks `.on`.
  `repair` restores the row; then writes work again. A row the journal deleted is fine.
- Two `write` or `run` calls open on one transaction at the same time are refused: the
  second waits for the first to settle, then rejects, whatever its reason (bad meta
  included). Savepoints are a stack. A child command runs on its own savepoint, so
  nesting is fine.
- A command handler must await every `write` and `run` before it returns. `run` waits
  for operations still running, then fails the command and rolls back; if the handler
  threw, its own error is reported. The low-level `write` inside the caller's own
  transaction has no such guard: await every journal call before the callback returns.

Changing an event:

- Adding a field: use `.optional()` or `.default(x)`. Old rows still parse.
- Any other change: add a new event with a new name and keep the old `.on` reducer.
- Event data must be plain JSON: no `Date`, no transforms that change the type. A schema
  must accept its own output, because replay parses stored data again. `write` checks
  this and throws `UNSTABLE_SCHEMA` when the round trip changes the value.
- There is no upcaster.

## 10. Left out on purpose

| Dropped                                             | Why                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Command bus, string dispatch, registration          | `journal.run(db, command, input, meta)` is a direct call. A bus adds a lookup and no guarantee.   |
| Command queue, delayed execution                    | Jobs and schedules call `journal.run` when due. The journal keeps no queue of its own.            |
| Middleware                                          | Auth and permission checks are application code before `run`. Business rules live in the command. |
| Deciders, `initialState`, `evolve`                  | Replaced by `.create` / `.on` and `events`.                                                       |
| Streams and stream names                            | `kind` plus the row's primary key.                                                                |
| Process managers and sagas                          | One consumer in the monorepo. It becomes an effect.                                               |
| In-memory bus, `handleCommand`, `waitForProjection` | Projections run in the write's transaction.                                                       |
| emmett's own tables, pool, and migrations           | They break the one-transaction rule.                                                              |
| `expectedVersion` and write ids from callers        | The row lock removes the need.                                                                    |
| Ordered async delivery, cursors, dead-letter table  | Job rows cover retries and failures.                                                              |
| Snapshots, soft delete, upcasters, `LISTEN/NOTIFY`  | Wait for a real need.                                                                             |

## 11. Migration order

1. Build `packages/journal` with PGlite tests.
2. Template (`turbo/generators/templates/application/backend`) and `apps/sudoku`.
3. `apps/games-platform`.
4. `packages/payments`.
5. `apps/kapodopera`, feature by feature. Emmett and the journal can run side by side
   until the last feature moves.
6. The remaining app backends (1 to 2 files each).
7. Delete `packages/event-sourcing`, both emmett dependencies, and rewrite
   `.agents/skills/event-sourcing`.

Per feature: each `Event<...>` type becomes `j.event(name, zodSchema)`. Each `evolve`
case becomes one `.create` or `.on`. Each command-handler case becomes one `j.command`.
Each projection becomes `j.projection`. Existing projection tables keyed by the entity
id gain a `version` column and become the entity table.

Old `emt_*` tables are left in place and no longer read. Dropping them is a founder step.

## 12. To verify during the build

- The chain keeps Drizzle table and transaction types with no casts. Prove this first.
- A two-connection test on real Postgres shows the second writer waits and then sees the
  first writer's row. PGlite has one connection and cannot show this.
- Create after delete continues the version sequence and replays correctly.
