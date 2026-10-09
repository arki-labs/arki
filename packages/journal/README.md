# @arki/journal

A journal keeps two things and writes them together.
Every change is one immutable row in `journal_events`.
Each entity also has a normal row in its own Drizzle table.
One call, `journal.write`, validates the event data, appends the events, runs the reducers, saves the row, runs inline projections and queues jobs for async effects, all inside the caller's Drizzle transaction.
Reads are plain Drizzle queries. Replay exists for checks and repair, not for reading.

Exports: `@arki/journal` (portable core), `@arki/journal/pg` (table definitions), `@arki/journal/dot` (optional `@arki/dot` plugin).

## Example

```ts
// src/journal.ts — once per app. `meta` is the app-wide metadata schema.
import { initJournal } from '@arki/journal';
export const j = initJournal({ meta: z.object({ actorId: z.string() }) });

// src/features/orders/tables.ts — a normal table with `id` and `version`.
export const orders = pgTable('orders', {
  id: varchar('id', { length: 256 }).primaryKey().$type<OrderId>(),
  customerId: varchar('customer_id', { length: 256 }).notNull(),
  total: integer('total').notNull(),
  status: varchar('status', { enum: ['placed', 'paid', 'cancelled'] }).notNull(),
  version: integer('version').notNull().default(0),
});

// src/features/orders/order.ts
export const OrderPlaced = j.event('OrderPlaced', z.object({ customerId: z.string(), total: z.int().positive() }));
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
      .onConflictDoUpdate({ target: customerOrderCounts.customerId, set: { placed: sql`${customerOrderCounts.placed} + 1` } }),
});

// Async lane: after commit, at least once. Dependencies come in by closure.
export const orderMail = (mailer: Mailer) =>
  j.effect('order-mail', order, {
    OrderPaid: (e, { jobId }) => mailer.send({ template: 'order-paid', orderId: e.entityId, idempotencyKey: jobId }),
  });

// src/features/orders/commands.ts — a command is a plain function.
export const payOrder = (tx: Db, id: OrderId, amount: number, actorId: string) =>
  journal.write(tx, order, id, {
    meta: { actorId },
    decide: row => {
      if (!row) throw new NotFoundError('order', id);
      if (row.status !== 'placed') throw new InvalidStateError(`order ${id} is ${row.status}`);
      return [OrderPaid({ amount })]; // [] means: write nothing
    },
  });

// src/schema.ts — the two journal tables live in the app's schema.
import { journalTables } from '@arki/journal/pg';
export const journal_ = journalTables(); // or journalTables(pgSchema('app'))

// src/journal.root.ts — the one place that lists handlers.
export const journal = j.create({ tables: journal_, projections: [customerStats], effects: [orderMail(mailer)] });

// A procedure. The app owns the transaction.
await db.transaction(tx => payOrder(tx, input.id, input.amount, ctx.user.id));

// Boot. One worker per process runs the async lane. Root database only, never a transaction.
const worker = journal.worker(db);
await worker.start();
```

`decide` only accepts events declared on the entity. The row type, the id type and the event data types are all inferred.

An `.on` reducer receives the reducer-shaped state (`Replayed<Tbl>`: the insert shape plus `id` and `version`; columns with database defaults may be absent) and returns a patch, `Partial<NewRow<Tbl>> | null`. The patch is merged onto the state. A key set to `undefined` means unchanged. `decide(row)` still receives the stored `Row<Tbl> | null`.

Database defaults are not journal state. `write` folds from the stored row, where a default-filled column has its value. `replay` folds from nothing, where that column is `undefined`. That is why such columns are optional in the `.on` row type. The rule: a reducer must set every column that any reducer later reads. In a `.create` result, a key set to `undefined` is stripped and the default applies. `verify` compares only the columns reducers set.

`write` parses every event's data with its schema, even for a hand-built `{ type, data }`. The schema must accept its own stored output unchanged, because replay parses stored data again; otherwise `write` throws `UNSTABLE_SCHEMA`. The same rule applies to `meta`.

Errors are `JournalError` with a `code`: `CONFLICT`, `NO_ROW`, `ROW_EXISTS`, `UNKNOWN_EVENT`, `VERSION_MISMATCH`, `NO_HISTORY`, `REPLAY_FAILED`, `UNSTABLE_SCHEMA`.

Other verbs: `replay(db, entity, id, { upTo })` (returns the reducer-shaped row), `verify(db, entity, id)`, `repair(db, entity, id)`, `rerun(db, projection, { from, batch })`, `drain(db, { limit, signal })`. `drain` and `worker` take the root database (`RootDb`), never a transaction: effects must run after commit. Lease and retry times use the database clock.

## Tables

`journalTables()` returns both. The app's migrations create them (`drizzle-kit generate`). The library never creates tables at runtime.

```text
journal_events
  seq          bigserial primary key      -- global order, used by rerun
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

An entity table needs `id` (string primary key) and `version integer not null default 0`.

## Debugging

`DEBUG=arki:journal:*` prints writes, replays, drains and worker ticks.
