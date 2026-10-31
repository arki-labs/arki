# @arki/schedule

## 0.1.0

### Minor Changes

- 2c57c1c: Preserve typed business failures across job execution, scheduled runs and durable
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

- a83e735: Durable crons now work without Dot. `@arki/schedule/runtime` exports `createScheduleRuntime` (and its option and result types); the main entry stays free of the logger and timers. `@arki/queue` exports `createDurableScheduler` from its main entry, so a plain process can pass it as `createScheduleRuntime({ durable })`.

  `@arki/schedule` now typechecks its tests, and a new test wires `@arki/queue`'s `durableScheduler()` into `schedule({ durable })`, so the typecheck fails if the queue's copy of the durable port drifts from the schedule's. `@arki/queue` is a dev dependency of `@arki/schedule` for that test only.

- a905468: One way to write middleware (RFC `docs/rfcs/2026-10-21-dot-middleware.md`, steps 1 and 2):

  - A step is a plain function: `(ctx) => object | Failure`. It reads the least context it needs, adds the keys of the object it returns, or refuses the call with a typed failure.
  - An around is a plain function: `<T>(ctx, next: () => Promise<T>) => Promise<T>`. It wraps everything declared after it and the handler, for a transaction, a retry or a span. It adds nothing to the context.
  - Order is declaration order. A step sees every key added before it.

  Each transport attaches the same functions:

  - `@arki/dot/orpc`: `impl.refund.use(step(authed)).use(around(inTransaction))`. A refusal is thrown as the typed error the procedure declares; a procedure that does not declare the step's failure does not compile.
  - `@arki/http`: `routes().use(step(authed)).use(around(inTransaction))`. A refusal answers with the same coded error envelope as a failure the handler returns; every route bound after the step must declare its failures. `step(fn, { failureHeaders })` adds response headers to a refusal (a `www-authenticate` challenge, say), typed by the step's own failures.
  - `@arki/queue`: `q.job.use(step(actorFromData)).use(around(inTransaction))`. A refusal is the job's outcome, as if the handler had returned it.
  - `@arki/schedule`: `defineSchedule({ …, with: [asSystem, inTransaction], handler })`. A refusal makes the run `refused`.
  - `@arki/cli`: `defineCommand({ …, with: [asOperator], run })`. `with` also wraps `preview`. A refusal is the command's failure: same exit code and error output as a failure returned from `run`.

  In `with: [...]` lists, an around is told from a step by `fn.length >= 2`: declare `next` as a plain second parameter (no default value, no rest parameter).

  Outside oRPC, a refusal reaches an around as the value `next()` resolves to, not as a throw: the `Failure` itself on queue, schedule and CLI, the refusal's `Response` on HTTP. An around that must roll back on a refusal checks `isFailure` on the result (on HTTP, the response status). A thrown error still rejects `next()`.

  `@arki/failure/orpc` adds `rpcError(failure, errors)`: the declared `ORPCError` for a failure already in hand, to throw.

- f3c95a0: `runtime.start()` now returns a promise that resolves a `schedule.durable_start_failed` failure when the durable backend refuses to register the durable schedules, so a refused start is no longer only logged. In-process timers are still armed before the first await. Await it and handle the result (`orThrow(await runtime.start())`). The lock-error code is read with a schema, not a hand-written guard.
- d16933c: Schedules can run under a lock (RFC `docs/rfcs/2026-10-15-dot-feature-builder.md`, phase 1c).

  - `schedules(core, [{ ..., lock: true | 'key' | { key?, holdAtLeast? } })`: `true` locks on the schedule name; a string shares one key so two jobs exclude each other. A run that finds the lock held reports `skipped-lock`. The lock is held until the job ends (no fixed-time lease). The KV lease path is gone: a schedule has no `lock` option on the driver any more.
  - The lock stays held at least `holdAtLeast`, default `1s` (`0` turns it off), so a replica with a slow clock cannot rerun a sub-second job. `trigger()` and the shutdown drain wait for the release.
  - A `lock:` schedule needs a `locks` service; without one it is a compile error. `locks(...)` from `@arki/lock/dot` provides it, on any `@arki/lock` store.
  - `Locker` (new type): the whole lock port — `mutex(key).tryRun(fn, { holdAtLeast })` returns the handler's value, or a `lock.held` failure when another instance holds the lock. Structural, so any lock library can implement it and this package needs no database. The handler gets `run.lock` (`{ signal, fence }`) as its second argument.
  - `dot explain` shows each schedule's lock key.

