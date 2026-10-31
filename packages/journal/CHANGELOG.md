# @arki/journal

## 0.4.0

### Minor Changes

- 8e6970d: Events in KurrentDB: `kurrentEvents({ client, prefix? })` from the new `@arki/journal/kurrentdb`, with `@kurrent/kurrentdb-client` as an optional peer.

  - One entity is one stream, `<kind>-<entityId>` (a kind must not contain `-`). `prefix` puts all of the log's streams under one name.
  - The event's type and data are KurrentDB's fields; the rest of the journal event is in its metadata under `journal`. Event ids are UUIDv5s of the journal ids, so a retried append repeats them.
  - Appends use the stream's expected revision. A repeat KurrentDB does not recognise is read back and acked.
  - `all` reads `$all` (commit order), with `"commit:prepare"` positions. `forget` is refused: KurrentDB cannot rewrite an event.

- f49d490: `events: 'stored' | 'transient'` on `initJournal` (the journal default) and `j.entity(kind, table, { events })` (per entity). A transient entity keeps no `journal_events` rows: the write still takes the append lock, checks `expectedVersion`, folds, saves the row, runs inline projections and queues effect jobs, and the events it returns carry a real `seq` from the events table's sequence. Workflow runs always store their events.

  - `replay`, `verify`, `repair`, `forget`, `adopt` and `rerun` throw `NO_HISTORY` for a transient entity; an async projection or a tap on one is `BAD_DEFINITION` at `compose`.
  - Two creates of one transient id that race end in `CONFLICT`, mapped from the row's unique violation.
  - After a delete, a transient entity's next create starts at version 1 again.
  - Schema: `journal_jobs_kind_check` no longer requires `event_seq` on effect rows, and the partial unique index `journal_jobs_effect_event_id_unique` on `((args->>'id'), effect) where kind = 'effect'` is new. Generate a migration (`drizzle-kit generate`); both statements are additive. See `docs/upgrades/0.3.0-to-0.4.0.md`, step 7.
  - `EntityDef.eventStorage` and the type `EventStorage` are new exports.

- 7c10c0a: `.parallel(name, { [branch]: b => ... }, { wait: 'all' | 'any' })` runs branches side by side as child runs of their own definitions. `'all'` gives the outputs by branch name. `'any'` gives `{ branch, result }` of the first to complete, cancels the others, and completes after each has stopped. A signal for the parent reaches every branch that waits for it, an event wait in a branch counts from the parent's start, and each branch run counts its own transitions. A branch can declare `b.output(schema)`; when every branch does, `def.read` types and checks the node. Existing node kinds keep their shape hashes, and old `ChildrenPlanned` events and running `.map` runs replay unchanged.
- ce53dcc: `limits.transitions` is enforced. It was declared (default 1000) and nothing read it, so a loop could run without end. New column `workflow_runs.transitions`, so an app generates a migration and backfills its open runs (the upgrade note has the SQL).

  - A transition is the first try of a node. Each visit of a node in a loop counts, and so does a node its `when` skips. A retry and an undo do not. The count is written by the event that schedules the node, so it survives a crash and a restart.
  - A node that would pass the cap does not run. The run compensates, as it does for a deadline, and ends `failed` with the new failure `WorkflowTransitionLimit` (`journal.workflow_transition_limit`, with `data.limit` and `data.transitions`). `onDeadStep` does not apply: a loop that must stop does not wait for an operator.
  - A workflow whose healthy run passes 1000 transitions now fails: set `limits: { transitions }` above `rounds * nodes in the loop`.

- 14b61bb: Events in another Postgres database, and store switches.

  - `postgresEvents({ db, tables })` from the new `@arki/journal/postgres` is an event log in a second Postgres database. Its table comes from `eventLogTables(schema?)` in `@arki/journal/pg`: `journal_events` with the app's `seq` and a `transaction_id xid8` column. Its entities are forwarded. It offers `all` and `erase`, so async projections, `rerun` and `forget` work on it. `all` orders by `(transaction_id, seq)` and reads only below the oldest open transaction, so a reader never passes a row that commits later. Positions are `"transaction id:seq"`, with no `distance`.
  - `journal.copyLog(db, entity, { to })` copies an entity kind's events from the log it uses now into `to` (`'stored'` or a log), for a store switch. It is refused while forward jobs of the kind wait (`FORWARD_PENDING`) and onto the log the kind already uses (`BAD_DEFINITION`). It is safe to run again.

  The built-in `journal_events` table is unchanged: its columns now come from the same column list as `eventLogTables`.

- 84d246f: Workflow runs take a scope, tags and metadata when they start.

  - `def.start` takes `{ input, id?, scope?, tags?, metadata? }`. `scope` is the tenant or owner key of the run (1 to 256 characters). `tags` are up to 10 labels of 1 to 128 characters. `metadata` is a JSON object of at most 256 KiB. The limits are exported as `RUN_FIELD_LIMITS`, and the field type as `RunFields`.
  - A start outside the limits creates no run. A bad shape returns `InvalidInput`; metadata that is too large returns `CommandInvalid`, which `StartOutcome` now includes.
  - Each run stores `rootId`: null for a top run, else the id of the top run of its tree. A child run (`child`, `map`) takes its parent's `scope` and `rootId`, and no tags or metadata.
  - Starting an existing id under another `scope` is a `CommandConflict`.
  - `journal.workflows.run` and `journal.workflows.runs` return `scope`, `tags` and `rootId` (and `run` also `metadata`). `runs` filters by `tag`, `scope`, `rootId`, `from` and `to` (start time). The Foreman workflow console shows and filters by them too.
  - `workflow_runs` gets four columns: `scope`, `tags`, `metadata` and `root_id`, with an index on `scope`, a GIN index on `tags` and an index on `root_id`. Run `drizzle-kit generate` and apply the migration before you deploy. Runs started before keep working: their rows get no scope, no tags, empty metadata and no root.

- 4f41f91: `dot explain --as journal-flow` is now `dot explain --as event-map`, and the graph covers the whole flow. Breaking (0.x, no shims):

  - Renamed: the format `journal-flow` to `event-map`, `JournalFlow*` types to `EventMap*`, `JOURNAL_FLOW_*` constants to `EVENT_MAP_*`. The manifest projection loads `@arki/journal/event-map`.
  - New nodes: `command`, `entrypoint`. New edges: `writes` (command to event), `waits-for` (a workflow's `.waitFor` event), `runs` (a workflow's `.command` node, with `undo: true` for its `undo`), `calls` (a procedure file imports a command). A workflow node lists its `.step` names as `opaqueSteps`: a `ctx.run` inside a step is not drawn.
  - New Node-only entry `@arki/journal/event-map`: `project(manifest, cwd?)`, `scanEntrypoints({ root })`, and `checkEventMapFile({ file, mermaid, update? })`. The scan reads the procedure files under `src/features/**/entrypoints/**` (set `journal({ j, entrypointRoot })` for another root), follows relative imports, and keeps the exports that are journal commands. A command imported and never called is still an edge.
  - `@arki/journal/projection`: `project` is now `projectGraph(manifest)` and returns `{ document, entrypointRoot }` without the scan. New: `withEntrypoints`, `edgeKey`, and `eventMapMermaid(document)`, which prints Mermaid `flowchart LR` in a stable order. `render` also prints writers, workflow nodes, entrypoints and the files the scan could not read.
  - `checkEventMapFile` keeps a Mermaid file in an app's docs fresh: it returns the diff when the file is stale, and writes it when `update` is true.

  See the upgrade note (section 21).

- 8e5d9df: A workflow run can narrow how its steps run. `def.start` (and each `startBatch` item, and `journal.workflows.replay` overrides) takes `maxAttempts` (caps the tries of every step; the step's own `retry` still picks the wait and which errors retry), `timeout` (an age; each step attempt times out after it, or after the step's own `timeout` when that is shorter) and `priority` (the claim order of the run's step and timer jobs, on the scale of an effect's `priority`). A run keeps them for its whole life, a replay keeps them unless overridden, and a child does not inherit them. Bad values are `InvalidInput`. `RunOverrides` and `RUN_OVERRIDE_LIMITS` are exported, and the readers return `maxAttempts`, `stepTimeoutMs` and `priority`.

  An effect schedule's `priority` may be a function of the event (`priority: event => number`), like `runAt`, so each job gets its own priority. Each value it gives is checked to fit 32 bits.

  Migration needed: `workflow_runs` gets the nullable integer columns `max_attempts`, `step_timeout_ms` and `priority`. Run `drizzle-kit generate`. Old runs keep `null`.

- 8201ea8: A browser-safe `@arki/journal/contract` subpath, so an oRPC contract that ships to the browser no longer bundles Drizzle:

  - `@arki/journal/contract`: everything a contract needs: `COMMAND_FAILURES`, `CommandNotFound`, `CommandInvalid`, `CommandForbidden`, `CommandConflict`, `WorkflowStranded`, `WorkflowReadMismatch`, and the type `CommandFailure`.
  - `@arki/journal/errors` now takes the transaction failures from `@arki/db/errors` instead of `@arki/db/transaction`, so it no longer loads Drizzle either. Its exports are unchanged.

