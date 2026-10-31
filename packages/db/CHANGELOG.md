# @arki/db

## 0.5.1

### Patch Changes

- Updated dependencies [fac706c]
- Updated dependencies [7be13e9]
  - @arki/dot@0.10.0
  - @arki/resilience@0.3.2

## 0.5.0

### Minor Changes

- ebc681b: Stored values and shutdown no longer leak raw errors. The Postgres plugin now ends the query pool and the session pool even when the first `end()` throws, and reports every failure (an `AggregateError` when both fail). The `plainDate` and `instant` codecs, and the SQLite `instant`, throw an `UnexpectedFailure` carrying the new `StoredValueUnreadable` failure (`db.stored_value_unreadable`) instead of a raw `RangeError` for `infinity`, BC dates, malformed text, `NaN` and out-of-range milliseconds. `listenOnPool` rejects its start with `ListenUnavailable` (`db.listen_unavailable`, raw pool error as `cause`), and a throwing `onState` observer is logged instead of rejecting the start or breaking the listener. `runTransaction`, `runTransactionOnce`, `createUnitOfWork` (and so `transactionalProcedure`) and `listenOnPool` emit default `db.*` spans, and every observed operation records `db.operations` and `db.operation.duration`. Removed the dead `DbRuntimeLocalError`, `DB_RUNTIME_LOCAL_ERROR_CODES` and `DbRuntimeLocalErrorCode`. `createIdFactory` is marked deprecated. Migration: replace imports of the removed names with the canonical `DataDirInUse` failure; catch `UnexpectedFailure` where you caught `RangeError` from a temporal read.
- be8f8e2: SQLite through libSQL. `db()` from `@arki/db/libsql/dot` and `createLibsqlDb` (`@arki/db/libsql`) open a local file, `:memory:` or a Turso / libSQL server; `@libsql/client` is an optional peer, and only these two entries load it. `@arki/db/sqlite` re-exports `drizzle-orm/sqlite-core` and adds `idColumns`. `runTransaction`, `createUnitOfWork`, `isUniqueViolation`, `migrateDb`, `pendingMigrations` and `dbMigrations()` work on it: SQLite errors read as SQL-standard SQLSTATEs (`SQLITE_BUSY` is the retryable `40001`), and local writers take turns instead of failing with `SQLITE_BUSY`. New: `dialectOf`, `isTransaction`, `isLibsql`; `ARKI_DB_TX_E007` refuses SQLite drivers other than libSQL; `ARKI_DB_PLUGIN_E005` catches a URL given to the wrong plugin (a SQLite URL to `@arki/db/dot`, a Postgres URL to `@arki/db/libsql/dot`). `TransactionalDb`'s config is now `TransactionConfig` (`PgTransactionConfig & SQLiteTransactionConfig`), and `runTransaction` passes `{ isolationLevel: 'serializable', behavior: 'immediate' }`. `MigratableDb` now includes `LibSQLDatabase`: code that used it as its own query handle should name its driver's database type.
- 29520c1: A browser-safe `@arki/db/contract` entry, so an oRPC contract that ships to the browser never bundles drizzle-orm or a Postgres driver. It holds `TRANSACTION_FAILURES`, the six transaction failures (`TransactionConflict`, `TransactionUnavailable`, `TransactionRejected`, `TransactionCommitUncertain`, `TransactionCancelled`, `TransactionDefect`) and the type `TransactionFailure`. Ids for a contract come from `defineId` in `@arki/contracts`.
- b37115d: Return precise canonical outcomes from migration source reads, state inspection and application. Preserve unwrapped success, stop Dot boot on refusal and report unconfirmed application without automatic retry. Validate native bookkeeping rows through their source schema and expose original failure declarations through the browser-safe contract entry.

  Default migration spans preserve caller context and keep paths, SQL and private causes out of telemetry. Observe rejected telemetry acquisition and reserve synchronous execution as well as existing asynchronous ownership. Process/test callers handle migration failures explicitly. See the migration outcome upgrade guide; no demo impact because demos use the existing Dot boundary.