- 2c57c1c: A busy lock is now the `LockHeld` failure from `@arki/failure` (code `lock.held`, status 409), returned, never thrown. Its data is `waitedMs` (0 for the one-attempt verbs) and, only when `createLocks` got `logKeys: true`, the full `key`. `tryRun(fn)` returns the value of `fn` or `LockHeld`: the `{ ran, value }` wrapper and the `LockRun` type are gone. `tryAcquire()` returns a `Guard` or `LockHeld` (was `undefined`). `run(fn, { wait })` and `acquire({ wait })` return `LockHeld` when the lock is still busy after the wait (they threw `LockError` code `held`). The `held` code (`ARKI_LOCK_E001`) is removed from `LockError`; `aborted`, `lost`, `store`, `release`, `config` and `unsupported` stay thrown. Check a result with `LockHeld.is(result)`. `@arki/schedule`'s `Locker` port follows: `tryRun` returns the value or a `lock.held` failure (`LockerRun<T>` is `T | Failure<'lock.held'>`).
- a077b15: New entry `@arki/schedule/orpc`: serve feature schedules as one oRPC cron contract (RFC `docs/rfcs/2026-10-15-dot-feature-builder-cron.md`).

  - `cronContract(specs)`: one `POST /<name>` procedure per schedule; you write the name and its 200 body schema (or `{ body, skipped }` for a legacy lock-held body).
  - `cronRouter(os, contract, features, policy)`: a compile error when a name is not a schedule of any feature, or when a body schema is not exactly the run's value and no `respond` maps it.
  - Replies `ok`, `fail`, `rethrow`, `skipped`; `cronErrorBody` for `OpenAPIHandler`, so an error answers exactly the policy's body; `validated(schema)` checks a value but keeps the original (key order included).
  - Optional peers `@orpc/contract` and `@orpc/server`. No `node:` import.

- f43313b: Each schedule now chooses whether it is durable, and lock failures are reported.

  - `defineSchedule({ ..., durable: true })`, for `cron` and `every`, hands the schedule to a durable backend. `schedule({ ..., durable: DurableSchedules })` takes that backend as a typed need; `durableScheduler()` from `@arki/queue/dot` provides it on BullMQ. Each tick runs once across replicas, with no KV lock, and a tick missed while no worker ran runs once when a worker returns. The default (`durable: false`) is unchanged: in-process timers that skip ticks missed while down. The README states the missed-tick rules.
  - Mistakes are caught early. Passing `durable: DurableSchedules` with no backend mounted before it is a type error. A `durable: true` schedule with no backend fails boot with `ARKI_SCHEDULE_E005`, naming the schedule. A durable name containing `:` throws `ARKI_SCHEDULE_E001` from `defineSchedule`.
  - New port types `DurableScheduler` and `DurableScheduleRegistration` let another backend implement durable schedules.
  - A broken lock store is no longer reported as a held lock. The run returns the new status `lock-failed` and counts in the new `lockFailures` (a lock lost during the run counts in `lockLost`); `lockContention` counts only "another replica holds the lock". Lock failures and handler failures are now logged as errors through `@arki/log`, not only at debug level.

  Breaking, so a minor bump while the package is below 1.0: `ScheduleDef` has a new required `durable` field, `ScheduleRunStatus` has a new member, the schedule-table projection rows have a new `durable` field, and a dashboard that read the old `lockSkips` as "any lock skip" should read `lockContention` and add `lockFailures` and `lockLost`.

- d9d791f: First public release of `@arki/schedule`: cron and interval schedules that run in process or on a durable queue backend, with locks and typed run results. no demo impact: no registered demo (`drop-studio`) imports `@arki/schedule`.
- 792768a: `@arki/schedule`: `schedule()` is a driver for `.serve()` and collects every bound feature's `schedules` slice; the `features` option and the feature-token option types are removed. App-level `schedules` are optional. Feature schedules are no longer checked against `context` at compile time (features bind at runtime); a malformed slice fails boot with `ARKI_SCHEDULE_E001`.

  `@arki/queue`: `queueRuntime()` is replaced by two units. `queue({ connection, keyPrefix? })` goes in `.use()` and provides `queue: QueueClient` (`enqueue(job, data, opts?)`), so features can enqueue. `queueWorker({ q, needs, context })` goes in `.serve()` and runs the features' `jobs()` slices, using the client's connection and key prefix. `jobs()` slices carry only producer actions; the worker owns the consumer actions. `QueueFeatureToken`, `QueueRuntimeOptions`, `QueueRuntimeFeatureOptions`, `QueueFeatureNeeds`, `QueueRuntimeHandle` and codes `E004`/`E005` are removed; a missing client fails with `ARKI_QUEUE_E006`.