- 289ba73: The `dot dev` console shows an "Event map" page drawn from the same document as `dot explain --as event-map`: left to right from entrypoints to commands, events and consumers, click a node for its details and edges, filter by feature, search by name, scan problems in plain view, no network. `@arki/journal/event-map` exports `consolePage(document)`. No demo impact.
- 84d246f: A workflow step changes its run's metadata and tags while it runs: `ctx.metadata.set(patch)`, `increment(key, by?)`, `append(key, value)`, `remove(key)` and `ctx.tags.add(...tags)`, in a step or an undo. Each call commits at once as one event on the run (`MetadataChanged` with the `change`, or `RunTagged` with the new tags), so a reader sees the progress while the step still runs, and a replay rebuilds the row. A refusal (`CommandConflict` once the run has finished, `CommandInvalid` for a wrong value type, metadata over 256 KiB or more than 10 tags) is the value the call returns and does not fail the step. Operators make the same changes with `journal.workflows.setMetadata(db, { runId, change }, op)` and `addTags(db, { runId, tags }, op)`; the event records `op`. A call never rejects, so a progress report may be left un-awaited: it runs through the new `EffectContext.runUnwatched` (the attempt's fenced runner without the refusal watch), so a stale attempt writes nothing and a late refusal never fails the step. `workflow_runs` gets the column `field_changes integer not null default 0` (push the schema): it counts the metadata and tag events, and the Foreman workflow actions take their revision as `version - field_changes`, so progress reports no longer void an approval. New types: `MetadataChange`, `MetadataContext`, `TagsContext`, `MetadataOutcome`, `TagsOutcome`, `RunMetadata`.
- 0403c69: `@arki/journal/foreman` names no Zod in its types. Breaking:

  - `journalJobsModule` and `journalWorkflowsModule` return a plain `ForemanModule` from `@arki/admin`. The admin dispatcher reads their schemas at runtime, so registering them is unchanged; a read called on the returned object directly returns `unknown`.
  - The summary schemas `AttemptSummary`, `OperationSummary`, `ArchivedSummary` and `JobSummary` are no longer exported. Their types keep their names, written in TypeScript and locked to the internal schemas by a type test.

  See `docs/upgrades/0.3.0-to-0.4.0.md`, step 10.

- 8e5d9df: The public types of workflows no longer reach Zod, so the `.`, `./dot`, `./orpc` and `./foreman` declaration files pass `TYPES_E001` (A-43).

  - The types of starting and operating a run (`StartArgs`, `StartSchema`, `StartOutcome`, `StartBatchArgs`, `StartBatchSchema`, `StartBatchOutcome`, `WorkflowStarter`, `StarterOf`, `ReplayArgs`, `ReplayOverrides`, `RescheduleArgs`, `RescheduleOutcome`, `CancelArgs`, `CancelSchema`, `CancelOutcome`, `SignalArgs`, `SignalSchema`, `SignalOutcome`) moved from `workflow/runner.ts` to the new Zod-free `workflow/run-types.ts`. The schemas that check them stay in `runner.ts`, which no public declaration file reaches now.
  - The run field schemas (`runFieldsSchema`, `runTimingSchema`, `runOverridesSchema`, `delayAgeSchema`, `ttlAgeSchema`, `metadataChangeSchema`, `addedTagsSchema`) moved from `workflow/run-fields.ts` to the new internal `workflow/run-field-schemas.ts`. `run-fields.ts` keeps the types (`RunFields`, `RunTiming`, `RunOverrides`, `MetadataChange`, ...), the limits and the pure functions, and imports no Zod.
  - `StepStatus` moved from `workflow/machine.ts` to `workflow/states.ts`, next to `STEP_VIEW_STATUSES`.
  - No export of a package entry was removed or renamed: these are internal files, and the root still exports the same names. `schemas.test-d.ts` still locks every type to its schema both ways.

  Breaking: `WorkflowBusy.data.key` is now `string | null`. It is `null` for a start without a concurrency key (only a `total` limit can block one); it was `''`. A failure recorded before this change still reads, with `''`.

- 84d246f: Lifecycle hooks on a workflow or a task: `on: { success, failure, cancel, expired, complete }`. A run end queues one job of the new library-owned effect `workflow.on` in the transaction that ends the run, so a hook runs only after that commit, at least once, with the code of the run's own version. A throw is retried like an effect's; a returned failure is final; a hook never changes the run. Each hook gets the run (`runId`, `workflow`, `version`, `scope`, `tags`, `metadata`, typed `input`, `state`), `output` on `success` (typed by the `output` schema and checked again, `unknown` without one), `error` on `failure`, the job's `db`, `run` (records `workflowMeta` without a meta), `accept`, `signal`, `jobId`, `attempt`, and the definition's needs. `complete` runs for every end, after the specific hook. The effect is added only when a composed definition declares `on`.

  `journal.hooks.step.around((ctx, next) => ...)`, next to `command` and `effect`: wraps each step body and undo inside the `journal.step` span. `ctx` is `{ workflow, version, runId, step, attempt, phase }` (exported as `StepHookContext`); it is frozen by the first drain or worker. New exported types: `LifecycleHooks`, `LifecycleHookContext`, `RunEnding`, `StepHookContext`. `WorkflowDef` has a new `on` field, and `WorkflowOptions` a fifth type parameter (the host the hooks see).

- 270aa2e: The built-in event log sits behind one interface (`src/event-log.ts`): append, stream, highest version, a global order (`all.after`, `all.top`, `all.distance`) and erase, bound to the caller's transaction. Every write takes its `seq` and `recordedAt` from the app database before the append, in both event modes. A contract suite checks the built-in log; adapters for other stores will run the same suite.

  Breaking:

  - `journal_cursors.seq` (bigint) becomes `journal_cursors.position` (text, null at the start). Move the values with the SQL in `docs/upgrades/0.3.0-to-0.4.0.md`, step 8; the generated drop and add would send every async projection back to the start.
  - `journal.cursors(db)` returns `{ name, position, behind, distance }` instead of `{ name, seq, lag }`.
  - `journal.rerun(db, projection, { after })` takes an `EventLogPosition` (or `null`) instead of `afterSeq`. `EventLogPosition` and `ProjectionCursor` are exported from `@arki/journal`.

- bdfd204: Every effect job carries its event. The writer puts the stored `journal_events` row in the job's `args`; the worker, `journal.job` and the workflow runner read the event from there and never join `journal_events`. The copy is decoded as replay decodes a row, so upcasters apply to a job queued before a release. `StoredEventRow` from `@arki/journal/pg` parses `args` back to the row type. `forget` rewrites the copy in `journal_jobs` and `journal_job_archive` in the same transaction as the event row. The copy never leaves the database: the archive sink gets an effect row with only the event header in `args` (seq, id, kind, entityId, version, type, recordedAt), and the Foreman job module shows a payload for queue jobs only, even with `payload: 'redacted'`.

  Migration: `journal_jobs_kind_check` now requires `args` on an effect row. Drain pending effect jobs or backfill `args` from `journal_events` before the migration; the SQL is in `docs/upgrades/0.3.0-to-0.4.0.md`, step 6.