- 517d297: The column kit: a package writes each table once, against `ColumnKit<D>` (`@arki/db/columns`), and the app passes `pgColumns(schema?)` (`@arki/db/pg`) or `sqliteColumns({ prefix? })` (`@arki/db/sqlite`). Kit tables have exactly the types of hand-written `pgTable` / `sqliteTable` tables, and on Postgres drizzle-kit sees no difference, so moving tables to the kit needs no migration. On SQLite, `varchar(n)` / `char(n)` keep their limit as a `length()` `CHECK`, and index names take the prefix. `@arki/db/sqlite` also gains `instant`, a `Temporal.Instant` column stored as integer milliseconds. The kit's `serial(name?)` is an auto-incrementing primary key (`bigserial` on Postgres, `integer primary key autoincrement` on SQLite), and `@arki/db/sqlite` exports `sqliteNowMs`, the database clock in milliseconds.
- 9d408cf: Hosted Postgres behind a connection pooler (Neon, Supabase, PlanetScale Postgres, self-hosted PgBouncer). The `db()` plugin takes a `directUrl` thunk, falling back to the new `DB_DIRECT_URL` env var, and publishes `sessionPool`: a small pool on the direct URL for `LISTEN`, session locks and migrations. On a known pooled `DB_URL` (Neon `-pooler`, Supabase port `6543`) with no direct URL, the app still boots, and `sessionPool.connect()` rejects with `ARKI_DB_PLUGIN_E004` naming the host and the fix. `@arki/db/pg` exports `pooledHostOf`, `resolveDirectUrl`, `POOLED_HOSTS` and the `db.session_needs_direct_url` failure for apps without Dot. CockroachDB is checked by an opt-in test (`ARKI_DB_CRDB=1`): queries, `40001` retries, unique-violation errors and migrations work; `LISTEN` does not.

### Patch Changes

- b992897: Return canonical retry cancellation before dispatch and after cancelled rejected work, preserving completed outcomes and actual clock failure identity. Propagate the exact inferred RetryFailure union through helpers, composition and Dot; update Embeddings and HTTP policy types, RPC failure declarations and application template guidance. DB maps retry cancellation to its existing TransactionCancelled; Games Platform persists it as cancellation.

  no demo impact: no demo declares the narrower retry-wait outcome type; application failure admission is migrated. Embeddings changes only its existing optional policy type/schema binding.

- 6cc8655: `dialectOf`, `isTransaction`, `isLibsql` and `DIALECTS` are now public through `@arki/db/dialect`; the SQLite release named them but no entry exported them. `@arki/db/pg` exports `PgTableOf` and `@arki/db/sqlite` exports `SqliteTableOf`, so a package that emits declarations can name the type of a table built with a column kit.

  `@arki/db/errors` exports `findDatabaseError(error)` and its `DatabaseErrorFacts` type: the SQL-standard SQLSTATE (and, on Postgres, the constraint) of a database error, read the same way on Postgres and SQLite.

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

- 5d55e12: Remove Zod types from more public declarations, with no API change. `@arki/db`: `TransactionSettings` and `ResolvedTransactionSettings` are plain types, locked to their schema by an exact type test. `@arki/fs`: the `./pg` and `./sqlite` declarations no longer reach the wire schemas, and `UploadRequest` is a plain type with the same lock. `@arki/lock`: the table name schema is private to `pg/lease.sql`.

  No docs impact: no public name or behaviour changed. No demo impact: same reason.

- e132ad3: Object checks on unknown values now use `is(value, recordSchema)` from `@arki/schema` instead of hand-written `typeof value === 'object'` guards. Behaviour is unchanged.
- 49517e2: The build no longer compiles type tests (`*.test-d.ts`). They stay in `typecheck`, but a type test can no longer fail the build, and the published `dist` no longer holds compiled type tests.

  `@arki/db` exports the `OnDelete` type from `@arki/db/id` and `@arki/db/sqlite`. A package whose types come from `idColumns` (such as `@arki/auth`) can now build its declarations. Before, TypeScript could not name `OnDelete` and stopped with TS2883.

  `@arki/ai` drops a `@ts-expect-error` above the `@huggingface/transformers` import. That package is now always installed, so the comment had no error to hide and failed the build.

- b435e76: A command declares the events it writes. Breaking (0.x, no shims):

  - `j.command(name, input, options, handler)` replaces `j.command(name, input, handler, options?)`. `options.writes` is required: `{ writes: [OrderPaid] }`, or `{ writes: [] }` for a command that only runs child commands. `authorize` moves into the same object.
  - `write` in a handler takes only the declared events: anything else is a type error. At run time an undeclared event fails the run with `BAD_DEFINITION`, naming the command and the event, and nothing commits, even when the handler catches the error.
  - `Command` has a fifth type parameter, `Writes`, and a read-only `writes` field that keeps the exact tuple, so code can read it before boot. `CommandContext` has a third, `Declared`. `CommandOptions` has a fifth.
  - New type `CommandWrite<MetaOut, Tx, Declared>`, the type of `context.write`. A helper that takes `write` names what it writes; a command can pass its `write` only when it declares at least those events.

  `@arki/payments` moves its commands to the new form; its API does not change. The `@arki/dot` app-stack template and the `@arki/db` README show the new form.

  See `docs/upgrades/0.3.0-to-0.4.0.md`, step 12.

  docs: README (Quick start, Commands, Idempotent commands, Failures, Workflows, Dot), `docs/agent-guide.md` (model, write a command, rules that bite, errors, shared packages), `llms.txt`.
  demo impact: `demos/faultline` (commands and lesson 02) moves to the new form.

