# @arki/queue

Renumbered to 0.1.0 on 2026-10-13. The package was never published; the 2.0.x versions below were workspace-only. It stays below 1.0 until its API is stable: a breaking change bumps the minor version.

## 0.2.0

### Minor Changes

- Publish compiled JavaScript in `dist/`; every export entry now imports under plain Node from the npm tarball.
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

- 4c8882e: A job whose handler throws now follows the job's retry like any thrown error, so `backoff().upTo(2)` runs it up to 3 times; a returned failure is still retried only when `.while(...)` selects it, and a throw is still reported as `UnexpectedDefect`. A job name with a character a queue name cannot hold (such as `:`) now throws `ARKI_QUEUE_E020` when the job is declared; use letters, digits, `_`, `-`, `.` and `/`, for example `orders.ship`. Faultline imports `@arki/queue` and keeps `.while(UnexpectedDefect)` on its `documents.deliver` retry (`demos/faultline/backend/src/worker/deliver.ts`): it is still valid and now redundant, because a thrown error already follows `upTo(2)`; its job name has no `:`. Drop Studio is not affected: no demo impact, it does not import `@arki/queue`.
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

- 310d26b: New entry `@arki/queue/outbox`: transactional scheduling. `outbox({ tables }).runAfter(tx, job, args)` writes the job row in the caller's transaction, and `outboxRunner` runs it from the `@arki/journal` worker. It needs no Redis. `@arki/queue/dot` gains `outboxPlugin` and `outboxJobs`. `JobContext.job` and the middleware `job` are now the structural `JobLike`, so a BullMQ job still fits. The cast in runtime-local is gone.
- 5013093: Two browser-safe subpaths, so an oRPC contract that ships to the browser no longer bundles bullmq:

  - `@arki/queue/errors`: `JOB_TRIGGER_FAILURES`, `QueueUnavailable`, `QueueAcceptanceUnknown` and the declaration error codes. The trigger failures moved here from the trigger module. The root still exports them.
  - `@arki/queue/contract`: everything a contract needs: `JOB_TRIGGER_FAILURES`, the two trigger failures, `queueJobId`, and the types `JobTriggerFailure`, `JobTriggerResult`, `QueueJobId`.

- 00f65fb: Flows now run. `enqueue(flow, input)` on the `queue()` DOT client and on a `createQueue()` instance validates the input with the flow's schema (`QueueInputError`, `ARKI_QUEUE_E018`), then adds the whole flow through one lazily opened BullMQ `FlowProducer` (closed on stop) and returns `{ flow, jobIds }` by step id. Each step runs in its job's own queue with the job's retry defaults. Flows are BullMQ trees: a step in the `dependsOn` of two steps now throws `ARKI_QUEUE_E017` at `.build()`. Breaking: the step `queueName` option is removed (a step always runs in its job's queue; another queue had no worker), step `opts` are typed as `FlowStepOptions`, and `FlowDefinition` takes the input type (`FlowDefinition<TInput>`).
- e14715c: A job handler may now return a failure from `@arki/failure`. The job then fails at once, without a retry, unless the job's `retry` backoff accepts that failure in its `while`. A thrown error retries as before. The job's `failedReason` is the failure as JSON, with its code, message, status and data, so the board and the foreman show why the job failed. The `runtime-local` queue does not apply this yet.
- fb7d47b: Add `bullmqFailedJobSource` to `@arki/queue/foreman`, so the Foreman queue module can list and retry failed jobs of BullMQ queues. `q.createQueue()` now returns `BullMQQueueInstance`, which adds a read-only `queues()` map of its BullMQ `Queue` objects by name.
- 083cc2c: Feature instances get their own jobs. A `jobs(...)` slice of `reports.instance('eu', …)` runs under instance-qualified names (`send-mail#eu`, scheduler id `schedule:<name>#eu`, outbox rows `send-mail#eu`); a plain feature's names do not change. New `jobProducers({ … })` and `outboxProducers({ … })` feature-private infra give usecases `deps.jobs.<job>.enqueue(data)` / `.runAfter(tx, args)` bound to the same name, so producer and worker cannot drift. Every feature's job now runs with `ctx.services`, the services of the feature that registered it (`FeatureJobContext`), and `QueueInstance.register(registry, { services })` takes them per top-level key.
- 792768a: `@arki/schedule`: `schedule()` is a driver for `.serve()` and collects every bound feature's `schedules` slice; the `features` option and the feature-token option types are removed. App-level `schedules` are optional. Feature schedules are no longer checked against `context` at compile time (features bind at runtime); a malformed slice fails boot with `ARKI_SCHEDULE_E001`.

  `@arki/queue`: `queueRuntime()` is replaced by two units. `queue({ connection, keyPrefix? })` goes in `.use()` and provides `queue: QueueClient` (`enqueue(job, data, opts?)`), so features can enqueue. `queueWorker({ q, needs, context })` goes in `.serve()` and runs the features' `jobs()` slices, using the client's connection and key prefix. `jobs()` slices carry only producer actions; the worker owns the consumer actions. `QueueFeatureToken`, `QueueRuntimeOptions`, `QueueRuntimeFeatureOptions`, `QueueFeatureNeeds`, `QueueRuntimeHandle` and codes `E004`/`E005` are removed; a missing client fails with `ARKI_QUEUE_E006`.