- 84d246f: Tasks, batches and replays for workflows. `j.task(name, options, run)` defines a workflow of one step named `run`: it is `j.workflow(name, options).step('run', run, { retry, timeout, undo, key }).finish()`, so a task is a `WorkflowDef` in every way, and its output is what `run` returns (or the `output` schema's output, which `run` must then return). `def.startBatch({ items, batchId? })` starts up to `BATCH_LIMIT` (1000) runs of one workflow in one transaction and returns `{ batchId, runs }`, one outcome per item: a refused item rolls back only its own savepoint, and an item that does not fit the start schema refuses the whole batch with `InvalidInput`. `journal.workflows.batch(db, batchId)` counts a batch's runs by state and lists their ids, and `runs(db, { batchId })` filters by it. `journal.workflows.replay(db, { runId, overrides? }, op)` starts a new run of a run's workflow at the newest version with the old input, scope, tags and metadata unless `overrides` replaces them; the new run records `replayOf` and the operator.

  Migration needed: `workflow_runs` gets the nullable columns `batch_id` (with the index `workflow_runs_batch_id_idx`) and `replay_of`. Run `drizzle-kit generate`. `RunStarted` may carry `batchId`, `replayOf` and the operator fields; older events replay with `null`.

- df44e0d: A workflow can continue on a step's failure, a caller can wait for a run's outcome, and `def.read` types more nodes.

  - `.step(name, body, { output, failures: [Declined], onFailure: 'continue' })` keeps a listed returned failure as the step's result and the run goes on. The result type is the output plus the failures. The failure is stored as its envelope and read back, by its own schema, as a real failure. Any unlisted failure still fails the step. `onFailure` needs `failures` and an `output` schema, or the definition throws `BAD_DEFINITION`.
  - A last node that can be a failure (a command with `accept`, a step with `onFailure: 'continue'`) now needs a function in `.finish`, and `.finish()` without one is a compile error. The `BAD_DEFINITION` throw stays as a backstop.
  - `def.settled(db, runId, { within })` returns the typed run once it ended, or the new failure `WorkflowPending { runId }`. `def.startAndWait(db, args, { meta, timeout, signal })` starts a run and waits: the output, `WorkflowRunFailed`, `WorkflowRunCancelled`, or `WorkflowPending`. Both take the root database (a transaction handle throws `BAD_ARGUMENT`), take seconds above 0 and at most 30, and never cancel the run. New failures: `WorkflowPending`, `WorkflowRunFailed`, `WorkflowRunCancelled`.
  - `def.read` checks and types a sleep (`null`), a `.child(name, def)` and a `.map` of a definition with an `output` schema. A stored value that no longer fits is `WorkflowReadMismatch`. A child chosen by a function stays `unknown`.

- 8e5d9df: Workflows: `concurrency: { onBusy: 'queue' }`. A start that a full or paused limit blocks creates the run in the new state `queued` (events `RunStarted` and `RunQueued`) with no node scheduled, and returns its `{ runId }`. A child may queue too; its parent stays parked. A queued run holds no slot: no limit counts it. When a run that held a limit ends, or an operator raises, resets or resumes a limit, or a key override runs out (a new `workflow.limitTimer` job at its `until`), the oldest queued runs that now fit are promoted in the same transaction (`RunDequeued` and the first `NodeScheduled`, due at `start_at` when a delay is still ahead), FIFO per key, checking at most `LIMIT_BOUNDS.promoteTries` (50) candidates per change. A queued run past its `ttl` ends `expired` through its timer job; `cancel` ends it `cancelled` at once; `reschedule` moves its start. `journal.limits.get` and `list` show `queued` next to `running`.

  The start gate now runs inside the start's write, after the journal's append lock, and a limit verb takes the limit lock inside its write: every path takes the append lock first and the limit locks after it, so a run end that promotes and a start that queues never deadlock.

  Apps need `drizzle-kit generate`: `workflow_runs` gets the partial index `workflow_runs_queued_idx` on `(started_at, id) where state = 'queued'`, and `state` may now be `queued`.

- e444104: Events can live outside the app database. `events` on `initJournal` and `j.entity` takes an `EventLog` besides `'stored'` and `'transient'`. A log that joins the row's transaction is written with the row. A log that cannot join is forwarded: the write commits the row, its projections and effect jobs, and one `forward` job with the write's events. The worker appends them to the log after the commit.

  - One entity's forward jobs form a stream (`stream`, `stream_position` on `journal_jobs`). A job is claimed only when no earlier job of its stream is left in the table. `purgeDead` keeps a dead job that later jobs of its stream wait behind. Any job kind can use the columns.
  - The worker reads the log's top first. Below the job's version, the job waits and never dies of waiting. Other events at its versions are the new `FORWARD_DIVERGED`, and the job dies at once.
  - `replay`, `verify`, `repair` and `forget` read the entity's own log, and throw the new `FORWARD_PENDING` while a forward job for the entity waits. `cancel` refuses a forward job. `discard` takes one only when the log already holds its versions.
  - `journal.forwardLag(db)` returns `{ pending, dead, oldestEnqueuedAt }`.
  - `compose` refuses a tap on a forwarded entity, an async projection whose entities live in different logs, and one on a forwarded log with no global order. One entity kind has one log.
  - `EventLog` and its parts are exported from `@arki/journal`, and the adapter conformance suite from `@arki/journal/event-log-contract` (`eventLogContract`, `ContractSkip`). `JOB_KINDS`, `JobKind` and `ForwardArgs` are exported from `@arki/journal/pg`.

  Migration: two columns, a check branch and an index on the job tables, all additive. See `docs/upgrades/0.3.0-to-0.4.0.md`, step 9.

- a1da735: Public types no longer name Zod (`TYPES_E001`). Breaking:

  - The schemas that decode stored values move to the new `@arki/journal/zod` entry and take `xSchema` names: `storedEventRowSchema` and `forwardArgsSchema` (were `StoredEventRow` and `ForwardArgs` in `@arki/journal/pg`), and `eventLogPositionSchema` (was the `EventLogPosition` value in `@arki/journal`). The types keep their names and places.
  - `EventLogPosition` is a TypeScript brand (`string & { readonly [brand]: true }`) made only by `eventLogPositionSchema`, which `z.custom` builds on a `z.string().min(1)` check.

  See `docs/upgrades/0.3.0-to-0.4.0.md`, step 10.

- 84d246f: Workflow runs can start later and give up waiting. `def.start` takes `delay` (an age such as `'5m'`, or a `Date`) and `ttl` (an age). A delayed run's first node is due at the planned start, and the readers show `delayedUntil`. A run whose first node has not started `ttl` after it was due ends in the new state `expired` without running, and frees its concurrency slot. `journal.workflows.reschedule(db, { runId, delay } | { runId, at }, op)` moves a start that has not happened. Retention has `workflows.expired` (default: the `failed` time).

  Migration needed: `workflow_runs` gets the nullable columns `start_at`, `ttl_at` and `ttl_ms`, and `state` may now hold `expired`. Run `drizzle-kit generate`. Code that lists the end states must handle `expired`.

- ce53dcc: A workflow can wait for one of the app's own events. New table, so `ExportsEveryJournalTable` stops compiling until `workflowWaits` has its export (0.x, no shims).

  New:

  - `.waitFor(name, { on: { [label]: { entity, events, match, where? } }, timeout | until, onTimeout, when? })` parks a run until an entity records one of the events. The result is `{ via: label, event }`, and narrowing `event.type` types `data`. `match` must return the entity's id type and `events` must belong to the entity: both are compile errors. With `onTimeout: 'continue'` a deadline gives `null`, so a wait doubles as a sleep an event cuts short. The signal form stays.
  - No lost wake-ups: a parked wait writes rows in the new `workflow_waits` table, and the library effect `workflow.wake:<entity kind>` is mounted for each entity a wait watches. Park and wake take a lock on the correlation key, and the park reads the log, so whichever commits second sees the other.
  - An event counts from the run's admission, so one recorded before the worker reaches the wait is kept. A revisit in a `next` loop reads on from the last event that wait took, one event is taken once per run, and a deadline and an event contend on one run transition. `WaitEventTaken` records each take, with the event id as `deliveryId`.
  - An event wait stores a pointer to the event (`{ via, seq }`), never a copy, so `forget` on the entity reaches every run that took its events, parked, running or finished. An event with an `erased` form reads in that form. `results.x`, `def.read` and the operator views keep their types.
  - `.sleep(name, until, { next })` loops, as a step's `next` does.
  - `workflowHarness` gains `tickTo`, `dueJobs` and `release`, so a test runs due jobs one by one. `workflowHarnessOn(db, { setup })` runs it on a database the test opened, such as a real Postgres.

  An event wait is a new node kind, `eventWait`, and its `on` joins the shape hash, so changing it needs a new version. Shape hashes of existing node kinds do not change. A run whose shape has no event wait never touches `workflow_waits`. The upgrade note names the migration step.

- 8e5d9df: Foreman can change runs and limits. `journalWorkflowsModule` gains the actions `workflow.setMetadata` and `workflow.addTags` (permission `workflow:metadata`, low risk), `workflow.reschedule` (`workflow:reschedule`, medium), `workflow.replay` (`workflow:replay`, medium), and `workflow.limits.pause`, `.resume`, `.override` and `.reset` (`workflow:limits`, high), plus the reads `workflow.limits.list` and `workflow.limits.get` (`workflow:read`). Each verb has its own permission, so an operator who may tag runs may not replay them or pause a limit. Every action previews what it will do and refuses a stale approval with `ARKI_JOURNAL_E010`. A run action's approval is taken on the run's revision, which metadata and tag changes do not move: two metadata actions in a row both apply, and neither voids a cancel. A limit action's approval is taken on the limit's version, which runs that take a slot do not move. The newer actions answer the journal's own refusals with their codes, statuses and data (`journal.workflow_busy` for a replay at a busy key, `journal.conflict` for a reschedule of a run that has started).

  The run reads show `batchId`, `replayOf`, `startAt`, `maxAttempts`, `stepTimeoutMs` and `priority`, and `workflow.runs` filters by `batchId`. `LimitView` gains `version`: the `journal.limit` entity's version, 0 until an operator first changes the limit. No migration.

- 84d246f: Workflow `concurrency` now works, and commands, effects and workflow steps emit OpenTelemetry spans.

  - `concurrency: { key, limit, onBusy }` was typed but never applied: every run was stored with a null key. A start now counts the unfinished runs with its key, under a transaction-scoped advisory lock. At the limit, `onBusy: 'refuse'` returns the new failure `WorkflowBusy` (`journal.workflow_busy`, exported from `@arki/journal`, `./errors` and `./contract`), and `'join'` returns the oldest running run. A child start that is busy is always `WorkflowBusy`. `def.start` now has `WorkflowBusy` in its result type.
  - Breaking for the schema: the unique index `workflow_runs_concurrency_unique` becomes the plain partial index `workflow_runs_concurrency_idx`, so a `limit` above 1 can hold. Generate a migration (`drizzle-kit generate`) after upgrading.
  - Spans `journal.command`, `journal.effect` and `journal.step`, with the tracer `@arki/journal`. Outcomes are classified as `ok`, `failure` (with `failure.code`) or `defect`; no payload is an attribute. New dependency: `@opentelemetry/api`.

- 88daaeb: `infra.fromFeatures` and `entrypoint.fromFeatures` take one declaration, the same one `infra()` and `entrypoint()` take, instead of a callback `features => unit({...})`. Breaking: rewrite each callback (`docs/upgrades/0.7.0-to-0.8.0.md`, step 6).

  - Every `provides` factory and lifecycle hook also gets `$features`, the app's mounted features, and `$state`, what the declaration's new `state()` returned for this app. The builder calls `state()` once per app, so two apps built from one binder never share a worker, a timer or a server. Without `state`, `$state` is `undefined`.
  - `actions` may be a function of the mounted features.
  - The binder has a static `name` and typed `provides` handles, so a feature needs a `fromFeatures` service by handle: `entrypointOnly(appJournal.provides.journal)`. A misplaced binder is reported by its name, not `infra.fromFeatures(...)`.
  - New types: `FromFeaturesDefinition` and `FeaturesContext` (`@arki/dot/unit`, `@arki/dot/feature`). `UnitBinder` gains `name` and `provides`.
  - `@arki/journal`: `journal({ j })` exposes `provides.journal`; `JournalDriven` is inferred from it. `journalWorker()` keeps its worker in `$state`.
  - `@arki/schedule`: `schedule(...)` exposes `provides.scheduler`.
  - `@arki/queue` (`queueWorker`) and `@arki/http` (`http`) keep their per-app runtime in `$state`. No change for their callers.

  docs: `packages/dot/docs/unit-authoring.md` (Units built from the features), `composition-doctrine.md`, `di.md`, the upgrade note; `@arki/journal` README; `@arki/schedule` `docs/reference/dot.md`.
  no demo impact: no demo calls `fromFeatures` directly.

- cb5b666: Durable workflows. A workflow is a list of steps that runs to the end even when the process dies. Each step runs as a job in `journal_jobs`, and its checkpoint (the result, and the next step scheduled) commits in one transaction. Use it for work that must survive a restart or waits for hours or days. A loop of steps inside one request stays `createFlow` from `@arki/ai`, which is in memory and not durable. See the README chapter Workflows and the agent guide.

  - `j.workflow(name, { version, input, output?, needs?, deadline?, concurrency?, onDeadStep?, retention?, limits? })`, then `.step`, `.waitFor`, `.sleep`, `.child`, `.map` and `.finish`. Step results are inferred: a later step reads `results.<name>` typed. Step options: `undo`, `output`, `key`, `retry`, `timeout`, `when` (skip; the result is `R | null`) and `next` (jump back to an earlier node). `waitFor` takes `when` too: false skips the wait without parking, and its result is `payload | null`, in `results` and in `def.read`.
  - `startOn: { entity, event, id, input }` on `j.workflow` starts a run when the entity records the event: a runner-owned effect `workflow.start:<name>`, whose job is written in the event's transaction, starts it once with `workflowMeta` at the highest version; an id that already has a run starts nothing. `id` and `input` are typed from the entity's key and the event's data, and `input` is checked against the workflow's input. Only the highest registered version may declare `startOn` (`BAD_DEFINITION`).
  - `compose({ workflows, workflowMeta })` registers them, once per `initJournal()`. It adds the effects `workflow.step` and `workflow.timer`. `workflowMeta` is recorded on the runner's checkpoints, and on each command a workflow body runs with `ctx.run(command, input)` and no meta. A body may still pass its own meta. An effect's `ctx.run` (`RootCommandRunner`) still requires one.
  - A finished definition has `def.start` (`{ input, id? }` → `{ runId }`, idempotent on `id`), `def.signal(name)` (`{ runId, deliveryId, payload }` → `woke`, `kept`, `duplicate`, `finished` or `no-run`; `no-run` is a signal to a run that does not exist or belongs to another workflow, which stores nothing and does not fail, so a webhook is not resent forever), `def.cancel` (`{ runId, reason }`) and `def.read(db, runId)`, which reads a run back typed and returns `WorkflowReadMismatch` (`journal.workflow_read_mismatch`) when a stored value no longer fits its schema.
  - Failure and compensation: a thrown error retries with the step's `retry`, or the default (8 tries); a returned failure kills the step unless that `retry`'s `while` accepts it. `onDeadStep: 'wait'` (default) leaves a dead step for an operator; `'compensate'` undoes the finished steps, newest first. A step without `undo` is listed in `residual`. A cancel compensates the same way. A wait the run was parked on when compensation began is dropped and leaves no result.
  - Versions: new runs start the highest registered version; older versions only finish their runs. A run whose code is missing or has other nodes is stranded and never runs the wrong step.
  - Operators: `journal.workflows.runs`, `run`, `counts`, `stranded`, `history`, and the verbs `retryStep`, `resolveStep`, `skipUndo`, `signal`, `cancel` and `checkResult`. `journalWorkflowsModule` in `@arki/journal/foreman` serves them in Foreman (`ARKI_JOURNAL_E010` to `E017`).
  - Dot: `journalHandlers({ workflows })`, `journalWorkflows(core, defs)` for `defineFeature`, and `journal({ j, workflowMeta })`. A step gets the services of the feature that lists its workflow.
  - Testing: `workflowHarness({ setup })` in `@arki/journal/testing`, with `tick`, `drain`, `crash` and `close`.
  - Every effect context has `attempt`. An effect whose job lease was lost gets `LEASE_LOST` from `ctx.run`, and nothing it runs is written.
  - `EffectSchedule.when(event)`: an effect makes a job only for the events it accepts.
  - One rule for a throw, as in `@arki/queue`: an effect or step that throws is retried by its `retry`, or the default (8 tries), and the `while` gets the error that was thrown, not the `UnexpectedDefect` the journal records for it, so `.while(reason => reason instanceof TransientError)` needs no `findCause`. A returned failure is final, unless the `while` accepts it.
  - New `JournalError` codes: `LEASE_LOST`, `STEP_TIMEOUT`, `WORKFLOW_LIMIT`, `WORKFLOW_UNKNOWN`, `WORKFLOW_SHAPE_CHANGED`, `WORKFLOW_VERSION_RETIRED`, `WORKFLOW_NOT_FOUND`, `WORKFLOW_FINISHED`, `WORKFLOW_COMPENSATING`, `STEP_NOT_DEAD`, `STEP_NOT_RESOLVABLE`, `WORKFLOW_READ_MISMATCH` and `JOB_MANAGED`. New failures: `WorkflowStranded`, `WorkflowReadMismatch`.

  Breaking (0.x). These shipped in the 0.3.0 code without a changelog entry. 0.3.0 was not published to npm, so an app moving from 0.2.1 meets them here. The upgrade guide is `docs/upgrades/0.3.0-to-0.4.0.md`.

  - `initJournal({ tables, meta?, retention? })` takes the journal tables, and `tables` is required. `compose()` no longer takes `tables`, and the Dot adapter `journal({ j })` no longer takes `tables`.
  - `retention` moved from `compose()` to `initJournal()`. It gains `retention.workflows` (`completed` 7 days, `failed` 90 days, `cancelled` as `failed`).
  - Migration: three new tables, `workflow_runs`, `workflow_steps` and `workflow_signals`, and a nullable `run_id` column on `journal_jobs` and `journal_job_archive`. Export the new tables from the schema module (`ExportsEveryJournalTable` names any you miss) and run `drizzle-kit generate`. Every statement is additive. Migrate first, then roll the workers.
  - `journal.retry`, `journal.discard` and `journal.cancel` refuse a job that belongs to a workflow run with `JOB_MANAGED`.
  - For code written against the unreleased workflow code in 0.3.0: `NodeSkipped` event data has a required `cause` (`when`, `compensating`, `no-undo`, `detached`, `operator`), and a node dropped by compensation leaves no key in `results` (it was `null`). `RunDetail` takes `<Input, Output, Results>`, and `WorkflowDef`, `WorkflowStarter`, `DefExtension` and `ApplyExtension` have new type parameters. `finish(fn)` with a declared `output` no longer needs a second argument. `Effect.bindPerWorkflow` is internal and no longer in the published types.

- 6fd5ff9: `journal.adopt` takes a row at any version whose log is empty, not only a row at version 0. The create event is recorded as version 1 and the row is set to version 1 under the row lock, so the row's version drops from N to 1 and a client holding `expectedVersion: N` gets `CONFLICT` once. This is how an entity goes from `events: 'transient'` to `'stored'`: change the setting, then adopt each row before its first write. A row with a non-empty log is still `CONFLICT`; the message now says the row was written to after its events started being stored.
- b435e76: A command declares the events it writes. Breaking (0.x, no shims):

  - `j.command(name, input, options, handler)` replaces `j.command(name, input, handler, options?)`. `options.writes` is required: `{ writes: [OrderPaid] }`, or `{ writes: [] }` for a command that only runs child commands. `authorize` moves into the same object.
  - `write` in a handler takes only the declared events: anything else is a type error. At run time an undeclared event fails the run with `BAD_DEFINITION`, naming the command and the event, and nothing commits, even when the handler catches the error.
  - `Command` has a fifth type parameter, `Writes`, and a read-only `writes` field that keeps the exact tuple, so code can read it before boot. `CommandContext` has a third, `Declared`. `CommandOptions` has a fifth.
  - New type `CommandWrite<MetaOut, Tx, Declared>`, the type of `context.write`. A helper that takes `write` names what it writes; a command can pass its `write` only when it declares at least those events.

  `@arki/payments` moves its commands to the new form; its API does not change. The `@arki/dot` app-stack template and the `@arki/db` README show the new form.

  See `docs/upgrades/0.3.0-to-0.4.0.md`, step 12.

  docs: README (Quick start, Commands, Idempotent commands, Failures, Workflows, Dot), `docs/agent-guide.md` (model, write a command, rules that bite, errors, shared packages), `llms.txt`.
  demo impact: `demos/faultline` (commands and lesson 02) moves to the new form.

- b435e76: An effect is application code, not an entrypoint. In a Dot app a feature's effects, taps and workflows are an application contribution of `.usecases(...)`. Breaking (0.x, no shims):

  - `journalHandlers(core, { effects, taps, workflows })` takes the feature core first and is mounted as `core.usecases({ ...factories }, journalHandlers(core, { … }))`. It binds once at the feature's boot to the usecase-level deps: needs that are not `entrypointOnly`, private infra, domain services. It no longer takes `projections`: list those with `journalProjections(...)` in `.infra(...)`.
  - Removed: the entrypoint helpers `journalEffects(core, …)` and `journalWorkflows(core, defs)`, and the types `JournalEffectsEntrypoint` and `JournalFeatureSlice` (now `JournalHandlers`). `journalWorker()` is the only journal entrypoint.
  - New: `needsOf((_: Deps) => ['mailer'])`, the needs record of an effect, tap or workflow in a Dot feature, typed from the selector's parameter annotation with no type arguments. It refuses an `entrypointOnly` key and a key the feature lacks. A key missing at runtime fails the feature's boot and names it. A reaction file is a plain exported value and imports `Deps` from the feature as a type only. New type `UsecaseCore`.
  - `dot explain --as journal-flow` is now one graph for the whole app: `nodes` (event, entity, projection, effect, tap, workflow, feature) and typed `edges` (`folds`, `projects`, `reacts`, `owned-by`), with each edge to an event carrying its `timing` and `delivery`, and each reaction its deps and retry policy. The text view prints it per event. It is derived from the declarations at configure; the old `edges: [{ event, effect, plugin, entities }]` shape is gone.
  - New in `@arki/journal/orpc`: `orThrowCommand(result, errors)`. A contract-first procedure answers `context.run(command, input)` with it: the contract lists its business failures only, and the journal's own `CommandFailure`s answer through `toORPCError`.

  See `docs/upgrades/0.3.0-to-0.4.0.md`, step 11.

  docs: README (Dot, A `defineFeature` feature, Workflows in Dot, the actor), `docs/agent-guide.md` (Dot, task map), `llms.txt`.
  no demo impact: no demo mounts the journal in a Dot feature.

- 8e5d9df: Named limits and pause for workflows. `j.limit({ name, total?, perKey? })` makes a limit several workflows share: list it in `concurrency.shared` (at most two). `concurrency` also takes `total` (every unfinished run of the workflow) next to `limit` (per key), and `key` is optional unless `limit` or a shared `perKey` needs it; together `limit` and `total` are the workflow's own limit, `workflow/<name>`. A start is admitted only when every limit it holds has room; `onBusy: 'join'` joins only when the workflow's own per-key limit is full. `{ key, limit, onBusy }` works as before.

  `journal.limits` reads and changes limits at runtime: `list`, `get`, `override` (the limit's `total` and `perKey`, or one key's `perKey` for up to 30 days, 7 by default; `0` admits nothing), `reset`, `pause` and `resume`. A paused limit admits no new run (`WorkflowBusy` with `reason: 'paused'`); running runs finish. A workflow without `concurrency` can be paused by its own name. Each change is an event on the new `journal.limit` entity that names the operator; an unknown name is `CommandNotFound`. `WorkflowBusy` data gains `limitName` and `reason` (`LIMIT_BUSY_REASONS`). New exports: `LIMIT_BOUNDS`, `LIMIT_KEY_TTL`, `WORKFLOW_LIMIT_PREFIX`, `LIMIT_BUSY_REASONS`, `LimitDef`, `LimitView`, `LimitOps` and the verb argument types.

  Migration needed: `workflow_runs` gets `limits text[] not null default '{}'` with a partial GIN index (`workflow_runs_limits_idx`), and there is a new table `journal_limits`. Run `drizzle-kit generate`. Old runs hold no shared limit; a workflow's own limit counts them by name.

- b438186: The journal's Postgres storage lives in one place, split by concern: entity rows, the event log, receipts, effect jobs and the wake signal (`src/store.ts`). The write path, history and command receipts call it instead of building queries inline. One behaviour changes: a row insert that hits a unique constraint is now `CONFLICT` for every entity, not only for one with `events: 'transient'`. Before, an entity with stored events let the driver's unique-violation error through. The write still rolls back with its events.
- b435e76: Effects only reach out, `startOn` says when a run starts, and workflows get a command node. Breaking (0.x, no shims):

  - An effect's context has no `run` and no `accept`: `{ jobId, attempt, signal, db }`. An event that must run a command starts a `j.task` or a `j.workflow` with `startOn`. `Effect` and `EffectHandlers` lose their runner type argument, and `RootCommandRunner` is no longer exported.
  - `startOn.timing` is required: `'after-commit'` (the behaviour so far) or `'with-event'`. `'with-event'` writes `RunStarted`, the first scheduled node and its job in the event's transaction, so a rollback of the command removes the run. No body runs inline. `onBusy: 'refuse'` with `'with-event'` is a type error. A standalone `workflow()` now types its `startOn` mapping.

  New:

  - `.command(name, command, ({ input, results }) => commandInput, { accept?, undo?, when?, retry? })` runs one command as a savepoint inside the checkpoint's transaction: exactly once per node, even when the job runs again after a crash. A refused command rolls back and the failure transition commits. `accept` names failures the run goes on from, and they join the typed result. `undo` runs in compensation, in reverse order.
  - `j.command(name, input, { writes, output }, handler)` takes a schema of the plain result. A command node stores it, and `results.x` and `def.read` are typed from it. Stored JSON is checked by the schema, never cast.

  Shape hashes of existing node kinds do not change. `@arki/payments`: the refund workflow names `timing: 'after-commit'`. Its steps stay steps, because none has a body of exactly one command.

### Patch Changes

- f6b9ab1: `@arki/journal/pg` exports `LimitKeyOverride`, the type of the `journal_limits.keys` column. A schema module that infers its tables from `journalTables` can now name it, so its declaration no longer fails with TS2883.

  no docs impact: a type export for an existing column, named by the compiler, not by app code.
  no demo impact: no demo builds journal tables from inferred types.

- 86250e6: `toORPCError` and `commandErrors()` answer the `TransactionDefect` that `journal.run` returns for a `JournalError('CONFLICT')` with the same 409 as the thrown conflict. Since a command's transaction started returning thrown errors as `TransactionDefect`, a stale `expectedVersion` or a lost insert race reached the client as a 500.

  no docs impact: README already promised the 409; one sentence added on the returned shape.
  no demo impact: error mapping only.

- 11c5bc2: Complete public error summaries and remediation metadata. The source error index now follows canonical factory aliases, checks duplicate original codes across packages, and enforces documentation for private libraries too. Runtime behavior and failure data are unchanged.

  No demo impact: this changes error documentation and repository checks only.

- 440c75f: Dot's kernel atom is now a **unit**, and its constructor says its role. Breaking (0.x, so a minor):

  - The builder has three steps, always in this order: `defineApp(name).infra(...).features([...]).entrypoints(...)`. `.use()`, `.useAll()` and `.serve()` are removed: write `.use(x)` as `.infra(x)`, `.useAll(list)` as `.infra(...list)`, and `.serve(x)` as `.entrypoints(x)`. `.infra(a, b)` checks the list in order, like separate calls.
  - `plugin({...})` → `infra({...})` for infrastructure (a database, a cache, a mailer, an outside client). `.infra(...)` mounts it.
  - A unit served from `.entrypoints(...)` is now `entrypoint({...})`.
  - `driven(features => plugin({...}))` → `infra.fromFeatures(features => unit({...}))`; `driver(features => plugin({...}))` → `entrypoint.fromFeatures(features => unit({...}))`. `unit({...})` is the role-less atom and belongs only inside `fromFeatures`.
  - `@arki/dot/plugin` → `@arki/dot/unit`. Every `Plugin*` type is now `Unit*` (`Unit`, `AnyUnit`, `UnitNeeds`, `UnitPhases`, ...); `Driver` / `Driven` → `EntrypointBinder` / `InfraBinder`; `DotPluginError` → `DotUnitError`; `testPlugin` → `testUnit`; `initPlugins` → `initUnits` (its factory method `.plugin` → `.infra`); a feature's `.plugins()` → `.units()`; the context key `$plugin` → `$unit`.
  - `UnitRole` is `'infra' | 'feature' | 'entrypoint'` (was `'feature' | 'driving'`, with infra unlabelled). Every mounted unit has a role, and the manifest shows it.
  - The builder checks the side: `.infra()` refuses an entrypoint, and `.entrypoints()` refuses an infra or feature unit, at compile time. An erased graph fails `configure()` with the new `ARKI_DOT_E033` (`DotLifecycleErrorCode.UnitOnWrongSide`).
  - OpenTelemetry attributes: `dot.plugin.*` → `dot.unit.*` and `dot.app.plugin.count` → `dot.app.unit.count`. Update dashboards and alerts that query them.
  - `dot explain --graph` groups the hexagon as `infra` / `features` / `entrypoints`.
  - Domain logic with no usecases is still a feature: `defineFeature('orders').needs({...}).provides({...}).entrypoints()`. The quickstart now teaches this shape.

  Not yet renamed: the manifest and diagnostics JSON keys (`plugins`, `plugin`, `registeringPlugin`). A follow-up renames them. `@arki/dot/plugin` and `plugin` stay as aliases of `@arki/dot/unit` and `infra` inside the monorepo until then, and will be removed before this ships.

  The adapters move to the new names and the new steps (`@arki/tanstack-start`'s `tanstackStart(...)` is now built with `entrypoint`, so it mounts only with `.entrypoints(...)`, as before).

  demo impact: drop-studio's and faultline's Dot code uses `plugin(...)` and `@arki/dot/plugin`; rename on their next upgrade.

- 49517e2: The build no longer compiles type tests (`*.test-d.ts`). They stay in `typecheck`, but a type test can no longer fail the build, and the published `dist` no longer holds compiled type tests.

  `@arki/db` exports the `OnDelete` type from `@arki/db/id` and `@arki/db/sqlite`. A package whose types come from `idColumns` (such as `@arki/auth`) can now build its declarations. Before, TypeScript could not name `OnDelete` and stopped with TS2883.

  `@arki/ai` drops a `@ts-expect-error` above the `@huggingface/transformers` import. That package is now always installed, so the comment had no error to hide and failed the build.

- fdec626: Workflow concurrency no longer crosses a run's `scope`. The limit still counts every run with the key, but `onBusy: 'join'` joins only a run of the caller's own scope (otherwise the start is `WorkflowBusy`), and `WorkflowBusy.running` lists only the caller's own scope's run ids. Before, two tenants whose inputs gave the same key could get each other's run ids.
- 17e86d3: Breaking: the object-form feature API is removed. Write every feature as a `defineFeature(name).needs().infra().usecases().provides().entrypoints()` chain.

  - `@arki/dot`: removed `feature()`, `plug`, `composeRouter`, `composeRepos`, `tokenOf`, `entrypointsOf` and the types `AnyFeature`, `MountedFeature`, `UnitOf`, `MountedUnitsOf`, `FeatureConfig`, `ComposedRouter`, `ComposedRepos`. `defineApp().features()` takes chain features only. Use `routerFor(rpcContract, features)` instead of `composeRouter`, and a feature's own `repos({...})` store instead of `composeRepos`. Read `f.entrypoints` instead of `entrypointsOf(f)`. Lifecycle hooks (`boot`, `start`, `stop`) live on an infra unit inside the feature.
  - `@arki/http`: removed `endpoints(build)` and `EndpointsFeatureSlice` from the root export. Use `endpoints(core, build, { contracts })` from `@arki/http/dot` in `.entrypoints()`.
  - `@arki/schedule`: removed the `schedules(needs, defs)` overload. Use `schedules(core, defs)` in `.entrypoints()`.
  - `@arki/queue`, `@arki/journal`, `@arki/admin`: dropped their object-form branches. The chain API is unchanged.

- Updated dependencies [5d55e12]
- Updated dependencies [a905468]
- Updated dependencies [c36e614]
- Updated dependencies [b992897]
- Updated dependencies [289ba73]
- Updated dependencies [17e86d3]
- Updated dependencies [ebc681b]
- Updated dependencies [f2ba7ac]
- Updated dependencies [6cc8655]
- Updated dependencies [440c75f]
- Updated dependencies [440c75f]
- Updated dependencies [5d55e12]
- Updated dependencies [be8f8e2]
- Updated dependencies [c3e63ba]
- Updated dependencies [e132ad3]
- Updated dependencies [23e9f49]
- Updated dependencies [1e47612]
- Updated dependencies [5d55e12]
- Updated dependencies [e132ad3]
- Updated dependencies [23e153b]
- Updated dependencies [49517e2]
- Updated dependencies [7711722]
- Updated dependencies [29520c1]
- Updated dependencies [8944628]
- Updated dependencies [88daaeb]
- Updated dependencies [5d55e12]
- Updated dependencies [b37115d]
- Updated dependencies [36b4da8]
- Updated dependencies [c1ed2a3]
- Updated dependencies [5d55e12]
- Updated dependencies [b435e76]
- Updated dependencies [517d297]
- Updated dependencies [1a897f8]
- Updated dependencies [9d408cf]
- Updated dependencies [8944628]
- Updated dependencies [43bef40]
- Updated dependencies [e80211d]
- Updated dependencies [17e86d3]
  - @arki/http@0.4.0
  - @arki/db@0.5.0
  - @arki/dot@0.9.0
  - @arki/admin@0.2.0
  - @arki/resilience@0.3.1

## 0.3.0

### Minor Changes

- 38e4bd7: `ExportsEveryJournalTable<Module>` in `@arki/journal/pg`: a compile-time check that a schema module exports every `journalTables()` table at the top level, where drizzle-kit looks. It fails and names each missing table, so a table added by a later journal version can no longer go unmigrated. Tables match by type, not name, and a nested object such as `allJournalTables` does not count.
- 483a022: Outgoing webhooks. `@arki/journal/http/webhooks` adds `webhookTables()` and `webhookSender({ tables, webhooks, encryptionKey })`: `subscribe`, `dispatch(tx, …)` (the message and its deliveries commit with the business write), `replay`, `rotateSecret` (both secrets sign during a window), `enable`, `disable`, and a queue `runner` for the journal worker. Deliveries are signed with Standard Webhooks, posted through `publicFetch()` from `@arki/http`, retried and dead-lettered by the worker, appended to `webhook_attempts`, and a subscription is disabled after `disableAfter` dead deliveries in a row. Secrets are sealed at rest with AES-GCM. `@arki/journal` adds `combineRunners(...)`, so one worker runs several queue runners.

  Migration: three new tables, `webhook_subscriptions`, `webhook_messages` and `webhook_attempts`. Add `webhookTables()` to the schema and run `drizzle-kit generate` before using the entry.

- 932c9e4: Journal handlers for `defineFeature` features, the actor-bound runner, and `dot explain` event → effect edges.

  - `journalProjections(...projections)` for a feature's `.infra(...)` and `journalEffects(core, { effects, taps })` for its `.entrypoints(...)`, in `@arki/journal/dot`. The journal reads both from the feature value before boot and folds them into one declaration per feature; object-form `journalHandlers` keeps working next to them. An effect's needs are checked against the core at the call (a missing service is a named compile error).
  - `actorRun(select)` in `@arki/journal/orpc`: middleware that adds `context.run`, bound to the context's `db` and to the meta the app's `select` returns. The context must carry `journal` and a `db` the journal can write through.
  - `@arki/journal/projection` and the `journal-flow` format: `dot explain --as journal-flow` lists which event starts which effect, from the effects' existing action meta. `journal(...)` registers it.

- c3aeda9: `initJournal({ meta })`, `JournalDefinitions`, `Journal`, `CommandRunner` and the `@arki/journal/dot` types take a meta schema of any Standard Schema with a plain-record output (`StandardSchemaV1<unknown, Record<string, unknown>>`), not only `z.ZodObject`; `meta` types are `SchemaInput`/`SchemaOutput` of it.
  `j.event(type, schema, { upcasters })` and `j.command(name, input, handler)` take any Standard Schema (Zod, Valibot, ArkType, hand-written); event constructor, write, replay and upcasters parse sync, command input and meta parse async.
  Data or `meta` that fails its schema now throws `SchemaError` from `@arki/schema` (with `issues`), not `ZodError`; a schema that cannot run (async where parsing is sync, or a throwing `validate`) throws `SchemaRunError` and is never reported as `REPLAY_FAILED`.
  `initJournal()` without `meta` uses a built-in schema that accepts a plain object and records `{}`; the package no longer imports zod.
- d71ae60: An effect handler may now return a failure from `@arki/failure`. The job is then dead after one try, unless the effect's `retry` backoff accepts that failure in its `while`. A thrown error retries as before. The job's `lastError` is the failure as JSON, with its code, message, status and data, so `journal.jobs(db, { status: 'dead' })` shows why. `Effect.run` now resolves with the handler's result instead of nothing.
- 3064b6a: Keep unresolved HTTP idempotency reservations until reconciliation and return precise canonical cache failures. Replay retention starts at confirmed persistence; all bounded responses, including error statuses, are stored. Oversized requests are refused before execution, and unreplayable responses retain their reservation.

  ResponseCache.begin no longer accepts a TTL; finish requires it. Postgres/Redis adapters confirm ownership and preserve unresolved claims; Journal pruning respects their lifecycle. Coordinate writer upgrades and reconcile legacy expiring reservations. See @arki/http/docs/upgrade-idempotency.md.

- 7c05d9a: Add nominal domain kinds to `defineId(prefix, { kind })`, preserving canonical
  schema output through `IdOf` and DB columns without changing stored strings.
  The one-argument declaration remains compatible. Migrate each domain and its
  consumers together using the canonical schema at raw boundaries.

  Replace Journal's private Cuid2 generation with modern, supervised declarations.
  Public `jobId`, Journal write/worker/workflow/operator methods, webhook scheduling,
  Queue outbox scheduling and Mail outbox scheduling can now return precise
  `IdGenerationFailure` outcomes. Handle returned failures before treating an
  operation as committed or acknowledged. Partial writes roll back and adapters
  preserve the original failure.

  Admin actions can declare canonical `failures` and infer their exact execute
  outcomes. Refusals produce failed receipts; undeclared or thrown failures are
  supervised without leaking private metadata. Receipt replay and clients support
  canonical server-error statuses. Dot outbox producers retain the complete
  scheduling outcome.

  See Contracts' `docs/upgrades/domain-ids.md` and Journal's
  `docs/upgrades/id-generation-failures.md` for migration details and remaining
  identity-branding scope.

- 115aa87: `journal()` reads each feature's projections from the feature's own units (`ownUnits`), so a nested child feature's `journalProjections` register once, under the child, instead of twice (once through the parent's `plugins()`).
- 851b41b: A feature mounted twice with `feature.instance('eu', rebind)` now gets its own journal effects and taps. Their names carry the instance (`send-on-request#eu`), and so do the effect action ids (`send-on-request#eu.run`) and the stored job rows. Each instance runs with its own rebound needs, and two instances no longer trip the duplicate-name check. A plain feature keeps its names exactly as before.
- 2c0b668: Make failure the acyclic validation foundation. Schema parsing now returns exact typed validation failures, and failure revival returns typed protocol/validator defects instead of throwing. Add validated versioned JSON envelopes; retain legacy envelope reads while rejecting non-JSON data and changing output transforms. oRPC error maps validate output-only wire data.

  Migrate consumers to check failures, propagate them through Journal event/write/replay and queue/mail operations, and use explicit exception bridges at foreign callbacks. Journal rejects invalid event entries before inserting them. See `@arki/failure/docs/upgrade-typed-validation.md` for breaking API and stored-data migration details.

- d80a024: Job operations, retention and an archive for the jobs table.

  Three tables are new and `journal_jobs` gets two columns. `journal_job_attempts` has one row per try. `journal_job_archive` holds finished jobs with their attempt log, outcome (`completed`, `dead`, `discarded`, `cancelled`), `keep_until` and `exported_at`. `journal_job_operations` records who retried, discarded, cancelled, purged or replayed what. `journal_jobs` gains `enqueued_at` and `replay_of`. Apps must generate a migration from `journalTables()` (`drizzle-kit generate`). Every statement is additive. Migrate first, then roll the workers: an old worker on the new schema still works, and a new worker on the old schema does not.

  Retention. `j.compose({ tables, retention })` takes `retryableFor` (default `'30d'`), `archive.completed` (`'7d'`), `archive.dead` (`'90d'`), `archive.sink`, `operations` (`'forever'`) and `sweep` (`{ every: '1h', batch: 1000 }`, or `false`). A `Keep` is `false`, `'forever'`, `'untilExported'`, an age such as `'30d'`, or `{ age, max }`. An effect overrides it with `withSchedule({ retention })`; a queue job with `.options({ retention })`. `journal.retention` is the parsed policy. `'untilExported'` without a sink is `BAD_DEFINITION` at boot. Each worker runs a sweeper (`purgeDead`, `exportArchive`, `pruneArchive`, `pruneOperations`, safe with several workers); with `sweep: false` an app calls the verbs from its own schedule. A sink gets rows at least once, and no row is pruned before it is exported. `ndjsonArchiveSink({ put, prefix })` writes one NDJSON file per batch through any `put(key, body)`, so `@arki/fs` fits. On success a job now moves to the archive in one fenced statement; `completed: false` keeps the old plain delete.

  Job operations on the `journal` object: `jobs` (states `ready`, `delayed`, `running`, `dead`), `job`, `jobCounts`, `jobOperations`, `archivedJobs`, `archivedJob`, `archiveStatus`, `retry`, `discard`, `cancel`, `retryDead`, `purgeDead`, `replayJob`, `exportArchive`, `pruneArchive` and `pruneOperations`. New error codes `JOB_NOT_DEAD`, `JOB_NOT_PENDING`, `JOB_RUNNING`, `JOB_EXISTS` and `BAD_ARGUMENT`.

  New entry `@arki/journal/foreman`: `journalJobsModule({ journal, db })` for Foreman (eight reads, six actions with previews, revisions and risk levels), `JOURNAL_JOBS_ERROR_CODES` (`ARKI_JOURNAL_E001` to `E005`), and `journalReceiptStore` and `foremanReceiptTables` (moved from `@arki/admin/pg`). `@arki/admin` is an optional peer. The README gains Retention and archive, Inbox, Relay recipe and Foreman sections.

  Breaking (0.x): `retry` and `discard` take a required `op` (`{ actor, reason?, executionId? }`) as their last argument and throw `JournalError`. `jobs` returns `{ jobs, next }` with an opaque cursor, not an array. Job replay is `replayJob`, because `journal.replay` is the entity-history replay. A job that succeeds is archived by default (7 days) instead of deleted; set `retention.archive.completed: false` for the old behaviour.

- 71dea3e: Carry inferred failures through configure, boot, start, stop and dispose, with atomic service publication, rollback aggregation and supervised usecase invocation even without tracing. Configure now returns a typed outcome and remains synchronous with no I/O; logging activates during boot. Detached lifecycle callbacks must prove an undefined or concrete failure return rather than void.

  Breaking: check configure before accessing the manifest, inspect stop/dispose outcomes, and handle managed CLI preflight failures under `dot.preflight_failed` in `.error.data.{app,migrations,report,failure}` (exit 3). Successful JSON paths remain unchanged. See `docs/upgrade-phases.md` for phase-specific outcomes and migration steps.

  Cron oRPC adapters route canonical supervised defects through the existing failure policy before success mapping; business refusals keep their explicit responders.

  Database, mail, queue, resilience and Journal adapters retain their authored factory and lifecycle return types, including driver-specific service types.

- 9281865: `listenOnPool` moves from `@arki/journal` to `@arki/db/pg`, with `ListenClient`, `ListenPool`, `ListenOptions` and `unrefTimer`. **Breaking for `@arki/journal`:** it no longer exports `listenOnPool`, `ListenClient` or `ListenPool`; import them from `@arki/db/pg`. `journal.worker(db, { listen })` is unchanged. The listener now also handles an `end` without an error, runs a `select 1` health check every `healthMs` (default 5000; no answer by the next check drops the client), reports `onState('ready' | 'disconnected')`, releases a lost client exactly once, and forwards nothing from a released client. `ListenClient` gains `on('end')`. `@arki/db` no longer has a dev dependency on `@arki/journal`; the two tests that used both now live in `@arki/journal`.

  `@arki/live/pg` (milestone M1): `liveMigration` generates the reviewable trigger SQL (statement triggers that publish `{ v: 1, tag }` at commit; partition leaves publish their root), `liveChannel`, `verifyLiveTriggers` lists every table that would not publish (missing, disabled or replica-only, wrong function, events or arguments, uncovered partition leaf), `touch` publishes tags from inside a transaction, and `pgSource` is the hub's source on a `pg` pool: `ready` only after `LISTEN`, `gap` on a lost listener or an unreadable payload. Each hint carries the committing transaction's id (`txid`, `pg_current_xact_id()` as a decimal string), and the hub's `change` frame now has `txids` (strict schema change). The generated SQL splits statements with `--> statement-breakpoint`, so Drizzle's migrator runs it on PGlite too. `@arki/db` is a new optional peer.

- 536d17d: Idempotency keys on HTTP and oRPC. `@arki/http/idempotency` adds `idempotent({ cache, scope, routes, ttl, ... })`, a middleware that runs a listed request once per `Idempotency-Key` and replays the stored response (status, body, allowlisted headers) on a repeat. `@arki/journal/http` stores responses on `journal_receipts`, and `@arki/kv/redis/idempotency` on Redis. `@arki/journal/orpc` adds `idempotent()`, which turns the header into receipt keys for every command of a procedure, and `journal.bind` takes `keyPerCommand`.

  Migration: `journal_receipts` gains three nullable columns, `owner`, `expires_at` and `response`. Run `drizzle-kit generate` and apply the migration before using `@arki/journal/http`. Existing command receipts are unchanged. New error codes `ARKI_HTTP_E410`, `E411`, `E412`.

- 74f08e5: Preserve typed business failures across job execution, scheduled runs and durable
  commands. BullMQ and pg-boss share outcome classification and explicit retry
  decisions; persisted refusals cannot become successful jobs. Queue submission
  returns canonical validation, unavailability or uncertain-acceptance failures.
  Middleware failure types flow from their definitions.

  Schedule clients infer success and refusal from each definition and distinguish
  refused work from overlap, lock contention and unavailability. Journal rolls back
  refused commands, supervises callback defects, returns receipt conflicts, and
  persists typed diagnostics for incompatible pinned workflows.

  Breaking migration: narrow enqueue results before using IDs or counting accepted
  work; register the exported failure definitions at RPC boundaries; handle
  `refused` schedule outcomes. Returned failures and unexpected defects are not
  retried by default. Follow each package's upgrade guidance for persisted jobs
  and workflow versions.

  Payments preserves duplicate-pending-refund handling when Journal returns a
  typed constraint rejection. Other transaction failures retain their identity,
  including uncertain commits; the service does not retry or call the provider.

- 397d1e6: A command says no by returning a failure from `@arki/failure`. The journal ships four, each with data `{ detail }`, the message for the client: `CommandNotFound` (`journal.not_found`, 404), `CommandInvalid` (`journal.invalid`, 400), `CommandForbidden` (`journal.forbidden`, 403) and `CommandConflict` (`journal.conflict`, 409), exported from `@arki/journal` and `@arki/journal/errors`. An app's own `defineFailure` values work the same way. When a command handler, its `authorize` or an `events` function returns a failure, the command's transaction rolls back exactly as for a throw, and `journal.run` returns the same failure instance. The type is inferred: `run` returns `Result | Failure` from the handler, and the failures `authorize` can return are added to the command's type. An `events` failure rolls back the write's savepoint and comes back from `write` (now `WriteResult | Failure`); the handler returns it on. A child command's failure comes back from `context.run` with its savepoint rolled back. A failure is never stored as an idempotency receipt, so a repeat runs again. Once a write's `events` or a child command returned a failure, the command must end with a failure (that one or another): a handler that still returns a success makes the run throw the new `JournalError` code `IGNORED_FAILURE`, naming the write or child and the failure code, and nothing commits. An effect that ignores a failure from `ctx.run` and returns a success fails its job with that failure, dead after one try. `@arki/journal/orpc`: `toORPCError` turns a failure into the `ORPCError` with its code, status, message and data, and `commandErrors()` also answers a failure the procedure returns as an error. A contract-first procedure uses `orThrowRpc` and `errorMap` from `@arki/failure/orpc` for typed client errors.

  - `accept(result)` on the command context and the effect context (one shared type, `AcceptFailure`) marks a refusal a `write` or `run` returned as handled, so the handler may still return a success. It lifts only that command's (or effect attempt's) check: a refused child stays rolled back, and the success is stored as the idempotency receipt like any other. Each return is tracked by identity: the same object returned twice needs two `accept` calls, and an unaccepted one is still `IGNORED_FAILURE`, whose hint now names `accept(result)`. Misuse throws the new `JournalError` code `INVALID_ACCEPT`: a value the handler never received, a second call for one return, a call after the handler finished, or a value that is not a failure. A need may no longer be named `accept`.
  - `CommandError`, `isCommandError` and `CommandErrorCode` are removed, from `@arki/journal` and `@arki/journal/errors`; return `CommandNotFound`, `CommandInvalid`, `CommandForbidden` or `CommandConflict` instead. `toORPCError` and `commandErrors()` no longer map a thrown `CommandError`.