- 57e9b4b: Rename three `@arki/schedule/orpc` exports so names say what they do: `cronContract()` is now `defineCronContract()`, `cronRouter()` is now `cronRouterFor()`, and `validated()` is now `checkOnly()`. The old `cronContract` and `cronRouter` clashed with the names apps give their own exports, so apps had to alias them. `validated` hid that it returns the original value, not the parsed one. Behaviour is unchanged.
- c3e63ba: Entrypoint handlers are now typed with what they really receive at every builder stage. `EntrypointServicesOf<typeof core>` is new in `@arki/dot`: a feature's `entrypointOnly` needs plus its `usecases`. `endpoints(core, build)` and `schedules(core, defs)` use it, so a feature with no `.usecases()` can now read its `entrypointOnly` needs in a route or schedule, and can no longer read plain needs that never arrive. A rebound `entrypointOnly` lazy need (`feature.instance(name, rebind)`) now stays entrypoint-only.
- 94a1ee6: Nested features: `composeSchedules([parent], scheduler)` and `cronRouterFor` know the schedule names of every feature nested under the ones you pass (`ScheduleNameOf` and `ScheduleValueOf` walk `.features(...)`), and `schedule()` runs each nested feature's schedules once.
- 2c57c1c: Carry inferred failures through configure, boot, start, stop and dispose, with atomic service publication, rollback aggregation and supervised usecase invocation even without tracing. Configure now returns a typed outcome and remains synchronous with no I/O; logging activates during boot. Detached lifecycle callbacks must prove an undefined or concrete failure return rather than void.

  Breaking: check configure before accessing the manifest, inspect stop/dispose outcomes, and handle managed CLI preflight failures under `dot.preflight_failed` in `.error.data.{app,migrations,report,failure}` (exit 3). Successful JSON paths remain unchanged. See `docs/upgrade-phases.md` for phase-specific outcomes and migration steps.

  Cron oRPC adapters route canonical supervised defects through the existing failure policy before success mapping; business refusals keep their explicit responders.

  Database, mail, queue, resilience and Journal adapters retain their authored factory and lifecycle return types, including driver-specific service types.

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

- 40e21b4: Return canonical lock cancellation, backend, ownership-loss and release outcomes; preserve callback failure identity and supervise defects without replay. Add nominal resource/owner/fence identities, schema restoration, and default OpenTelemetry spans and bounded counters. Named stores, DDL and disposal own their operational failures. Schedule admits the exact canonical lock union and never treats provider failure as contention. Immediate application consumers propagate outcomes; native RPC and disposal protocols retain explicit typed bridges.

  Breaking: branch all failures before using a callback or guard result; parse low-level keys, owner tokens and fences through `@arki/lock/zod`. Manual release and extension return failures; successful-callback cleanup preserves the completed result and reports uncertainty. Leadership stops on callback failure, defect or lost ownership. Existing key bytes, fencing and late-grant return remain unchanged.

  Docs and examples describe the changed behavior. No demo impact: this package has no standalone demo application.

- 3468b2d: Feature schedules now work with `feature.instance('eu', rebind)`. A schedule of an instance registers as `<name>#<instance>` (for example `send-digest#eu`), so two copies of one feature no longer clash, and `trigger` and `composeSchedules` use that name. A default lock key follows the qualified name, so each instance has its own lock; a custom `lock` key stays shared. A plain feature keeps its exact names, lock keys and action ids.
- 1a897f8: Handler events (RFC `docs/rfcs/2026-10-21-dot-middleware.md`, step 3). Every handler a Dot app mounts — an oRPC procedure through `bind`, an HTTP route or `rpc()` mount, a queue job, a schedule run — now reports to the app's lifecycle observers:

  - A handler event has `kind: 'handler'`, `transport` (`'rpc' | 'http' | 'job' | 'schedule'`), `feature` (the owning unit) and `name` (the oRPC path, `METHOD /path`, the job or schedule name). Its `status` is `starting`, then `completed` (with `durationMs` and `outcome: 'ok' | 'refused'`; a refusal carries its `failure`) or `failed` (a throw, with `error`). A returned failure or a step's refusal is `completed/refused`, never `failed`. On oRPC, a thrown error below 500 is a refusal.
  - `@arki/dot` adds two observers for `defineApp(name, { observers })`: `reportErrors({ report })` calls `report(error, { transport, feature, name })` for every `failed` handler, and `logHandlers()` writes one DEBUG line per handler on `arki:dot:handlers`. With no observer registered, a handler call costs nothing extra.
  - Transport adapters reach the emitter through `handlerObserverOf(services)` from `@arki/dot/feature` (`watching()`, `run(ref, work, outcome?)`); the kernel context carries it as `$handlers`.
  - Breaking: `errorCaptureMiddleware` is removed from `@arki/dot/orpc`. Register `reportErrors({ report })` instead; it keeps the same rule (a 4xx is traffic, anything else is reported).
  - Breaking: `@arki/queue` removes its standard middleware (`timingMiddleware`, `loggingMiddleware`, `errorHandlingMiddleware`, `validationMiddleware` and the other `src/middleware` exports). Timing and logging are `logHandlers()`, error reporting is `reportErrors()`, validation is `.input(schema)`, timeouts are `options.timeoutMs`, and a per-job logger is a `step`.
  - `@arki/failure/orpc`: the `ORPCError` that `rpcError` and `orThrowRpc` throw carries the failure as its `cause`, on the server only (oRPC never sends `cause` to the client).