- c1c5dde: A job's `retry` option is now a `Backoff` from `@arki/resilience`, the same retry schedule the resilience policies and `@arki/journal` use. `@arki/queue` re-exports `backoff` and the `Backoff` type. Every job retries through BullMQ's custom backoff, and the job's worker asks the `Backoff` for each delay, so `.while(predicate)` can stop retries for errors that will never succeed. The default is unchanged: 3 tries, 1 s then 2 s apart.

  Breaking:

  - `retry: { attempts: 3, backoff: { type: 'exponential', delay: 1000 }, maxDelay: 5000 }` becomes `retry: backoff.exponential({ base: 1000, max: 5000 }).upTo(2)`. `upTo` counts retries, so it is `attempts - 1`. A `fixed` backoff becomes `backoff.constant(ms)`.
  - Removed `RetryConfig`, `BackoffStrategy`, `COMMON_RETRY_CONFIGS` and `createBackoffStrategy`, and the strategies only they offered (linear, polynomial, fibonacci, the jitter variants, stepped, custom). Nothing in the monorepo used them.
  - The job's action metadata now reports `retry: { attempts }` only (`'unlimited'` when the backoff has no `upTo`), without the backoff type and delay.

- f43313b: New `durableScheduler({ connection, keyPrefix? })` Dot plugin in `@arki/queue/dot`. It is the BullMQ backend for `@arki/schedule` schedules declared with `durable: true`, provided under `DURABLE_SCHEDULES_KEY` (`'arki.schedule.durable'`).

  Boot only builds the backend. When the schedule plugin starts, each durable schedule gets a queue named `schedule.<name>` with one job scheduler and one worker. An unchanged scheduler is left alone at start, so a tick that fell due while no worker ran survives a restart and runs once. A handler failure marks the tick's job failed. The last 100 completed and 100 failed tick jobs are kept.

  No change to `queueRuntime`, jobs, schedules or flows.

- 67c9e95: Correct the queue worker's missing-client diagnostic to `ARKI_QUEUE_E019` and its documentation link. `ARKI_QUEUE_E006` keeps its original meaning: a missing job, schedule or flow name. Code matching for a missing queue client must use `QUEUE_PLUGIN_ERROR_CODES.clientMissing` or the new literal. Add fixes and verification commands to the queue error index.
- 36c273e: Builder order mistakes are now compile errors, and every declaration mistake throws a coded error.

  - `q.job.name(...)` and `q.schedule.<kind>(...).name(...)` now return `JobBuilderNeedsInput` / `ScheduleBuilderNeedsInput`. These types have no `.handler()`; `.input(schema)` unlocks it. `.options()` and `.use()` still work in the same places as before.
  - `q.flow.name(...).input(...)` now returns `FlowBuilderNeedsStep`, which has no `.build()`. The first `.step(...)` unlocks it. `.use()` still works before and after steps.
  - The runtime checks stay as a backstop for plain JS and casts. They, the flow checks for unknown step ids and dependency cycles, and the `CronPatterns` range checks now throw `QueueDefinitionError` with a `code` (`ARKI_QUEUE_E006` to `ARKI_QUEUE_E011`, listed in `QUEUE_DEFINITION_ERROR_CODES`) and a `remediation`. Messages are unchanged.

  Breaking, so a minor bump while the package is below 1.0: code that compiled before can now fail to compile. A `.handler()` with no `.input()`, or a `.build()` with no steps, already threw at runtime. But two working patterns also break: a variable annotated as `JobBuilderChain<..., never, never>` holding the result of `.name()`, and a flow variable built step by step in a loop (`let f = q.flow.name(n).input(s); f = f.step(...)`), whose type no longer has `.build()`. No app in this repo uses either pattern.

