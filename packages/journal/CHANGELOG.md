# @arki/journal

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