- 713535d: `journal_jobs` now takes `kind = 'queue'` rows: jobs written in the caller's transaction by `@arki/queue/outbox`, with no event. `worker` and `drain` accept `jobs` (a `JobRunner`) and claim both kinds. Without `jobs` they claim effect rows only, as before, and an older worker never claims a queue row. `journalWorker({ jobs })` takes a `JobsSource`. `StrandedJobs` is now `{ kind, name, jobs }`, and `strandedJobs(db, { jobs })` counts queue rows when it gets the runner. `jobs({ job })` filters queue rows by job name. `jobId` is exported from the root. New types: `JobRunner`, `ScheduledJob`, `JobsSource`. Run `drizzle-kit generate` in each app: the migration drops `NOT NULL` on `event_seq` and `effect` and adds `kind`, `job_name`, `args`, `dedupe_key`, a check and a dedupe index. Roll out in this order: migrate, then workers, then producers.

  `listenOnPool` closes its client on stop instead of handing it back to the pool. A reused client kept the stopped worker's handlers: they fired its taps and released the next worker's client twice ("Release called on client which has already been released").

- acf8c9f: An effect's schedule takes `retry`, a `Backoff` from `@arki/resilience` (re-exported as `backoff`): `withSchedule({ retry: backoff.exponential({ base: 5000 }).upTo(3) })`. It is the same retry schedule queue jobs and resilience policies use. It sets how long a failed job waits before the next try, and when the job is dead instead; `.while(predicate)` makes an error that will never succeed kill the job at once. The default keeps the old behavior: 8 tries, doubling from 1 s to at most 5 minutes, with 25% jitter. The package now depends on `@arki/resilience`.

