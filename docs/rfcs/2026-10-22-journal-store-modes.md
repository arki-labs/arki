# RFC: Journal domain logic without stored events

- **Status:** PROPOSED (2026-10-22). Decisions D-1 to D-3 answered the same
  day (section 4). Reviewed the same day (section 7). Pluggable event stores
  added the same day (section 8, D-4 to D-6) and reviewed (8.9).
- **Progress:** slice 1 in `f49fcea75b`, with every effect job carrying its
  event (founder's choice, wider than slice 1 as written). Its two leaks, the
  archive sink and the Foreman payload, were closed in the commit that adds
  this line. Slice 2 landed inside `2c462f04ed` ("feat(eslint):
  domain-services joins the feature layers"): another session's plain
  `git commit` took the staged slice 2 hunks. The content is the reviewed
  slice 2; only the message is wrong. Slice 3 in `96eff79424`. Slice 4 as
  storage seams only: the founder dropped the memory store on 2026-10-23
  (see slice 4), in `3dcaaaf33f`. Slice 5 finished the docs: most of it
  shipped with slices 2 to 4; the commit that adds this line puts the
  setting in `llms.txt` and the `journal` skill. Sections 1 to 5 are done.
  Slice 6 in `a0a2f54671` (see 8.8). That commit also carries three
  `packages/auth` renames (pure moves) another session had staged; left in
  place (founder). Slices 7a and 7b in one commit, the one that adds this
  sentence (founder: merge them; see 8.8).
- **Scope:** `@arki/journal` only. Apps change only if they opt in.
- **Inputs:** four read-only agent reports (Fable) from 2026-10-22: domain
  core, write path, event-log dependents, prior decisions + prior art. Then
  one blind review (Fable; Astra was out of Codex credits until 2026-10-27).
  The review confirmed every file:line claim in sections 2 and 3. This
  session re-opened the four claims that changed the plan (section 7).

## 1. The ask

Write domain logic (entities, events, commands) with `@arki/journal`
without storing the events. Storing events becomes a setting.

## 2. Why this is a small change

The journal is already "state-stored first":

- Reads come from the table row. Nobody replays to read
  (`packages/journal/docs/specs/2026-10-09-journal-design.md:22-24`).
- The write path loads the row (`src/storage.ts:35-44`), runs the command's
  callback on it (the "decide" step, `src/write.ts:172`), applies the new
  events with `.create` / `.on` (the "evolve" step, `src/fold.ts`,
  `src/write.ts:316`), and saves the row.
- Events are inserted in exactly one place: `src/write.ts:271-285`.
- Optimistic concurrency already lives on the row: `version` plus
  `where version = stored` (`src/write.ts:164-171`, `:318-364`).

Other libraries do the same: Axon (state-stored vs event-sourced repository),
Ecotone (`#[EventSourcingAggregate]` is an opt-in), and the Decider pattern
(one `decide`/`evolve`, the runner picks the storage). The journal already
has the Decider shape under other names.

## 3. What depends on stored events today

| Feature | Without stored events | Plan |
| --- | --- | --- |
| State row, version check | Works | — |
| Inline projections | Works: they get the in-memory events (`src/write.ts:376-382`) | — |
| Receipts (command, HTTP, oRPC idempotency) | Works: own table (`src/command.ts:62-110`) | — |
| Queue jobs, webhooks, retention, hooks | Works: own tables | — |
| Wake `pg_notify` (`src/write.ts:407-411`) | Still fires; harmless | — |
| **Effects** | Breaks: job row has an FK to `events.seq` (`src/pg.ts:71`), the worker reads the event back (`src/worker.ts:227-236`) | Effect job carries the event (slice 1) |
| Foreman job detail, archive replay | Read the event by seq (`src/outbox.ts:290-305`, `:786`) | Read `args` instead (slice 1) |
| **Durable workflows** | Breaks: `workflow.run` is an entity; the runner reads its events to resume (`src/workflow/runner.ts:557-564`, `:694-713`) | Workflow runs always store events |
| Async projections, taps | Break: they scan `journal_events` (`src/worker.ts:547-549`, `:671-680`) | Refused at `compose` |
| `rerun` (`src/history.ts:377-421`) | Silently misses events of entities that keep none | Refused |
| History: replay, verify, repair, forget; audit by command/correlation id | Impossible by nature | Refused with `NO_HISTORY` |

Consumers: `packages/payments` and `packages/queue` use the journal;
`payments` keeps the default, `queue` uses only queue jobs. `packages/mail`
and `packages/live` do not import it. Only Kapodopera reads `journal_events`
directly (admin event browser,
`apps/kapodopera/backend/src/features/poetry/event-sourcing/service.ts:93-143`).
No app calls replay/verify/repair/forget.

## 4. Decisions (answered 2026-10-22)

- **D-1 Scope:** an `events` setting **and** an in-memory runner. Not a fully
  Drizzle-free core: the Drizzle table definition stays the one source of
  the state type. A table definition is a plain object, so the in-memory
  runner needs no database to use it.
- **D-2 Default:** store events, as today. No existing app changes.
- **D-3 Level:** a journal default plus a per-entity override.

```ts
const j = initJournal({ tables, events: 'stored' }); // journal default
const draft = j.entity('draft', drafts, { events: 'transient' }); // override
```

The setting is resolved in `journal.entity` (`src/journal.ts:180`), which
can see the journal default, and stored on `EntityDef`. Standalone
`defineEntity` (`src/entity.ts:206-228`) cannot see the default.

## 5. Plan (slices, each one commit)

1. **Effect jobs carry their event.** For entities that keep no history, the
   effect job's `args` is exactly the stored-event row shape (the
   `journal_events` insert at `src/write.ts:258-270`, plus `seq` and
   `recordedAt`). Its type is inferred from `tables.events.$inferInsert`; one
   Zod schema parses `args` on read. The worker builds the event row from
   `args` and runs the same `decodeStoredEvent`, so upcasters still apply to
   jobs that run after a schema change. Relax the check constraint
   (`src/pg.ts:105-108`): an effect row has `event_seq` **or** `args`. Foreman
   job detail and archive replay (`replayOf`) read and copy `args`. The
   `(event_seq, effect)` unique (`src/pg.ts:100`) does not cover these rows;
   add a partial unique on `(args->>'id', effect)` where `kind = 'effect'`, so
   an archive replay cannot double-run. Upgrade note in `docs/upgrades/`.
2. **The setting, with its refusals.** In `src/write.ts`, an entity with no
   history skips `highestVersion` / log-says-gone checks (`:193`, `:216`)
   and the insert (`:271-313`). The recorded events are built in memory.
   It **keeps** the advisory append lock (`:155`): the lock fixes the lock
   order across entities, so skipping it for some entities can deadlock a
   command that writes both kinds. The row insert maps a unique violation to
   `CONFLICT`, because two creates of one id race with no log index to catch
   them (`saveReplayed`, `src/storage.ts:113-115`). `compose` refuses async
   projections and taps on these entities with `BAD_DEFINITION`
   (`src/journal.ts:189-194`). replay, verify, repair, forget, rerun and
   `workflows.history` refuse with `NO_HISTORY`. `workflow.run` ignores the
   journal default and always stores events.
3. **`adopt` handles the switch.** Extend `adopt` to accept a row at any
   version whose log is empty (today it needs version 0, `src/write.ts:202`).
   It records the create as version 1 and sets the row to 1 under the row
   lock. Switching an entity to stored events is then: change the setting,
   run `adopt` per row.
4. **Storage seams + in-memory store.** Split by concern, not one bag:
   `EntityRows` (load with lock, insert, update, delete), `EventLog` (append,
   highest version, last event), `Receipts` (claim, settle, read), `Jobs`
   (enqueue), `wake`. `TransactionSource` (`src/types.ts:48-50`) already
   covers transactions and savepoints. The unique-violation → `CONFLICT`
   mapping lives inside each store. The memory store runs entities, commands
   and receipts only. It refuses every projection, effect and tap at setup,
   since it cannot tell which ones write with Drizzle. Receipts in memory are
   single-process only; say so. Exported as `@arki/journal/memory`
   (`memoryStore()`), next to `./pg`.

   **Done as seams only (2026-10-23, founder).** The memory store was
   dropped. Every journal API types the transaction as a Drizzle Postgres
   handle (`TransactionSource` / `DbHandle`, about 180 type references), and
   commands get it as `tx`. A store with no database has no such handle to
   give them, and an app's commands, typed with one `Tx`, could not run on a
   memory journal without loosening that type everywhere. PGlite in memory
   (`openJournalDb` in `@arki/journal/testing`) already runs the journal with
   no server and the same commands. What shipped: `src/store.ts`, one
   Postgres store built once per journal, `bind(db)` giving rows, events,
   receipts, jobs and wake. Its types are inferred from the implementation;
   slice 6 writes the `EventLog` interface when a second log exists. The
   row insert's unique violation is `CONFLICT` for every entity now, not
   only transient ones.
5. **Docs.** `packages/journal/AGENTS.md` Law 1 becomes: "One change is one
   table row and, when the entity's events are stored, one immutable event row,
   written in one transaction." Update README (including `adopt`),
   `llms.txt`, `docs/agent-guide.md`, the `journal` skill, and a minor
   changeset.

### Behaviour to document

- **Delete, then create again.** With history, a create after a delete
  continues the version count, and only if the log says the entity is gone
  (`src/write.ts:214-217`). Without history, any create on a missing row
  succeeds and `version` restarts at 1. So `version` counts one row's
  lifetime, not the entity id's.
- **`seq`** is "global write order", not a pointer to a stored row.

## 6. Questions

- **Q-1 Names (answered, founder).** `events: 'stored' | 'transient'`. It
  names the thing that changes: events are kept, or only passed in memory to
  projections and effects. (Rejected: `store: 'row'`, since the row is stored
  in both modes; `history: 'none'`, the review's pick.) No new error code: setup
  refusals use `BAD_DEFINITION`, runtime refusals use `NO_HISTORY`. Memory
  runner: `@arki/journal/memory`, `memoryStore()` (dropped, see slice 4).
- **Q-2 `seq` (answered).** Take it from the events table's own sequence in
  one round trip (`nextval` over `generate_series(1, n)`; the sequence name
  comes from `getTableConfig(tables.events)`, as `src/journal.ts:252`
  already does). `causeSeq` has no FK (`src/pg.ts:47`), so a seq with no row
  is safe. `RecordedStamp.seq` stays `number`. The memory store uses a
  counter.
- **Q-3 Switching (answered).** `adopt` does not cover it today; slice 3
  extends it.

## 7. Review (2026-10-22)

A blind Fable review checked every claim in sections 2 and 3: all confirmed.
It changed the plan in seven places. This session re-opened the four that
matter most:

1. Keep the advisory lock in both modes. Checked: the comment at
   `src/write.ts:152-154` says it fixes lock order to prevent deadlocks.
2. Map the create race to `CONFLICT`. Checked: `saveReplayed` has no
   unique-violation handling (`src/storage.ts:113-115`).
3. `adopt` needs extending for the switch. Checked: it refuses a row whose
   version is not 0 (`src/write.ts:202`).
4. Reuse `NO_HISTORY`. Checked: it exists (`src/errors.ts:13`) and history
   already throws it (`src/history.ts:208`, `:214`).

Also adopted, not re-checked: effect `args` go through `decodeStoredEvent`;
refuse `rerun`; Foreman detail and archive replay read `args`; setup
refusals ship with the setting (old slice 3 merged into slice 2); split the
storage seam by concern; the memory store refuses all projections rather
than guessing which ones use Drizzle; upgrade note for the constraint change.

Astra (a different model family) can re-run the same brief after
2026-10-27 for a second opinion.

## 8. Pluggable event stores (added 2026-10-22)

The founder's follow-up: events can live in any store, such as another
Postgres database, MongoDB, KurrentDB (formerly EventStoreDB), or a custom
append-only store. Inputs: three more Fable reports from the same day
(interface from every event read site; store research; write paths and
failure points). Then a blind review (8.9).

### 8.1 The core problem

Today the event and the row commit in **one Postgres transaction**. That only
holds when both live in the same database. Any other store means a second
connection and no shared transaction. So each store must say which write is
the truth.

### 8.2 Decisions

- **D-4 Two consistency models.**
  - **same-transaction:** the store writes inside the row's transaction.
    The built-in Postgres log (`'stored'`), a store in another schema of
    the same database, and the in-memory store.
  - **forwarded:** the row, inline projections, effect jobs and a
    `forward` job (carrying the events) commit in the app's database. A
    worker appends to the store later. The row is always right; the store
    lags.

  The adapter says whether it **can** join the row's transaction
  (`canJoinTransaction`). The journal chooses: a store that can join may
  still be forwarded (for example, a same-database schema on purpose).
- **D-5 Store-first is out of this RFC.** Append to the store first, then
  write the row. In this row-first write path it is a hack:
  - It holds the global append lock (`src/write.ts:50-60`) across a network
    call, so a slow store stalls every journal write.
  - It loses the receipt (the cached result) if Postgres fails after the
    append.
  - A refusal after the append can't be rolled back.
  - A command can write only one entity.
  - It needs a self-healing step on every load.

  The clean version flips ownership: the store is the truth and Postgres is
  a projection rebuilt from it. That gets its own RFC later.
- **D-6 First adapters:** another Postgres database, MongoDB, KurrentDB, and a
  published adapter contract with a test suite for custom stores.

### 8.3 The interface

Every read and write of `journal_events` outside `workflow/` comes down to
six operations. The review counted 20 call sites, all covered. They are
`src/write.ts:193`, `:271-285`; `src/history.ts:182-195`, `:340`,
`:359-365`, `:390-398`; `src/worker.ts:544-549`, `:616`, `:671-680`. After
slice 1, the job and Foreman reads use `args` instead.

```ts
// Proposed names; founder picks.
type EventsTable = JournalTables['events'];
type StoredEvent = EventsTable['$inferSelect']; // decodeStoredEvent's input today
/** One shape for both models: `seq` and `recordedAt` come from the app database first. */
type EventToAppend = Omit<StoredEvent, 'erasedAt'>;
type Position = string & { readonly __brand: 'EventLogPosition' }; // opaque, per store

type EventLogReads = {
  stream(kind: string, entityId: string,
    filter?: { types?: readonly string[]; afterVersion?: number; limit?: number }): Promise<readonly StoredEvent[]>;
  highestVersion(kind: string, entityId: string): Promise<number>;
  /** Only when the store has a global order. Absent → async projections and rerun refused. */
  readonly all?: {
    after(position: Position | null, filter: { kinds?: readonly string[];
      types?: readonly string[]; limit: number }): Promise<{ events: readonly (StoredEvent & { position: Position })[]; next: Position | null }>;
    top(): Promise<Position | null>;
    /** Optional: how many events lie between two positions (Postgres can; others may not). */
    distance?(from: Position | null, to: Position | null): number;
  };
};
type EventLogWrites = {
  /** All or nothing. Same event ids again → success. A taken version with other ids →
   *  JournalError('FORWARD_DIVERGED') for forwarded, 'CONFLICT' for same-transaction. */
  append(batch: { kind: string; entityId: string; expectedVersion: number;
    events: readonly EventToAppend[] }): Promise<void>;
  /** Only when events can be rewritten in place. Absent → forget refused. */
  erase?(at: Pick<StoredEvent, 'kind' | 'entityId' | 'version'>,
    patch: Pick<StoredEvent, 'data' | 'schemaVersion'>): Promise<void>;
};
type EventLog = EventLogReads & EventLogWrites & (
  | { readonly canJoinTransaction: true; bind(tx: DbHandle): EventLogReads & EventLogWrites }
  | { readonly canJoinTransaction: false }
);
```

- **Read-your-writes.** A store that joins the transaction exposes
  `bind(tx)`. `write`, `forget` and `repair` always use the bound log.
  `forget` reads history on its own transaction (`src/history.ts:340`) and
  then repairs on it (`:369`). A log bound to the root handle would miss the
  uncommitted erasure, and on PGlite (one connection) it could hang.
- **One `seq`.** `seq` and `recordedAt` are assigned in the app database
  (`nextval`, Q-2) before any append, in both models. The built-in log
  inserts with an explicit `seq`. So one `EventToAppend` type serves both.
- **Retry rule in one place.** The adapter's `append` is idempotent and
  atomic. The worker only retries. The contract suite proves both.
- Types are written once: inferred from `tables.events`. Every reader keeps
  calling `decodeStoredEvent`, so upcasters apply to every store.
- Each adapter parses what it reads with the one stored-event Zod schema
  from slice 1 (A-39).
- **Positions.** `Position` is the store's own cursor; `seq` stays the app
  database's write order. `journal_cursors` stores a text position
  (migration of existing numbers). `cursors().lag` (`src/worker.ts:620`)
  becomes `behind: boolean` plus `distance` when the store offers it.
  `reset` (`:608`) writes `null`. `rerun` takes `after: Position`.
- Projections and rerun read one log. `compose` refuses handlers whose
  entities use different logs (`BAD_DEFINITION`).

How an app picks a store:

```ts
initJournal({ tables, events: 'stored' });                 // built-in same-transaction log
initJournal({ tables, events: 'transient' });              // no log
initJournal({ tables, events: kurrentEvents({ client }) }); // forwarded
j.entity('order', orders, { events: mongoEvents({ db }) }); // per-entity override
```

### 8.4 The forwarded write path

- **Job.** New `journal_jobs` kind `forward`, a third branch of the check at
  `src/pg.ts:103-106`: `args` set, no `effect`, no `job_name`. One job per
  write per entity. `args` = the events in the slice 1 stored-event shape.
- **Ordered streams for any job.** Two new real columns, `stream` and
  `stream_position` (an int), with an index on `(stream, stream_position)`.
  Any job kind may set them. The claim rule in `claimOne`
  (`src/worker.ts:120-141`) gains one generic clause: a job with a `stream`
  is claimable only if no job in the same stream with a lower
  `stream_position` is still in the hot table. A forward job sets
  `stream = kind/entityId` and `stream_position = expectedVersion`. Queue
  jobs get per-key order for free. Order is by position, never by
  `enqueued_at`: a retried or replayed job has a later timestamp.
- **The store-version ladder.** Before appending, the worker reads
  `highestVersion` from the store:
  - **lower** than `expectedVersion`: an earlier batch is missing. Requeue
    with a delay; never mark dead.
  - **equal:** append.
  - **higher:** the adapter's idempotent `append` acks it if the event ids
    match. Otherwise it raises `FORWARD_DIVERGED`.

  The same ladder makes an archive replay (`src/outbox.ts:759-784`) safe.
- **Purge.** `purgeDead` (`src/outbox.ts:728-737`) skips a job that still has
  a later job in its stream. Otherwise the purge would let the later job
  through past a gap.
- **Diverged streams.** `FORWARD_DIVERGED` means a second writer touched the
  store, which the row's version check should prevent. The operator path:
  - `discard` of a forward job is allowed only when the store already holds
    that version (checked inside `discard`, `src/outbox.ts:555-575`).
  - A new `reconcile(entity, id)` rebuilds the row from the store. This is
    `repair` reading from the store.
- **Write-path checks.** `highestVersion` and log-says-gone
  (`src/write.ts:193`, `:215-217`) read a log that lags. For forwarded
  entities the writer skips them, as for `'transient'`, and relies on the
  row's version check and the slice 2 `CONFLICT` mapping.
- **forget.** Refused with `FORWARD_PENDING` while a forward job for the
  stream is in the hot table. Otherwise the pending job would append the
  un-erased data later. When it runs, it also patches `args` in the hot
  effect jobs and the archive for that stream. Docs must say that the job
  archive holds event data (7 days by default).
- **Lag.** `forwardLag()` reports pending forward jobs and the oldest age,
  next to `cursors` (`src/worker.ts:613-624`). Tests can call
  `awaitForwarded(entity, id, version)`. Effects run from the in-memory
  event, so they may run before the store has it; document this.

### 8.5 Features by model

| Feature | stored (same-transaction) | forwarded | transient |
| --- | --- | --- | --- |
| Row, version check, inline projections, receipts | works | works | works |
| Effects | works | works (event in `args`) | works |
| replay / verify / repair, audit | works | works with lag; refused with `FORWARD_PENDING` while jobs are pending | refused |
| Async projections, rerun | works | works with lag, only if the store has `all` | refused |
| Taps | works | refused (driven by the `pg_notify` seq range and `journal_events`, `src/write.ts:406`, `src/worker.ts:670-674`); cursor-driven taps can be a later slice | refused |
| forget | works | only if the store has `erase`, and no forward job is pending | refused |
| Durable workflows | works | `workflow.run` always uses the built-in log | same |
| adopt | works | works on an empty log (enqueues a forward job) | slice 3 |
| Kapodopera admin event browser | works | empty for forwarded entities (reads `journal_events` directly) | empty |

### 8.6 Adapters

| Store | Append with expected version | Global order (`all`) | `erase` | Traps |
| --- | --- | --- | --- | --- |
| Another Postgres database | unique `(kind, entity_id, version)` + unique `id`, one transaction per batch | yes: a position cursor plus an `xid8` visibility horizon (`pg_current_xact_id()`, read only `transaction_id < pg_snapshot_xmin(pg_current_snapshot())`) | yes | No append lock there, so bigserial order is not commit order without the horizon. |
| KurrentDB (`@kurrent/kurrentdb-client` 1.3.1) | `appendToStream` with `streamState` (`NO_STREAM` / revision; revision = version − 1); a batch is atomic | yes, `$all` | no (only rewrite + scavenge on every node) | Stream name `kind-entityId`; `kind` must not contain `-`. Its event-id dedupe is best effort, so the adapter reads back on conflict. Do not use the old `@eventstore/db-client` (6.2.1, still on npm). |
| MongoDB (`mongodb` 7.7.0) | must be atomic per batch: Emmett's one document per stream, or one document per event inside a replica-set transaction | not built in: change streams (lost after the oplog window) or a counter document (serialises writes) | yes | Pick the batch layout and the global-order option before slice 10. |
| Custom | the contract in 8.3 | optional | optional | Kafka can only receive forwarded events (no expected-version append, no per-stream read). S3 can be a store with conditional writes. |

The adapter contract ships as a test suite (proposed
`@arki/journal/testing` → `eventLogContract(adapter)`). It covers expected
version, all-or-nothing batches, idempotent retry by event id, the
lower/equal/higher ladder, stream order, `all` order, and `bind(tx)`
read-your-writes. Every adapter, the built-in one included, must pass it.
MongoDB and KurrentDB adapters ship as separate packages so the core takes
no driver dependency (names proposed: `@arki/journal-mongodb`,
`@arki/journal-kurrentdb`).

### 8.7 Switching an entity's store

Not `adopt`. `adopt` covers an empty log only.

- `'stored'` → forwarded with N events: the first forward job expects
  version N, the store is at 0, and the ladder parks it forever.
- forwarded → `'stored'`: the row is at N and the built-in log is empty. The
  next write inserts version N+1 with a gap, and replay is wrong.

So a switch is a migration: a `copyLog(from, to)` tool, run while writes to
those entities are paused, then flip the setting.

### 8.8 Slices (after section 5's slices 1–5)

- **Slice 6: `EventLog` seam.** Move the built-in log behind the interface,
  with `bind(tx)`. `seq` assigned before the insert. `journal_cursors`
  position becomes text, with an upgrade note (a schema change). Contract
  test suite, run against the built-in log.

  **Done (2026-10-23).** Names as proposed in 8.3 (founder). Four changes
  from 8.3, found while building it:
  - A log that joins the transaction has no connection of its own, so its
    methods exist only through `bind(db)`. The top-level methods belong to
    a log that cannot join. `logOn(log, db)` picks.
  - `erase` returns `{ erasedAt }`: `forget` copies the stamp into the
    effect jobs' `args`, and a second erase keeps the first stamp.
  - `EventLogPosition` is a Zod brand, so the schema is the type's source.
  - Taps keep reading by seq range, through the built-in log's own
    `seqRange`: the wake signal carries seqs, and 8.5 refuses taps on other
    logs.

  The interface and the contract suite (`src/event-log-contract.ts`, the
  `@arki/lock` shape: plain `{ name, run }` cases, `ContractSkip`) stay
  internal until slice 7b lets an app pass a log. Only `EventLogPosition`
  and `ProjectionCursor` are public, because `cursors` and `rerun` name
  them. The built-in `append` uses one `insert ... on conflict do nothing`:
  a short insert is a repeat (success) or a taken version (`CONFLICT`, after
  removing what it inserted). On the root database it opens its own
  transaction. It keeps the entity id read-back check.
- **Slice 7a: Ordered job streams.** `stream` and `stream_position` columns
  for any job kind, the generic claim clause, the `purgeDead` rule, the
  `forward` job kind, and the lag API.
- **Slice 7b: Forwarded write path.** The store-version ladder, the
  write-path skips, the diverged operator path (`discard` check,
  `reconcile`), `forget` with forward jobs, and the refusals in 8.5 (taps
  refused).
  **7a and 7b done together (2026-10-23, founder).** Alone, 7a's parts had
  no producer. What shipped, and where it differs from 8.4:
  - A forward job names its entity kind in `job_name`, so every name
    column (Foreman counts, stranded jobs, logs) works unchanged; the
    stream is `kind/entityId`.
  - A create on a missing row continues the version count. The writer
    takes it from the last pending forward job of the stream, and from
    the log's `highestVersion` only when none is pending. A job leaves
    the table only after its append, so this order misses nothing. Cost:
    on that path, one log read under the append lock. 8.4 said the writer
    skips the log read entirely; that would restart at version 1 and
    diverge. Log-says-gone stays skipped for forwarded entities.
  - No `reconcile` verb: once the dead job is discarded, `repair` reads
    the entity's own log, so the two verbs cover it.
  - No `awaitForwarded`: tests drain; `forwardLag` gives
    `{ pending, dead, oldestEnqueuedAt }`.
  - A log that can join is always written in the transaction. Forwarding
    one on purpose is not offered yet.
  - `forget` also erases the event in archived forward jobs of the stream.
    The archive sink gets only the event headers.
  - The interface is public now, with `eventLogContract` at
    `@arki/journal/event-log-contract`.
  - The tests use the built-in log on a second PGlite, as a log that
    cannot join. That is close to slice 8. The order it offers through
    `all` is only safe while one worker appends, so slice 8 still needs
    its own global order (8.10).
  - `llms.txt` went over its 8 KiB budget, so `arki-llms` switched its
    import paths to the short grouped form.
- **Slice 8: Another Postgres database adapter**, plus `copyLog` (the first
  place a store switch will be tried). Cheapest end-to-end check of 6–7.
- **Slice 9: KurrentDB adapter.**
- **Slice 10: MongoDB adapter**, after picking its batch layout and global
  order.

### 8.9 Review (2026-10-22)

A blind Fable review checked section 8. Every file:line claim was confirmed;
a few line numbers were off by two, and are corrected above. The adapter
facts were checked against current docs and npm. This session re-opened the
three findings that changed the design:

1. Purging dead jobs breaks per-stream order. Checked: `purgeDead` removes
   dead jobs by age (`src/outbox.ts:730-737`). Fix: the ladder and the purge
   rule in 8.4.
2. Same-transaction reads need the transaction. Checked: `forget` reads and
   repairs on `tx` (`src/history.ts:340`, `:369`). Fix: `bind(tx)` in 8.3.
3. Taps cannot follow a forwarded entity. Checked: taps read
   `journal_events` using the `pg_notify` seq range (`src/write.ts:406`,
   `src/worker.ts:670-674`). Fix: refused in 8.5.

Also adopted, not re-checked:
- `forget` with pending forward jobs, and job `args` holding event data.
- The diverged-stream operator path.
- Atomic batches in the contract.
- Store switches as a `copyLog` migration.
- One `EventToAppend` type.
- `canJoinTransaction` on the adapter, with the journal choosing.
- Text positions for `lag`, `reset` and `rerun`.
- Ordering by `stream_position`.
- The ordered-stream claim made generic for any job kind, so no
  kind-specific special case sits on the generic claim.
- The `xid8` wording fix.

### 8.10 Notes for later

- **Crypto-shredding.** "forget" is one SQL update in Postgres and almost
  impossible in KurrentDB or Kafka. It also has to chase event data into
  job `args` and the archive. Encrypting each entity's event data with its
  own key, and deleting the key to forget, works the same everywhere.
  Candidate follow-up.
- **Checked in code:** the claim that today's `seq` cursor can skip events is
  wrong for the built-in log. The append lock makes `seq` order equal commit
  order (`src/write.ts:50-56`). It is right for any external Postgres store.
- **Cursor-driven taps** for forwarded entities, if wanted.