- e80211d: Return exact canonical engine refusals and final defects while preserving raw throw retry/fallback provenance. Remove obsolete operational error classes and guards; preserve static backoff diagnostics. Capture timeout/caller cancellation before observation. Infer heterogeneous policy unions.

  Migrate HTTP response/network mapping, DB exhausted SQLSTATE conflicts, Embeddings defect admission and RPC consumers together. See the Resilience 0.2.0-to-0.3.0 upgrade guide. No demo impact: the affected app callers and generator admission guidance are migrated in place.

- Updated dependencies [289ba73]
- Updated dependencies [c1ed2a3]
  - @arki/dot@0.9.0
  - @arki/resilience@0.3.1

## 0.4.0

### Minor Changes

- 7ce6a18: A PGlite data directory has one owner. `initDbRuntimeLocal` (and so `db({ driver: 'pglite', dataDir })`) takes an owner lock, `<dataDir>/.arki-owner`, before it opens PGlite. A second open while the first handle lives, in another process or in the same one, throws `DbRuntimeLocalError` with code `ARKI_DB_LOCAL_E001` and the owner's `pid` (both exported from `@arki/db/runtime-local`, with `DB_RUNTIME_LOCAL_ERROR_CODES`). A lock left by a process that is gone is taken over; there is no age-based takeover. `pglite.close()` gives the lock back, and so does a PGlite that fails to start (it used to stay open). `memory://` and `idb://` take no lock, and `node:fs` loads only for file paths.

  `createDb({ url })` no longer needs `DB_URL`: the pool settings are read without validating it. `getDbConnectionParams()` works without `DB_URL` too.

  Breaking (0.x): two handles on one PGlite directory used to open (and corrupt the data); the second now throws.

- 8b3cc80: First-class repositories, ids and keyset pagination (RFC `docs/rfcs/2026-10-15-dot-feature-builder.md`, phase 1c).

  - `@arki/db/dot`: `repos(database.provides.db, factories)` — a feature's repositories as one plugin, built once per boot and bound to the database the handle names (its type must be one the factories accept). `repos.withTx(tx)` rebinds the set to a transaction (a fresh set per call; nested transactions rebind the original set). `withTx` is a reserved name (compile error and `ARKI_DB_PLUGIN_E002`). `reader(repo, ['get'])` publishes bound methods for other features (`ARKI_DB_PLUGIN_E003` for a non-method).
  - `@arki/db/pagination` (new): `keysetQuery(keyset, columns)` — `orderBy`, `after(cursor)`, `take(limit)` (`limit + 1`) and `page(rows, limit)` for a `keyset()` from `@arki/contracts`.
  - `@arki/db/id`: `idColumns(defineId('sty_'))` — the column helpers of `createIdFactory` for an id declared in `@arki/contracts`. `createIdFactory` now builds its columns through it (same output).

- 115aa87: `@arki/db/dot` stores take the database from the feature, not from a handle argument.

  - Breaking: `repos(factories)` and `advisoryLocks(options)` drop the handle parameter. Both need `db` unbound; the feature declares it: `defineFeature('highlights').needs({ db: entrypointOnly(database.provides.db) }).infra(repos({ … }))`. A feature that declares no `db`, or one of another type, fails at `.infra()` (compile and runtime).
  - New `txRepos(factories)`: the same store for a scope that owns its transactions. The published `repos` has `withTx(tx)` only (`TxRepos<F>`), so no usecase can reach a database-bound repository.