### Patch Changes

- 36f1f54: Outgoing webhooks: a delivery whose URL `publicFetch` refuses (`UnsafeUrlError`, such as a host that now resolves to a private address) is dead on its first try, whatever `retry` allows. It is refused the same way every time, so retrying it only filled `webhook_attempts`. It still counts toward `disableAfter`.
- 953991a: Docs standard: new `AGENTS.md`, a README in the standard section order with `Limits`, `Failure behaviour` and a public imports table, an `llms.txt` with generated import paths, and a `File map` and `Verify` section in the agent guide.

  no demo impact: documentation and doc-example changes only, runtime behaviour unchanged

- f2e9f69: `env()`, `resilience()`, `auth()`, `journal()`, `journalProjections()`, `queue()`, `durableScheduler()` and `outboxPlugin()` keep their plugin name in the type, so their handles carry `provider: 'env' | 'resilience' | …` instead of `string` and the feature builder's handle-identity checks apply around them. The three queue plugins gain an overload: with no `name` option the type carries the default name (`'queue'`, `'durable-scheduler'`, `'outbox'`); with `name: 'jobs'` it carries `'jobs'`.
- fce3e8c: Return exact canonical webhook signing, verification and request-preparation
  failures, supervise Web Crypto and add safe default tracing. Declare
  WEBHOOK_FAILURES on protected HTTP routes and narrow direct results before
  accepting a delivery. Payments fails closed on returned verification failures;
  the Journal inbox declares the new contract and outbound delivery returns signing failures without sending or acknowledging jobs. Returned signing failures need an explicit backoff retry predicate.