- 2dbbb42: First public release of `@arki/queue`: typed background jobs on BullMQ and Redis, on pg-boss and PGlite, or as a database row that commits with your transaction. no demo impact: no registered demo (`drop-studio`) imports `@arki/queue`.
- 2be84c9: Add nominal domain kinds to `defineId(prefix, { kind })`, preserving canonical
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

- 2c57c1c: Carry inferred failures through configure, boot, start, stop and dispose, with atomic service publication, rollback aggregation and supervised usecase invocation even without tracing. Configure now returns a typed outcome and remains synchronous with no I/O; logging activates during boot. Detached lifecycle callbacks must prove an undefined or concrete failure return rather than void.

  Breaking: check configure before accessing the manifest, inspect stop/dispose outcomes, and handle managed CLI preflight failures under `dot.preflight_failed` in `.error.data.{app,migrations,report,failure}` (exit 3). Successful JSON paths remain unchanged. See `docs/upgrade-phases.md` for phase-specific outcomes and migration steps.

  Cron oRPC adapters route canonical supervised defects through the existing failure policy before success mapping; business refusals keep their explicit responders.

  Database, mail, queue, resilience and Journal adapters retain their authored factory and lifecycle return types, including driver-specific service types.

- 91ebd88: Real jobs now work in schedules and flows without a cast. `q.schedule....job(job)` and `q.flow....step(id, { job, data })` used to ask for `JobDefinition<TInput, unknown, unknown>`, which no built job matches (its handler's context parameter is typed), so callers wrote `job as never` and lost every check.

  - `.job(job)` takes `JobDefinition<TInput, unknown, TContextOut>`: the job's input type flows into `.data()`, and a job whose context the schedule does not provide is a type error. The schedule worker runs the schedule's own middleware, not the job's; add the same `.use(...)` to the schedule when the job needs it.
  - `.step(id, { job, data })` accepts any built job (a step job runs on its own worker, with its own middleware), and `data` must now return the job's input type.

  May surface new type errors: a step whose `data` returns something the job's input does not accept, or a scheduled job whose middleware the schedule lacks. Both were real bugs hidden by the cast.

- 58acb32: New `@arki/queue/foreman` entry for the Foreman control plane. `queueForemanModule({ queues })` gives a paged `queue.failedJobs` read (last error redacted of secrets) and a `queue.retryJob` action that pins the failure it previewed: a stale revision is rejected, and a job already re-queued cannot be retried again. `pgBossFailedJobSource({ pglite })` backs it for the runtime-local queue. `@arki/admin` is an optional peer, needed only by this entry.
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

- 2be84c9: Make failure the acyclic validation foundation. Schema parsing now returns exact typed validation failures, and failure revival returns typed protocol/validator defects instead of throwing. Add validated versioned JSON envelopes; retain legacy envelope reads while rejecting non-JSON data and changing output transforms. oRPC error maps validate output-only wire data.

  Migrate consumers to check failures, propagate them through Journal event/write/replay and queue/mail operations, and use explicit exception bridges at foreign callbacks. Journal rejects invalid event entries before inserting them. See `@arki/failure/docs/upgrade-typed-validation.md` for breaking API and stored-data migration details.

- 73c8c71: A queue job takes a `retention` option: `.options({ retention: { completed, dead, retryableFor } })`. On the outbox lane the runner hands it to the journal as the override for that job name, so the job's finished and dead rows are kept as it says. The BullMQ lane ignores it.

  `@arki/queue/foreman` raises its errors through `moduleError` from `@arki/admin/module`. A stale approval (`ARKI_QUEUE_E014`) and a job that is no longer failed (`ARKI_QUEUE_E015`) now answer 409, where they answered 500; an unknown queue (`ARKI_QUEUE_E016`) answers 404. `redactSecrets` is owned by `@arki/admin/module`; `@arki/queue/foreman` still re-exports it.

  Breaking (0.x): `QueueForemanError` is removed. Match on the code of the `ModuleError` (`isModuleError` from `@arki/admin/module`) or on `QUEUE_FOREMAN_ERROR_CODES`.

- 1d5d0da: A schedule now triggers its job instead of running it, and middleware now wraps the handler.

  - `q.schedule.<kind>(...).job(someJob).data(d)` adds `d` to `someJob`'s own queue on each tick, the same as `someJob.trigger(d)`. The job's own worker runs it, with the job's input check, middleware, retries and concurrency. The schedule creates no queue or worker of its own. The BullMQ scheduler id is `schedule:<name>`, so several schedules can target one job. The runtime-local (pg-boss) queue does the same, keying each `boss.schedule(...)` by the schedule name.
  - A schedule has no middleware of its own. `.use()` followed by `.job()` is a compile error, and a `QueueDefinitionError` (`ARKI_QUEUE_E012`) for plain JS. The inline form (`.use(mw).name(n).input(s).handler(fn)`) is an anonymous job named after the schedule; its `.use()` chain is that job's middleware.
  - `.name()` now works with `.job()`: `cron(...).name('x').job(j).data(d)` compiles. `.handler()` still needs `.input()` first.
  - `start()` prunes schedules removed from code: on each registered job's queue it removes `schedule:<name>` schedulers (runtime-local: keyed pg-boss schedules) that no registered schedule owns, so a renamed or deleted schedule stops ticking. Other keys on a job's queue are never touched. The md5-keyed BullMQ 5 leftover cleanup now runs only on an inline schedule's own queue, which only this package writes to.
  - A duplicate schedule name now throws `QueueDefinitionError` (`ARKI_QUEUE_E013`) at `register()`, instead of logging a warning and skipping.
  - Middleware wraps the handler (onion). The handler runs inside the last middleware's `next()`, so `await next()` resolves after the handler finishes, rejects with its error, and carries its return value as `output`. `try { return await next() } finally { ... }` now surrounds the handler. Both the BullMQ and the runtime-local queue use this one chain.
  - Flows have no `.use()` any more. It stored middleware that nothing ran; each step runs in its own job's worker, with that job's middleware.
  - A timeout schedule's delayed job id is now `schedule-<name>`: BullMQ refused the old `schedule:<name>` id.
  - runtime-local `job.trigger()` no longer sends `priority: undefined`, which pg-boss rejected.
  - runtime-local `start()` now bootstraps the pg-boss schema only on a fresh database; a restart on a persisted PGlite failed with "type job_state already exists".
  - `job._internal._worker` is now set to the job's BullMQ worker (it was declared but never set).
  - `CronPatterns` time helpers (`daily`, `weekdays`, `weekly`, `monthly`, ...) now emit normalized numbers (`'09:05'` gives `5 9 * * *`, not `05 09 * * *`) and reject non-digit text such as `'9am'` or `'12:34:56'`, which used to pass straight into the cron expression.
  - A retry `maxDelay` of `0` now caps every delay at 0; it was treated as no cap.

  Breaking, so a minor bump while the package is below 1.0. Schedules that wrapped a job ran the schedule's middleware and skipped the job's; they now run the job's. Code that called `.use()` before `.job()` on a schedule, or `.use()` on a flow, no longer compiles. Code after `await next()` in a middleware now runs after the handler, not before it. Schedules that wrapped a job under an older version keep their old entries on their old schedule-named queue (a BullMQ job scheduler, or a pg-boss schedule with no key). No worker reads that orphaned queue any more and pruning does not reach it; remove those entries by hand.

- 2c57c1c: Add UUID generation to canonical ID declarations and use one nominal Queue job
  identity across direct triggers, producer clients and local queues.

  Job triggers return precise generation failures before contacting the transport.
  Handle `JOB_TRIGGER_FAILURES` before using the successful ID. Generated keys keep
  their UUID format; explicit keys and pg-boss's durable duplicate mapping retain
  their stored values.

- 1a897f8: Handler events (RFC `docs/rfcs/2026-10-21-dot-middleware.md`, step 3). Every handler a Dot app mounts — an oRPC procedure through `bind`, an HTTP route or `rpc()` mount, a queue job, a schedule run — now reports to the app's lifecycle observers:

  - A handler event has `kind: 'handler'`, `transport` (`'rpc' | 'http' | 'job' | 'schedule'`), `feature` (the owning unit) and `name` (the oRPC path, `METHOD /path`, the job or schedule name). Its `status` is `starting`, then `completed` (with `durationMs` and `outcome: 'ok' | 'refused'`; a refusal carries its `failure`) or `failed` (a throw, with `error`). A returned failure or a step's refusal is `completed/refused`, never `failed`. On oRPC, a thrown error below 500 is a refusal.
  - `@arki/dot` adds two observers for `defineApp(name, { observers })`: `reportErrors({ report })` calls `report(error, { transport, feature, name })` for every `failed` handler, and `logHandlers()` writes one DEBUG line per handler on `arki:dot:handlers`. With no observer registered, a handler call costs nothing extra.
  - Transport adapters reach the emitter through `handlerObserverOf(services)` from `@arki/dot/feature` (`watching()`, `run(ref, work, outcome?)`); the kernel context carries it as `$handlers`.
  - Breaking: `errorCaptureMiddleware` is removed from `@arki/dot/orpc`. Register `reportErrors({ report })` instead; it keeps the same rule (a 4xx is traffic, anything else is reported).
  - Breaking: `@arki/queue` removes its standard middleware (`timingMiddleware`, `loggingMiddleware`, `errorHandlingMiddleware`, `validationMiddleware` and the other `src/middleware` exports). Timing and logging are `logHandlers()`, error reporting is `reportErrors()`, validation is `.input(schema)`, timeouts are `options.timeoutMs`, and a per-job logger is a `step`.
  - `@arki/failure/orpc`: the `ORPCError` that `rpcError` and `orThrowRpc` throw carries the failure as its `cause`, on the server only (oRPC never sends `cause` to the client).

### Patch Changes

- 5d55e12: Docs only: the README section "Steps and arounds" moves after the required opening sections. No code change.
- 745a2c3: Dot plugins no longer pass a hard-coded `version` (the field was removed from `@arki/dot`).
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

- bef873a: Trace single-job enqueue attempts by default, including validation, identity
  generation, transport refusals and uncertain acknowledgements. Producer spans
  propagate through the existing BullMQ and pg-boss carriers. Instrumentation
  failures cannot replace returned outcomes or repeat an enqueue.

  Configure OpenTelemetry in the application. Explicit BullMQ telemetry options
  retain their existing precedence. Flow enqueue and worker execution keep their
  current instrumentation.

- e132ad3: Object checks on unknown values now use `is(value, recordSchema)` from `@arki/schema` instead of hand-written `typeof value === 'object'` guards. Behaviour is unchanged.
- 49517e2: The build no longer compiles type tests (`*.test-d.ts`). They stay in `typecheck`, but a type test can no longer fail the build, and the published `dist` no longer holds compiled type tests.

  `@arki/db` exports the `OnDelete` type from `@arki/db/id` and `@arki/db/sqlite`. A package whose types come from `idColumns` (such as `@arki/auth`) can now build its declarations. Before, TypeScript could not name `OnDelete` and stopped with TS2883.

  `@arki/ai` drops a `@ts-expect-error` above the `@huggingface/transformers` import. That package is now always installed, so the comment had no error to hide and failed the build.

- 2c57c1c: `env()`, `resilience()`, `auth()`, `journal()`, `journalProjections()`, `queue()`, `durableScheduler()` and `outboxPlugin()` keep their plugin name in the type, so their handles carry `provider: 'env' | 'resilience' | …` instead of `string` and the feature builder's handle-identity checks apply around them. The three queue plugins gain an overload: with no `name` option the type carries the default name (`'queue'`, `'durable-scheduler'`, `'outbox'`); with `name: 'jobs'` it carries `'jobs'`.
- de4740d: `@arki/queue/runtime-local`: an array value with an apostrophe in one of its elements no longer breaks the query. The PGlite adapter escaped quotes in every literal except arrays.

  `initQueue.create()` no longer reads `process.env.NODE_ENV` when the queue is declared. The `isDev` default is read when it is used, so importing a queue module observes nothing.

- 6cf263a: Return QueueAcceptanceUnknown for incomplete or malformed flow acknowledgements without resubmitting possibly accepted jobs. Preserve every confirmed step key, including prototype-named keys.
- 51c0033: Trace flow enqueue validation, mapping and provider acceptance with a default producer span. Propagate its context to flow jobs while preserving explicit telemetry options and exact failure outcomes. Reentrant or broken reporting cannot repeat submission.
- 17e86d3: Breaking: the object-form feature API is removed. Write every feature as a `defineFeature(name).needs().infra().usecases().provides().entrypoints()` chain.

  - `@arki/dot`: removed `feature()`, `plug`, `composeRouter`, `composeRepos`, `tokenOf`, `entrypointsOf` and the types `AnyFeature`, `MountedFeature`, `UnitOf`, `MountedUnitsOf`, `FeatureConfig`, `ComposedRouter`, `ComposedRepos`. `defineApp().features()` takes chain features only. Use `routerFor(rpcContract, features)` instead of `composeRouter`, and a feature's own `repos({...})` store instead of `composeRepos`. Read `f.entrypoints` instead of `entrypointsOf(f)`. Lifecycle hooks (`boot`, `start`, `stop`) live on an infra unit inside the feature.
  - `@arki/http`: removed `endpoints(build)` and `EndpointsFeatureSlice` from the root export. Use `endpoints(core, build, { contracts })` from `@arki/http/dot` in `.entrypoints()`.
  - `@arki/schedule`: removed the `schedules(needs, defs)` overload. Use `schedules(core, defs)` in `.entrypoints()`.
  - `@arki/queue`, `@arki/journal`, `@arki/admin`: dropped their object-form branches. The chain API is unchanged.

- Updated dependencies [2c57c1c]
- Updated dependencies [a83e735]
- Updated dependencies [8e6970d]
- Updated dependencies [f49d490]
- Updated dependencies [a905468]
- Updated dependencies [7c10c0a]
- Updated dependencies [ce53dcc]
- Updated dependencies [f6b9ab1]
- Updated dependencies [f3c95a0]
- Updated dependencies [14b61bb]
- Updated dependencies [289ba73]
- Updated dependencies [17e86d3]
- Updated dependencies [d16933c]
- Updated dependencies [2c57c1c]
- Updated dependencies [f2ba7ac]
- Updated dependencies [84d246f]
- Updated dependencies [4f41f91]
- Updated dependencies [a077b15]
- Updated dependencies [8e5d9df]
- Updated dependencies [8201ea8]
- Updated dependencies [289ba73]
- Updated dependencies [440c75f]
- Updated dependencies [84d246f]
- Updated dependencies [0403c69]
- Updated dependencies [8e5d9df]
- Updated dependencies [f43313b]
- Updated dependencies [86250e6]
- Updated dependencies [d9d791f]
- Updated dependencies [84d246f]
- Updated dependencies [5d55e12]
- Updated dependencies [270aa2e]
- Updated dependencies [bdfd204]
- Updated dependencies [ff85471]
- Updated dependencies [11c5bc2]
- Updated dependencies [792768a]
- Updated dependencies [440c75f]
- Updated dependencies [745a2c3]
- Updated dependencies [84d246f]
- Updated dependencies [df44e0d]
- Updated dependencies [57e9b4b]
- Updated dependencies [c3e63ba]
- Updated dependencies [94a1ee6]
- Updated dependencies [8e5d9df]
- Updated dependencies [23e9f49]
- Updated dependencies [e444104]
- Updated dependencies [5d55e12]
- Updated dependencies [a1da735]
- Updated dependencies [84d246f]
- Updated dependencies [e132ad3]
- Updated dependencies [23e153b]
- Updated dependencies [2be84c9]
- Updated dependencies [49517e2]
- Updated dependencies [7711722]
- Updated dependencies [cac4bc6]
- Updated dependencies [ce53dcc]
- Updated dependencies [8e5d9df]
- Updated dependencies [2c57c1c]
- Updated dependencies [84d246f]
- Updated dependencies [88daaeb]
- Updated dependencies [cb5b666]
- Updated dependencies [40e21b4]
- Updated dependencies [5d55e12]
- Updated dependencies [c1ed2a3]
- Updated dependencies [6fd5ff9]
- Updated dependencies [3468b2d]
- Updated dependencies [b435e76]
- Updated dependencies [b435e76]
- Updated dependencies [8e5d9df]
- Updated dependencies [fdec626]
- Updated dependencies [1a897f8]
- Updated dependencies [8944628]
- Updated dependencies [b438186]
- Updated dependencies [43bef40]
- Updated dependencies [17e86d3]
- Updated dependencies [b435e76]
  - @arki/schedule@0.1.0
  - @arki/journal@0.4.0
  - @arki/dot@0.9.0
  - @arki/admin@0.2.0
  - @arki/resilience@0.3.1

## 2.0.2

### Patch Changes

- Updated dependencies
  - @arki/contracts@0.0.2
  - @arki/log@0.0.2

## 2.0.1

### Patch Changes

- Updated dependencies
  - @arki/contracts@1.0.0
  - @arki/log@1.0.0