- d471284: `@arki/db/dot`: `transactions<Db>()`, an infra plugin that needs `db` unbound and publishes one function, `transaction(fn)`: `fn` runs inside a transaction of the feature's database, committed on return and rolled back on a throw. Nothing else leaves it (no query builder, no `db`), so with `db` entrypoint-only a usecase may open a transaction but never run raw SQL. The `tx` it hands out is the database's own transaction type (`TxOf<Db>`); `OpenTransaction<Tx>` is the published function's type.
- 5e4c630: `transactions(handle)` takes the feature's database handle instead of a type argument: `transactions(database.provides.db)` replaces `transactions<Db>()`. The database and transaction types are read off the handle, and `.infra()` refuses a feature whose `db` need is another database's handle (compile error; `E026` at runtime). `db()` keeps its plugin name in the type (`Plugin<…, 'db'>`), `dbMigrations()` and `kv()` return what `plugin()` infers, so their handles carry `provider: 'db' | 'db-migrations' | 'kv'` instead of `string` and the feature builder's identity checks apply around them. Library plugins that need an app handle take it as a parameter, like `transactions(handle)`; a feature's own infra plugins may name handles directly in `needs` (the `arki-feature-layers/infra-runtime-imports` lint now allows the imports and bans only a plugin's own `feature.ts`, `usecases/` and `entrypoints/`).
- 7ce6a18: `pendingMigrations(db, options)` (from `@arki/db/migrate`) lists the migrations `migrateDb` would apply now, in order. It is read only and uses drizzle's own rule. `dbMigrations()` now provides `migrations: { pending }`: the names its boot found pending, read before it applied them. `dot dev` prints them.
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

- 232d3e8: Share bounded Web Crypto generation across modern and legacy IDs. Legacy
  `createId`, `createPrefixedId`, and factory `create`/`make`/`new` now return exact
  canonical generation failures. Preserve stored formats and prefixes, including
  legacy empty and punctuation prefixes, while removing the Cuid2 fallback to
  `Math.random`. Infer stored types from the successful schema and handle failures
  before side effects or string interpolation.

  Modern declarations use `defineId` with `IdOf` inferred from the canonical schema.
  Payment ID factory exports become browser-safe declarations; use `idColumns`
  for their table helpers. Payment provider creates and billing persistence return
  generation failures; webhook adapters must check these before acknowledgement.
  AI tombstone columns use modern declarations. Flow stops on returned failures;
  use `createFlow<State, Context>()(config)` to infer the exact node failure union.
  Ordinary patches cannot disguise a canonical failure through structural typing.

- 011ece7: Return exact ID generation failures from `defineId` and Auth generators, preserving
  successful prefixes and schema types. Validate and bound the entropy provider
  protocol; retain private causes and observe malformed asynchronous output.

  Propagate failures through modern consumers. Drizzle scalar defaults bridge at
  the foreign callback, while owned transactions restore canonical identity and
  roll back without replaying a returned refusal. FS upload creation returns before
  I/O and declares the same failure tuple in its native RPC contract.

  Handle `isFailure(id)` before using a generated ID. Derive stored ID types from
  the declaration or schema, not the generator's `ReturnType`. See Contracts'
  `docs/upgrades/typed-ids.md`. Legacy DB generators remain unchanged pending their
  separate consumer migration.

- 71dea3e: Carry inferred failures through configure, boot, start, stop and dispose, with atomic service publication, rollback aggregation and supervised usecase invocation even without tracing. Configure now returns a typed outcome and remains synchronous with no I/O; logging activates during boot. Detached lifecycle callbacks must prove an undefined or concrete failure return rather than void.

  Breaking: check configure before accessing the manifest, inspect stop/dispose outcomes, and handle managed CLI preflight failures under `dot.preflight_failed` in `.error.data.{app,migrations,report,failure}` (exit 3). Successful JSON paths remain unchanged. See `docs/upgrade-phases.md` for phase-specific outcomes and migration steps.

  Cron oRPC adapters route canonical supervised defects through the existing failure policy before success mapping; business refusals keep their explicit responders.

  Database, mail, queue, resilience and Journal adapters retain their authored factory and lifecycle return types, including driver-specific service types.

- 9281865: `listenOnPool` moves from `@arki/journal` to `@arki/db/pg`, with `ListenClient`, `ListenPool`, `ListenOptions` and `unrefTimer`. **Breaking for `@arki/journal`:** it no longer exports `listenOnPool`, `ListenClient` or `ListenPool`; import them from `@arki/db/pg`. `journal.worker(db, { listen })` is unchanged. The listener now also handles an `end` without an error, runs a `select 1` health check every `healthMs` (default 5000; no answer by the next check drops the client), reports `onState('ready' | 'disconnected')`, releases a lost client exactly once, and forwards nothing from a released client. `ListenClient` gains `on('end')`. `@arki/db` no longer has a dev dependency on `@arki/journal`; the two tests that used both now live in `@arki/journal`.

  `@arki/live/pg` (milestone M1): `liveMigration` generates the reviewable trigger SQL (statement triggers that publish `{ v: 1, tag }` at commit; partition leaves publish their root), `liveChannel`, `verifyLiveTriggers` lists every table that would not publish (missing, disabled or replica-only, wrong function, events or arguments, uncovered partition leaf), `touch` publishes tags from inside a transaction, and `pgSource` is the hub's source on a `pg` pool: `ready` only after `LISTEN`, `gap` on a lost listener or an unreadable payload. Each hint carries the committing transaction's id (`txid`, `pg_current_xact_id()` as a decimal string), and the hub's `change` frame now has `txids` (strict schema change). The generated SQL splits statements with `--> statement-breakpoint`, so Drizzle's migrator runs it on PGlite too. `@arki/db` is a new optional peer.

- 62ec96a: Return a canonical failure from a transaction callback to roll back its writes and preserve the original failure. Successful callbacks commit. The transaction helpers now expose inferred failure outcomes for database faults, cancellation and uncertain commits; inspect those outcomes before using success values.

  Serializable retries remain bounded to PostgreSQL serialization failures and deadlocks. An uncertain commit is never automatically replayed. Plain transaction wrappers retain their existing isolation and single-attempt behavior.

  Transactional oRPC procedures declare the canonical transaction error map. Their middleware classifies `result.output` and preserves the surrounding result metadata. See the database transaction upgrade guide for caller and contract migration steps.

- 232d3e8: Cursor encoding and decoding return canonical failures. Database pagination
  preserves those outcomes before building SQL or returning a page. Check codec
  results and declare the original cursor failures at RPC boundaries.

  Failure lint rules now catch discarded callback returns, nested aggregate and
  iterator results, and blind acceptance through aliases or generic failure guards.
  Handle each outcome or forward it to its owner.
  Browser contract linting admits canonical failure definitions while keeping
  exception bridges in implementations.
  The exported lock conformance suite now checks each queued task's acquisition
  outcome before accepting its completion counts.

  Dot acquires telemetry instruments inside guarded execution, so importing before
  SDK setup works and broken reporters cannot replace application outcomes.

- 7b4b5bf: Transactional procedures. Three new entries:

  - `@arki/db/transaction`: `runTransaction(db, work, options)` runs `work` in one SERIALIZABLE transaction and reruns it on SQLSTATE `40001` / `40P01` only (bounded: `retries` 0–10, default 3; jittered 10–250 ms waits). Also `retryableSqlState`, `DbTransactionError` (`ARKI_DB_TX_E001`–`E006`), `isDbTransactionError`, `parseTransactionSettings`. Portable.
  - `@arki/db/orpc`: `transactionalProcedure(db, { repos, retries })` is an oRPC middleware that gives the handler `tx` and repositories bound with `withTx(tx)`, reruns the handler on a conflict, and maps exhaustion to `ORPCError('CONFLICT')` (409). Use with `implement(contract, transactionalProcedureConfig)`, as the last `.use()`. `TransactionScopeOf<typeof transact>` is the scope a usecase takes. Portable.
  - `@arki/db/eslint`: the type-aware rule `db/no-effects-in-transaction` reports `fetch`, queue writes (`Queue#add`, `trigger()`, `enqueue()`) and `.effect()` inside transactional code.

  `TransactionalDb` now accepts the transaction config: `transaction(fn, config?: PgTransactionConfig)`. A database whose `transaction` takes no config still fits; `createUnitOfWork` is unchanged.

  New dependencies: `@arki/resilience` and `@arki/clock` (and, through resilience, `cockatiel` and `@arki/failure`). New optional peers: `@orpc/server`, `@typescript-eslint/utils`, `eslint`, `typescript`. The package now ships `llms.txt` and `docs/`.

- f2e9f69: Breaking: `defineEnv` now validates in every environment. `CI` and `lint` runs no longer skip validation. The only implicit opt-out is `SKIP_ENV_VALIDATION=1` (exactly `1`); set it only in build stages that run without secrets. `options.skipValidation` still overrides it. The `@arki/env/dot` plugin now validates at boot and fails with `ARKI_ENV_PLUGIN_E001` (new `ENV_PLUGIN_ERROR_CODES`), and `EnvServices['env']` is derived from `defineEnv` without a cast.
- 232d3e8: Repair schema/type agreement across Drizzle validators, ID factories and AI configuration.

  Breaking: generated table validators no longer claim phantom `$type<T>` shapes. Use a runtime schema with `jsonColumn` and reuse it in explicit validator refinements for precise input/output types. Bare JSON columns retain the native runtime validator and its honest inferred type.

  Breaking: `createIdFactory(prefix)` infers its ID from the literal prefix; remove the former second type argument. Payments ID aliases now reflect the prefixes their generators already produce. Existing generated values and stored IDs are unchanged.

  Breaking: replace AI `SearchOptionsType` with `SearchSettings`, and `AIServiceConfigType` with `RAGServiceConfig`. The `@arki/ai/types` aliases use those same distinct names. Provider configuration and sanitizer patterns now share their actual validation schemas, preserving custom `RegExp` rules.

  See `docs/features/arki-framework/migrations/defined-once.md` for migration examples and compatibility notes.

- 670554a: Return canonical failures from local PGlite initialization and expose typed
  owned cleanup. Generate a nominal UUID owner ID before filesystem mutation,
  propagate exact failures through the Dot provider, and supervise Drizzle
  construction and failed startup cleanup. Check `isFailure` before using the
  result and use its `close()` method for typed cleanup. Raw PGlite retains its
  foreign close contract.

### Patch Changes

- 5bc6390: `db()` publishes through a `provides` factory (`database.provides.db` is a typed handle before boot) and the pg driver takes `url?: () => string | undefined`, read at boot and falling back to `DB_URL`. `createDb()` accepts an optional `url` that overrides `DB_URL`.
- 232d3e8: Propagate exact Clock sleep failures through retry policies, composition, fallback helpers and Dot services. Retry stops on a failed wait. Owned scopes recognize canonical Clock cancellation only with their private cancellation cause. Callers must inspect retry outcomes; success remains unwrapped.

  Transactions and HTTP clients map wait refusals to their existing cancellation/defect contracts without repeating the operation.

- 3359639: Add `mergeRelations` to `@arki/db/orm`. It joins several `defineRelationsPart(...)` results into one relations config, merging per table, so features can each declare their own relations without losing keys on shared tables. The same relation declared twice throws `DB_COMPOSITION_E004`.
- cbefc52: Dot plugins no longer pass a hard-coded `version` (the field was removed from `@arki/dot`).
- b9ae16f: Trace local database initialization, file ownership acquisition and owned close
  through the application-configured OpenTelemetry provider. Spans inherit the
  active caller context and record only canonical failure codes. Concurrent close
  calls share one attempt; broken or reentrant reporting cannot duplicate work,
  alter exact failure results or release unconfirmed ownership.
- 953991a: Docs standard: new `AGENTS.md`, a README in the standard section order with a tested quick start, `Limits` and `Failure behaviour`, a rewritten `llms.txt` with import paths, an agent guide with a model, a task map and a verify section, a backup and restore recipe, and `@fix` and `@verify` tags on every error code. A code comment no longer names an app.

  no demo impact: documentation and doc-example changes only, runtime behaviour unchanged

- 2ce7fe2: New `@arki/db/errors` entry with `isUniqueViolation(error, constraint?)`: the "insert, and answer CONFLICT on a duplicate" check, read the same way for node-postgres, PGlite and Bun SQL, and through Drizzle's `DrizzleQueryError`. Bun SQL puts the SQLSTATE in `errno` and its own name (`ERR_POSTGRES_SERVER_ERROR`) in `code`, so a check that reads `code` never matched there.

  Fix: `runTransaction` now retries a `40001` / `40P01` raised by Bun SQL. `retryableSqlState` stopped at Bun's `code` and never saw the SQLSTATE in `errno`, so under Bun a serialization failure or deadlock reached the caller on the first try.

  `@arki/journal` uses the shared check in place of its private copy, and no longer matches the error message text.

## 0.3.1

### Patch Changes

- Updated dependencies [0e2ed57]
  - @arki/contracts@0.1.0
  - @arki/dot@0.6.1
  - @arki/env@0.0.11

## 0.3.0

### Minor Changes

- 13bb516: Move the `dbMigrations` DOT plugin from `@arki/db/migrate` to `@arki/db/dot`. `@arki/db/migrate` keeps `migrateDb`, `readMigrations` and the types, and no longer imports `@arki/dot`. Replace `import { dbMigrations } from '@arki/db/migrate'` with `import { dbMigrations } from '@arki/db/dot'`.
- 9fa13ce: Dot plugin error codes join the `ARKI_` scheme: `KV_PLUGIN_E001` is now `ARKI_KV_PLUGIN_E001`, `DB_PLUGIN_E001` is `ARKI_DB_PLUGIN_E001` and `JOURNAL_PLUGIN_E001` is `ARKI_JOURNAL_PLUGIN_E001`. Code that matches on the old strings must update; the `*_PLUGIN_ERROR_CODES` constants carry the new values. The kv and db `docsUrl` slugs follow the codes. `@arki/dot` documents `ARKI_<PKG>_PLUGIN_E<NNN>` as the recommended prefix.

### Patch Changes

- Updated dependencies [228b4f5]
- Updated dependencies [9fa13ce]
  - @arki/dot@0.6.0
  - @arki/env@0.0.10

## 0.2.0

### Minor Changes

- 11f2ba7: Temporal values end to end. `@arki/date/serialize` adds `temporalJsonSerializers` (oRPC `customJsonSerializers` for `Instant`, `ZonedDateTime`, `PlainDate`, `PlainDateTime` and `Duration`) and `registerTemporalTypes(superjson)`, so values keep their type across `RPCHandler` → `RPCLink` and SSR dehydration.

  `@arki/db/temporal` columns now use Drizzle's exact SQL type names (`timestamp with time zone`, `timestamp`, `date`), so adopting them never produces a migration, and declare Drizzle's `:string` codecs so every driver, Bun SQL included, returns Postgres text. `instant(name, { withTimezone: false })` maps an existing `timestamp` column, read as UTC like Drizzle's own column. Parsing is strict: `infinity` and BC values throw.

### Patch Changes

- 0685dfa: Mistakes in declarations are now caught as early as possible: by TypeScript when the types can say it, otherwise by a coded error when the module loads.

  - `@arki/feature`: `composeRouter` and `composeRepos` reject a key claimed by two features at compile time. The runtime check stays as a backstop and now throws `FeatureError` with code `FEATURE_E001` (router) or `FEATURE_E002` (repo) and a `remediation`. Messages are unchanged.
  - `@arki/http`: mount paths for `rpcMount(...)` and `.mount(...)` are typed `MountPath` (`` `/${string}` ``), so a path without a leading `/` is a compile error. The runtime check stays.
  - `@arki/db`: the projection builder's two "call .named() / .on() first" errors are now `DbCompositionError` with codes `DB_COMPOSITION_E002` and `DB_COMPOSITION_E003`. `DbCompositionError` gains an optional `remediation`.
  - `@arki/dot`: when `dot explain` or `dot doctor` cannot import the app because a declaration threw a coded error, the output shows that error's code and its fix, not only "import failed".

- Updated dependencies [3c2cc9d]
- Updated dependencies [e115648]
- Updated dependencies [11f2ba7]
- Updated dependencies [0685dfa]
- Updated dependencies
- Updated dependencies [91efd52]
- Updated dependencies [2854df5]
  - @arki/date@0.2.0
  - @arki/dot@0.5.0
  - @arki/env@0.0.9
  - @arki/log@0.1.0

## 0.1.9

### Patch Changes

- 1cab84d: Add `@arki/db/migrate`: `migrateDb(db, { migrationsFolder })` applies drizzle migrations to a handle from either driver, and `dbMigrations()` is the DOT plugin that does so at boot (mount it after `db()`, before features). Consumers no longer import drizzle's migrator modules themselves, which outside the monorepo pulled in a second `drizzle-orm` with mismatched types.

  Both also accept `{ migrations }` — a list already in memory — and `readMigrations(folder)` produces that list at build time. A bundled server (Nitro, `.output/`) has no `drizzle/` folder next to it, so the app commits a generated module instead.

  Fix: the PGlite driver (`db({ driver: 'pglite' })` and `initDbRuntimeLocal`) now honours the `logger` option like the pg driver does; before, it was silently dropped.

  Found while building the Drop Studio demo against the published packages.

## 0.1.8

### Patch Changes

- Dependency refresh: `drizzle-orm` 1.0.0-rc.4, `zod` 4.6.5, `pg` 8.23.1, `postgres` ^3.4.9, `@electric-sql/pglite` ^0.4.6, `@t3-oss/env-core` ^0.13.11; internal `@arki/*` pins updated. No API changes.

## 0.1.7

### Patch Changes

- Docs-only: READMEs updated to the plugin() nomenclature (the pip → plugin rename shipped in @arki/dot 0.4.0); examples import from `@arki/dot/plugin`.

## 0.1.6

### Patch Changes

- Lazy primitives family + client-surface hardening.

  - `@arki/ts`: new `once()` (zero-arg memo; memoizes `undefined`, sync throws retry, promises shared), hardened `lazyObject()` (`set`/`deleteProperty`/`getPrototypeOf` traps — writes land on the real instance, `instanceof` answers truthfully), new `Lazy<T>`/`resolveLazy` deferred-config vocabulary, and a `./testing` entry with `expectImportPure()` (subprocess import-purity harness).
  - `@arki/env`: `defineEnv` now delegates its lazy proxy to `lazyObject` (single trap implementation).
  - `@arki/kv`: `kv()` accepts a whole-options thunk — `kv(() => ({ url: env.REDIS_URL }))` — keeping declarations import-pure; per-field `url` thunk kept for compatibility.
  - `@arki/http`: `port` adopts `Lazy<number>`; documented why `bundles`/`features` tokens cannot defer (declaration-time wiring).
  - `@arki/contracts`: `browser` exports condition serves a zod-only build (no `drizzle-orm`) to client bundlers; table wrappers are node-only and fail loudly at bundle time from browser code.
  - `@arki/db` / `@arki/event-sourcing`: republished to align the `@arki/dot` peer range with 0.4.0.

- Updated dependencies
- Updated dependencies
  - @arki/dot@0.4.0
  - @arki/env@1.0.0
  - @arki/contracts@0.0.3

## 0.1.5

### Patch Changes

- Updated dependencies [4b1c59f]
  - @arki/dot@0.3.0
  - @arki/env@1.0.0

## 0.1.4

### Patch Changes

- Updated dependencies [48a8733]
  - @arki/dot@0.2.0
  - @arki/env@0.0.5

## 0.1.3

### Patch Changes

- Updated dependencies [9871fce]
  - @arki/dot@0.1.3
  - @arki/env@0.0.4

## 0.1.2

### Patch Changes

- Ship TypeScript source in the npm tarball (`src/**` added to `files`). npm installs and the read-only GitHub mirrors now carry the original `.ts` source alongside compiled `dist/` — better debuggability on the experimental track. No runtime changes.
- Updated dependencies
  - @arki/assert@0.0.2
  - @arki/contracts@0.0.2
  - @arki/log@0.0.2
  - @arki/env@0.0.3
  - @arki/dot@0.1.2

## 0.1.1

### Patch Changes

- DOT v2 pip contract — typed dependency injection (BREAKING on the experimental track).

  `pip()` replaces `defineDotPip`: pips declare consumed services as `needs` shapes of type witnesses (`service<T>()` app-local, `token<T>()('key')` cross-package) and hooks destructure them fully typed; provides are inferred from `boot`'s return value. `.use()` is compile-time guarded (unsatisfied needs, type mismatches, wire-key collisions fail at the call site). Declaration order is boot order — the topological sort and name-based `dependencies` are gone; manifest dependency edges are observed from actual wiring. `rename(pip, map, name?)` is the multi-instance primitive, replacing the adapters' silent last-writer-wins `name` options. `lazy(init, { dispose? })` defers expensive opens behind a memoized single-flight `Lazy<T>` handle the kernel auto-disposes; `service.lazy<T>()` lifts eager or lazy providers into a uniform handle. The four `/dot` adapters (`@arki/env`, `@arki/kv`, `@arki/db`, `@arki/event-sourcing`) are migrated to the new contract.

- Updated dependencies
  - @arki/dot@0.1.1
  - @arki/env@0.0.2

## 0.1.0

### Initial release

- First public publication on npm (experimental track) — 2026-05-21.

  **`@arki/db`** is the database adapter for the ARKI kernel — the Wave 3 infrastructure layer that plugs into `@arki/dot` via the pip-and-adapter contract. It provides:

  - **PGlite + Drizzle ORM** runtime — embedded Postgres with type-safe queries
  - **DOT lifecycle integration** — registers as a `database` pip, contributing to `DotAppManifest.database` + `DotDiagnosticsSnapshot.database`
  - **`runtime-local` preset** — single-binary embedded mode for self-hosted deployments

  **Why `0.1.x`, not `0.0.x`**: same rationale as `@arki/dot` — adapter layer, experimental but past first integration. `0.1.x` signals "kernel-tier component" without claiming API stability.

  **Dependencies** (all live on npm at `0.0.1`):

  - `@arki/assert` `0.0.1`
  - `@arki/contracts` `0.0.1`
  - `@arki/log` `0.0.1`

  **Peer dependencies**:

  - `@arki/dot` `^0.1.0`

  Ships together with `@arki/dot@0.1.0`, `@arki/kv@0.1.0`, and `@arki/event-sourcing@0.1.0`.