- baecec3: Document actionable fixes and verification commands for canonical error definitions.

  Journal command/workflow failures and Embeddings failures also expose the missing runtime remediation guidance. Existing failure codes, data and inferred unions are unchanged.

- 5bc6390: `journal()` publishes `journal` through a `provides` factory, so its handle is known before boot (`@arki/dot` plugin handles).
- 2ce7fe2: New `@arki/db/errors` entry with `isUniqueViolation(error, constraint?)`: the "insert, and answer CONFLICT on a duplicate" check, read the same way for node-postgres, PGlite and Bun SQL, and through Drizzle's `DrizzleQueryError`. Bun SQL puts the SQLSTATE in `errno` and its own name (`ERR_POSTGRES_SERVER_ERROR`) in `code`, so a check that reads `code` never matched there.

  Fix: `runTransaction` now retries a `40001` / `40P01` raised by Bun SQL. `retryableSqlState` stopped at Bun's `code` and never saw the SQLSTATE in `errno`, so under Bun a serialization failure or deadlock reached the caller on the first try.

  `@arki/journal` uses the shared check in place of its private copy, and no longer matches the error message text.

- baecec3: Keep lower-level diagnostics out of the public dead-step failure. Its stable public detail and remediation guide operators to the checkpoint; the original failure remains a private cause and existing operator checkpoint diagnostics are preserved.
- Updated dependencies [5bc6390]
- Updated dependencies [cbefc52]
- Updated dependencies [7ce6a18]
- Updated dependencies [8b3cc80]
- Updated dependencies [5d05b9c]
- Updated dependencies [dab8eb9]
- Updated dependencies [d0c502a]
- Updated dependencies [115aa87]
- Updated dependencies [8e55924]
- Updated dependencies [232d3e8]
- Updated dependencies [d471284]
- Updated dependencies [ddcc363]
- Updated dependencies [481a2a7]
- Updated dependencies [47d296b]
- Updated dependencies [232d3e8]
- Updated dependencies [f56ab9f]
- Updated dependencies [232d3e8]
- Updated dependencies [5e4c630]
- Updated dependencies [3064b6a]
- Updated dependencies [7ce6a18]
- Updated dependencies [232d3e8]
- Updated dependencies [3359639]
- Updated dependencies [af3d5a1]
- Updated dependencies [7c05d9a]
- Updated dependencies [28cd943]
- Updated dependencies [932c9e4]
- Updated dependencies [232d3e8]
- Updated dependencies [d80a024]
- Updated dependencies [966efcd]
- Updated dependencies [cbefc52]
- Updated dependencies [953991a]
- Updated dependencies [a727e0b]
- Updated dependencies [f6a15d0]
- Updated dependencies [2c0b668]
- Updated dependencies [011ece7]
- Updated dependencies [71dea3e]
- Updated dependencies [9281865]
- Updated dependencies [49a339e]
- Updated dependencies [536d17d]
- Updated dependencies [b9ae16f]
- Updated dependencies [953991a]
- Updated dependencies [62ec96a]
- Updated dependencies [232d3e8]
- Updated dependencies [7b4b5bf]
- Updated dependencies [9caea7e]
- Updated dependencies [f2e9f69]
- Updated dependencies [d11c9fb]
- Updated dependencies [ee69f29]
- Updated dependencies [be345ee]
- Updated dependencies [232d3e8]
- Updated dependencies [b9d0a86]
- Updated dependencies [fce3e8c]
- Updated dependencies [a1d4ee6]
- Updated dependencies [a727e0b]
- Updated dependencies [5bc6390]
- Updated dependencies [a727e0b]
- Updated dependencies [a727e0b]
- Updated dependencies [232d3e8]
- Updated dependencies [2ce7fe2]
- Updated dependencies [00519da]
- Updated dependencies [670554a]
  - @arki/db@0.4.0
  - @arki/http@0.3.0
  - @arki/admin@0.1.0