- 17e86d3: Breaking: the object-form feature API is removed. Write every feature as a `defineFeature(name).needs().infra().usecases().provides().entrypoints()` chain.

  - `@arki/dot`: removed `feature()`, `plug`, `composeRouter`, `composeRepos`, `tokenOf`, `entrypointsOf` and the types `AnyFeature`, `MountedFeature`, `UnitOf`, `MountedUnitsOf`, `FeatureConfig`, `ComposedRouter`, `ComposedRepos`. `defineApp().features()` takes chain features only. Use `routerFor(rpcContract, features)` instead of `composeRouter`, and a feature's own `repos({...})` store instead of `composeRepos`. Read `f.entrypoints` instead of `entrypointsOf(f)`. Lifecycle hooks (`boot`, `start`, `stop`) live on an infra unit inside the feature.
  - `@arki/http`: removed `endpoints(build)` and `EndpointsFeatureSlice` from the root export. Use `endpoints(core, build, { contracts })` from `@arki/http/dot` in `.entrypoints()`.
  - `@arki/schedule`: removed the `schedules(needs, defs)` overload. Use `schedules(core, defs)` in `.entrypoints()`.
  - `@arki/queue`, `@arki/journal`, `@arki/admin`: dropped their object-form branches. The chain API is unchanged.

### Patch Changes

- 5d55e12: Docs only: the README section "Steps and arounds" moves after the required opening sections. No code change.
- ff85471: Go to Definition works on mapped keys again. Handle maps (`unit.provides.x`, feature handles), `PolicyTree`, `SessionValues`, `CronPolicy.respond`, `ChartConfig.theme`, `Operations` and the oRPC utils tree now map `[K in keyof T as K & string]` instead of `[K in keyof T & string]`. The old form cut the link from each key back to its declaration, so the editor found no definition. Types are otherwise unchanged.
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

- 745a2c3: Dot plugins no longer pass a hard-coded `version` (the field was removed from `@arki/dot`).
- e132ad3: Object checks on unknown values now use `is(value, recordSchema)` from `@arki/schema` instead of hand-written `typeof value === 'object'` guards. Behaviour is unchanged.
- 2be84c9: Document actionable fixes and verification commands for canonical error definitions.

  Journal command/workflow failures and Embeddings failures also expose the missing runtime remediation guidance. Existing failure codes, data and inferred unions are unchanged.

- 49517e2: The build no longer compiles type tests (`*.test-d.ts`). They stay in `typecheck`, but a type test can no longer fail the build, and the published `dist` no longer holds compiled type tests.

  `@arki/db` exports the `OnDelete` type from `@arki/db/id` and `@arki/db/sqlite`. A package whose types come from `idColumns` (such as `@arki/auth`) can now build its declarations. Before, TypeScript could not name `OnDelete` and stopped with TS2883.

  `@arki/ai` drops a `@ts-expect-error` above the `@huggingface/transformers` import. That package is now always installed, so the comment had no error to hide and failed the build.

- cac4bc6: `defineFailure` no longer names the schema library in its type. A definition's `dataSchema` is typed `StandardSchemaV1<Input, Output>` (new `PortableSchema<Schema>`), so an exported failure stops printing `z.ZodObject<…>` into its package's `.d.ts` and consumers no longer depend on Zod's types. Breaking for code that called Zod methods on `definition.dataSchema` (`.safeParse`, `.shape`): keep the Zod schema in its own constant, or use `parse` / `is` from `@arki/schema`.

  `@arki/schedule`: classifies lock provider codes with its own `lockCodeSchema` instead of Zod methods on `ScheduleLockFailed.dataSchema`.

- Updated dependencies [289ba73]
- Updated dependencies [164e25a]
- Updated dependencies [17827b1]
- Updated dependencies [440c75f]
- Updated dependencies [5d55e12]
- Updated dependencies [e132ad3]
- Updated dependencies [40e21b4]
- Updated dependencies [c1ed2a3]
- Updated dependencies [5d55e12]
  - @arki/dot@0.9.0
  - @arki/lock@0.2.0