## 0.2.1

### Patch Changes

- @arki/dot@0.6.1

## 0.2.0

### Minor Changes

- 228b4f5: Features moved into Dot, and the app builder is now a hexagon. `@arki/feature` is merged into `@arki/dot/feature`: `defineFeature()` is now `feature()`, and `composeRouter`, `composeRepos` and the feature types come from `@arki/dot/feature`. `plug`, `plugs` and `tokens` are gone — the builder mounts features itself. `feature()` throws `FEATURE_E003` when `use` holds two slices with the same key (the second used to silently replace the first).

  Apps wire in three steps, checked at compile time: `.use(...)` for driven adapters (what features need), `.features([...])` once for the domain, then `.serve(...)` for driving adapters (what calls the features). `.use()` after `.features()` does not compile, a feature is not a plugin, and adapters declare their side: `driver(features => plugin(...))` is accepted only by `.serve()`, `driven(features => plugin(...))` only by `.use()`. Driven adapters read the features' declarations and boot before them; driving adapters get each feature's slice record with `sliceOf(ctx, f)`. Guard errors are plain sentences, and `dot explain --graph` draws the driven, features and driving groups numbered in boot order (`PluginManifest.role`).

  `@arki/http`: `http()` is a driver for `.serve()` and serves every bound feature's `routes` slice; the `features` option and `HttpFeatureToken` / `HttpFeatureNeeds` are removed. A malformed `routes` slice fails boot with `ARKI_HTTP_E010`.

  `@arki/journal`: the journal splits like the queue. `journal({ j, tables })` is a `driven(...)` adapter for `.use()`: it composes from every feature's `journalHandlers` declarations and boots before the features, so features can write through it. `journalWorker(opts?)` is a driver for `.serve()` that runs projections and effects, getting each feature's effect services from its slice. Inline projections only receive the transaction and the event, so writes never wait for feature services. `journal({ journal })` publishes an app-composed journal and no longer runs a worker; add `.serve(journalWorker())`. Core: `j.compose({ ..., services: 'worker' })` defers effect and tap services, which `journal.worker(db, { services })` and `journal.drain(db, { services })` supply per handler (`HandlerRef`, `HandlerServices`). Removed: the `features` option, the `worker`/`pollMs` options on `journal()`, and the `JournalHandlers` type.

- 9fa13ce: Dot plugin error codes join the `ARKI_` scheme: `KV_PLUGIN_E001` is now `ARKI_KV_PLUGIN_E001`, `DB_PLUGIN_E001` is `ARKI_DB_PLUGIN_E001` and `JOURNAL_PLUGIN_E001` is `ARKI_JOURNAL_PLUGIN_E001`. Code that matches on the old strings must update; the `*_PLUGIN_ERROR_CODES` constants carry the new values. The kv and db `docsUrl` slugs follow the codes. `@arki/dot` documents `ARKI_<PKG>_PLUGIN_E<NNN>` as the recommended prefix.

### Patch Changes

- 1668156: Internal: replace `Array#toSorted` with a copy and `sort`, so the core entry runs on Hermes and passes the library lint preset.
- ec0bf8b: Fix: a call that replays an idempotency receipt no longer skips authorization. `j.command` takes an optional fourth argument, `{ authorize }`, which runs inside the command's transaction on every call, a replay included, before the stored result is returned. Move permission checks out of handlers and into `authorize`: a replay never runs the handler.
- Updated dependencies [228b4f5]
- Updated dependencies [9fa13ce]
  - @arki/dot@0.6.0

## 0.1.1

### Patch Changes

- Fix: `@arki/journal@0.1.0` could not be imported from npm. Its compiled code calls `getLogger` from `@arki/log`, but its manifest pinned `@arki/log@0.0.3`, which has no `getLogger`. This release depends on `@arki/log@0.1.0`, the version that has it.
- Updated dependencies [0685dfa]
- Updated dependencies
- Updated dependencies [2854df5]
  - @arki/dot@0.5.0
  - @arki/log@0.1.0

## 0.1.0

### Minor Changes

- Initial public release. A journal for Drizzle entities: every change is an immutable event row, the current state is a normal table row, and both are written in one transaction. Inline projections run in the same transaction; effects run after commit from a job table. Subpaths: `@arki/journal`, `/pg`, `/errors`, `/dot`, `/orpc`, `/testing`.
