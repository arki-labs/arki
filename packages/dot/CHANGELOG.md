# @arki/dot

## 0.7.0

### Minor Changes

- afecc7a: `dot` now runs on `@arki/cli`. Breaking for scripts and agents that read its output:

  - Output is the `arki.cli/1` envelope: `{ ok, command, data, error, meta }`. It is JSON by default when stdout is piped; `--json` or `-o json` forces it, `-o text` forces text.
  - Exit codes: `0` ok, `1` bug, `2` usage (`cli.unknown_command`, `cli.invalid_input`), `3` a returned failure.
  - `dot.*` failure codes replace `DOT_CLI_E001`–`E011`: `dot.app_not_found`, `dot.app_invalid_export`, `dot.app_import_failed`, `dot.app_lifecycle_failed`, `dot.observability_no_sdk`, `dot.projection_not_found`, `dot.projection_import_failed`, `dot.projection_execution_failed`, `dot.projection_conflict`, and new `dot.doctor_failed`, `dot.target_not_empty`, `dot.template_missing`, `dot.write_failed`. `E004`/`E005` are the framework's `cli.unknown_command` / `cli.invalid_input`.
  - `dot doctor` returns the snapshot plus `.data.status` (`success` or `warning`); error issues return `dot.doctor_failed` (exit 3) with the report in `.error.data`.
  - `dot new` returns `.data.app`, `.data.operations[]` and `.data.nextSteps`.
  - `--openapi` is removed; use `--as openapi`.
  - Removed exports: `DotCliError`, `DotCliErrorCode`, `dotCliDocsUrl`, `DotCliEnvelope`, `DotCliEnvelopeStatus`, `DotNewEnvelope`, `main`, `parseArgs`. `runExplain`, `runDoctor` and `runNew` return their data or a failure and print nothing; `program` is the CLI.

- 5bc6390: Breaking: `plugin()` publishes through `provides` factories, exactly like `feature()` (`provides: { db: () => openDb() }`). Each factory gets the plugin's needs plus `$app`/`$plugin`/`$config` and may be async; the kernel awaits them in key order. `boot` is side effects only: a value-returning plugin `boot` no longer compiles, and `InferredProvides` is removed. Every plugin now carries typed handles before boot: `database.provides.db` is a `Handle<T, 'db'>` (a `Token` plus `provider` and `.lazy`), so consumers write `needs: { db: database.provides.db }` and name the type once with `Provided<typeof database.provides.db>`. `Handle`, `LazyHandle`, `Handles`, `Provided` and `ProvidesFactories` now live in the plugin contract (re-exported from `@arki/dot`, `@arki/dot/plugin` and `@arki/dot/feature`). `Plugin.provides` is required (wire-keyed handles) and `Plugin.factories` holds the factories. `rename()` rebuilds the handles on the new keys and name; a handle taken before the rename keeps the old key and fails the builder guard. The kernel checks every plugin's needs against every plugin's static provides at `configure()`: `DOT_LIFECYCLE_E020` names a provider mounted after its consumer, with a role-aware fix ("Move X before Y in .features([...])" or "Mount X with .use() before Y"), and a ring through adapters is `DOT_LIFECYCLE_E019`; `E012` remains only for needs no plugin declares. `dot explain` prints one labelled edge per capability for adapters too, without booting. A feature's slice record is one of its plugin's provides entries. `providesOf()` accepts plugins as well as features. `handle.lazy` needs receive a `Lazy<T>` in `resolveNeeds()` as in hook contexts. New `fake(handle, value)` in `@arki/dot/test-harness` mounts a fake under a real handle, type-checked against it.
- 899d0a9: Adds the chain form of a feature and contract-first composition, next to the existing API (RFC `docs/rfcs/2026-10-15-dot-feature-builder.md`). The old `feature()`, `.use()`, `.serve()`, `plug`, `composeRouter` and `composeRepos` stay for now; a later changeset removes them.

  - `defineFeature(name).needs().infra().usecases().provides().entrypoints()` in `@arki/dot/feature`. Stage order is a compile error; usecases get `{ ...needs, ...infra }`; provides factories and entrypoints also get `usecases`, built once per boot. Feature infra is private: keys are published as `<feature>.<key>` from units named `<feature>/<plugin>`, and sibling needs follow the qualified key. `session`, `headers`, `services` and `usecases` are reserved; infra/need and entrypoint/provides collisions are compile errors and `FEATURE_E006` at runtime.
  - A finished feature has `plugins()` (a typed tuple the app builder guard checks), `override(values)` (swaps infra services in place, keeps entrypoints; `FEATURE_E007` for an unknown key), `handles`, `provides`, `entrypoints`, and `contract` / `router` from its `rpc` entrypoint.
  - Entrypoint descriptor protocol `{ kind, key, actions, resolve }` (`Entrypoint`, `RpcEntrypoint`, `DepsOf<typeof core>`) for adapter packages.
  - `routerFor(appContract, features)`: mount keys written once in the app contract, features found by contract identity; unmatched keys and contracts are compile errors and `FEATURE_E008` / `FEATURE_E009` at runtime.
  - `defineApp(...).infra(...units)` and `.entrypoints(...adapters)` (variadic, checked like `.useAll()`); `.features()` accepts `defineFeature` features next to `feature()` values and mounts their infra units.
  - `servicesOf` accepts any unit with `provides` (features or plugins). `handleOf` and `AnyHandle` are exported from `@arki/dot/plugin`. `FeatureError` and its codes move to an internal module (same exports).

- ce8d707: New command `dot dev`. It picks the app's `dev` export, then resolves the database: embedded PGlite, or a local Postgres it can start with `docker compose up -d`. A non-local `DB_URL` / `DATABASE_URL` in the process env or any `.env*` file is refused, under PGlite too, unless you pass `--allow-remote-db`. A PGlite runner starts without any database URL. A preflight boot then validates env and applies the committed `drizzle/` migrations, and prints which ones it applied. After that it runs Vite (or `--run`, or the hidden `dot _serve`) in its own process group, and restarts when `drizzle/`, `.env*` or the app file change. `--once` stops after the preflight: it is the boot check for CI and agents.

  New in `@arki/dot/cli`: `runDev`, `devEventSchema` / `DevEvent`, `devStateSchema` / `DevState`, `DEV_STATE_PATH`, and the failures `DevDbUnreachable`, `DevRunnerFailed`, `DevPortInUse`, `DevAlreadyRunning`, `DevRemoteDbRefused`, `DevAppStarted`. Discovery takes `prefer: 'dev'`, and `DiscoveryResult` carries `exportName`. `DoctorOptions.onBooted` hands the booted app to the caller before it is disposed.

- 92b38ed: Wiring errors land on the argument, with the `DOT:` label in the message. `.use()`, `.serve()`, `.useAll()` and `.features()` no longer demand a phantom second argument when a unit cannot mount (`Expected 2 arguments, but got 1`); the plugin or list itself fails to type-check, and the error names the missing or colliding keys. `testPlugin(...).boot()` does the same through a `this` type. `ListGuard` is exported.

  `testApp(plugins)` and `bootTestApp(plugins)` infer `app.services` from the plugin tuple and refuse a tuple that would not mount; a runtime-built array gives the open record. Breaking: the explicit `testApp<TServices>()` type argument is gone — drop it, the services are read off the plugins.

- 80a4aa5: `feature.instance(name, rebind?)`: a second copy of a finished feature, named `<feature>#<instance>` (`reports#eu`), with its own infra units, usecases, services and entrypoints, publishing under `<feature>#<instance>.<key>` so two copies mount side by side (next to the original or not). `rebind` swaps a need's handle for another provider's handle of the same service type (`{ db: databaseEu.provides.dbEu }`); a nested child is re-derived under the copy and a child need on the same handle follows, lazy form included. Each copy's rpc entrypoint has its own contract identity, so the app contract mounts `eu.contract` and `us.contract` under their own keys. `#` is reserved in a declared feature name. New `instanceOf(name)` (`'reports#eu.audit'` → `'eu'`) for adapters, and the types `RebindOf`, `RebindNeeds`, `InstanceChildren`, `FeatureParams`. `WireNeeds` now reads a need's wire key from `key` alone: a handle whose key holds `#` has one wire key, not two.
- 232d3e8: RPC error maps retain their original failure definitions for exact revival by another contract adapter. Use `rpcFailureDefinitions` to read these references; wire JSON remains unchanged.

  Add reusable browser-safe action contracts, server execution ownership and scoped
  OpenTelemetry helpers. Native RPC/HTTP adapters parse and encode once while
  sharing canonical failures and explicit exposure, principal and approval policies.

  Breaking: HTTP boundaries and auth policies return typed canonical failure values;
  update callers that inspect legacy strings or expect thrown refusals. Retry
  ownership is explicit. MCP adds browser-safe contract annotations and callable
  tools that reuse the gateway's typed native client, preserve canonical failures,
  and enforce access, approval and result budgets. Hosts provide approval authority;
  the full MCP server and durable confirmation store remain separate work.

- cbefc52: Plugins no longer take a `version` field. `plugin({ version })` and `PluginManifest.version` are gone, `dot explain` has no VERSION column, the graph labels show only the plugin name, and the `dot.plugin.version` span attribute is no longer set. Migrate: delete `version` from your `plugin()` calls. The app `version` in `defineApp(name, { version })` stays.
- 01400a0: `.usecases()` infers inline factories: `({ repos }) => () => repos.all()` gets the feature's deps type (needs + infra + children) with no annotation, so a usecase file no longer has to spell `Pick<Deps, 'repos'>`; annotated factories still fit. A factory that asks for a dep the feature lacks still fails with the `DOT: a usecase asks for a dep the feature does not provide` label, naming the usecase and the dep — the inferring signature is the first overload, the labelled one its fallback. New type export: `UsecaseFactoriesOf<D>`.
- 0ab11d8: Handles carry the identity of the service they name, and the feature builder reads it. `Plugin` gains two type parameters: `TShape` (the `needs` record as written, alias → witness) and `TOwner` (the plugin's name as a literal); `plugin()` infers both, so `database.provides.db.provider` is `'database'`, not `string`. `rename()` is generic over the plugin and keeps the shape; without a new name the handles keep the original provider. New type exports: `PluginProviderIdentities<P>`, `PluginOwner<P>`.

  Two graphs that compiled and failed at runtime are compile errors now: a nested feature whose need names a global handle is no longer remapped onto a same-shaped private infra of its parent (`UnsatisfiedNeed` at boot before), and an infra plugin bound to another plugin's same-shaped handle is refused at `.infra()` in the types (`E026` at runtime before). An infra plugin whose shape is known is checked by need alias, as the runtime resolves it, so a bound need whose alias differs from its key (`clusters: dedup.provides.clusterDetails`) compiles. Plugins annotated `Plugin<N, P>` erase shape and name and keep the previous wire-key checks. Migrate: `expectTypeOf(...).toEqualTypeOf<Handle<T, K>>()` assertions on `plugin()` handles need the third argument (`Handle<T, K, 'name'>`); `ChildUnits` takes the parent's infra owners as its third type parameter.

- a531063: `dot explain` text output prints each rpc action's contract meta under it, one `key: value` per line (`↳ policy: order.refund`, `↳ auth: admin`). `--json` already carried it as `meta.meta`.
- 9b35520: Breaking: `feature()` publishes through `provides` factories, one per capability (`provides: { entitlements: ({ db }) => createEntitlements(db) }`). Each factory gets the feature's needs; `boot` is now side effects only (it returns `void` and sees the factories' values), and a value-returning `boot` no longer compiles. Handles are static plain objects that carry `provider` (the feature name), so `Object.keys(billing.provides)` is known before boot. New in `@arki/dot/feature`: `Handle`, `ProvidedOf`, `ServicesOf`, `ServicesBag`, `providesOf(features)`, `servicesOf(ctx, features)` and `resolveNeeds(bag, needs)` (throws `FEATURE_E005` naming the missing capability), for carrying capabilities in a request context. The kernel checks feature capabilities at `configure()`: `DOT_LIFECYCLE_E019` prints a capability ring, `DOT_LIFECYCLE_E020` names a provider mounted after its consumer. `Plugin.provides` lists a feature's static publish keys; manifest `provides` is filled before boot and `DependencyEdge` gains an optional `key`, so `dot explain` draws `consumer --[key]--> provider` edges (Mermaid `-->|key|`) without booting.
- 5721742: Breaking: every kernel error now has one stable code in one namespace, `ARKI_DOT_E001` to `ARKI_DOT_E032`, and carries `remediation` and `docsUrl` like `DotPluginError`.

  - `DOT_LIFECYCLE_E0nn` is now `ARKI_DOT_E0nn` (same number). `FEATURE_E0nn` is now `ARKI_DOT_E0(21+nn)`: `FEATURE_E001` is `ARKI_DOT_E022`, up to `FEATURE_E010` as `ARKI_DOT_E031`. The constants (`DotLifecycleErrorCode`, `FEATURE_ERROR_CODES`) keep their names, so code that uses them needs no change. Code that matches the old strings must switch to the new ones.
  - `DotLifecycleError` and `FeatureError` gain `remediation` and `docsUrl`. New `DotManifestError` (`ARKI_DOT_E032`, still a `TypeError`) replaces the bare `TypeError` from `toJsonObject`.
  - The README has an "Errors" table with all codes.

- 9192d0e: `dot explain` prints each action's summary, and a plugin can finish its own summaries after boot.

  - New hook `$describeAction(actionId, { summary })` (configure twin: `describeAction`). A plugin calls it after boot to complete the summary of its own actions, or of actions in a binding it registered a projection for. The post-boot manifest and `dot doctor` show the completed text.
  - New error `DOT_LIFECYCLE_E021`, raised when a plugin describes an action it may not amend (an unknown id, or one that is not its own).

- 232d3e8: Carry inferred failures through configure, boot, start, stop and dispose, with atomic service publication, rollback aggregation and supervised usecase invocation even without tracing. Configure now returns a typed outcome and remains synchronous with no I/O; logging activates during boot. Detached lifecycle callbacks must prove an undefined or concrete failure return rather than void.

  Breaking: check configure before accessing the manifest, inspect stop/dispose outcomes, and handle managed CLI preflight failures under `dot.preflight_failed` in `.error.data.{app,migrations,report,failure}` (exit 3). Successful JSON paths remain unchanged. See `docs/upgrade-phases.md` for phase-specific outcomes and migration steps.

  Cron oRPC adapters route canonical supervised defects through the existing failure policy before success mapping; business refusals keep their explicit responders.

  Database, mail, queue, resilience and Journal adapters retain their authored factory and lifecycle return types, including driver-specific service types.

- 932c9e4: Adds `@arki/dot/orpc` and lets adapters read `defineFeature` features directly (RFC `docs/rfcs/2026-10-15-dot-feature-builder.md`, phase 1b).

  - `@arki/dot/orpc` (optional peer `@orpc/server`): `needsMiddleware<RequestContext>()` makes the app's `bind`; `bind(core)` puts a feature's needs, private infra and `usecases` on the handler context from `context.services` (an alias that shadows a request-context key does not compile). `rpc(contract, router)` is the oRPC entrypoint descriptor; the router must implement the contract (`Router<C, never>`), so a bare router, a missing procedure or another contract's router do not compile.
  - Breaking for adapter authors: `driver(...)` / `driven(...)` now receive `MountedFeature[]` — object-form and chain features as mounted, no longer an object-form view of chain features. Read declarations with the new `entrypointsOf(f)` (chain `entrypoints` or object-form `use`), slice records with `sliceOf(ctx, f)` as before, and a chain feature's units with `f.plugins()`.

- 232d3e8: Make failure the acyclic validation foundation. Schema parsing now returns exact typed validation failures, and failure revival returns typed protocol/validator defects instead of throwing. Add validated versioned JSON envelopes; retain legacy envelope reads while rejecting non-JSON data and changing output transforms. oRPC error maps validate output-only wire data.

  Migrate consumers to check failures, propagate them through Journal event/write/replay and queue/mail operations, and use explicit exception bridges at foreign callbacks. Journal rejects invalid event entries before inserting them. See `@arki/failure/docs/upgrade-typed-validation.md` for breaking API and stored-data migration details.

- cc656e3: Every hook and `provides` factory gets `$signal` in its kernel context: one `AbortSignal` per hook call that aborts when the hook exceeds `defineApp(name, { hookTimeoutMs })`, with the `DOT_LIFECYCLE_E015` error as its reason. A promise cannot be killed, so before this a hung hook (a connect that never settles) kept running after the kernel gave up on it; a hook that passes `$signal` to its I/O now stops. `$signal` joins the reserved `$` keys.
- ce8d707: New entry `@arki/dot/runtime`: `createAppRuntime(app, { hot: import.meta.hot, onStarted })` keeps one started app per server process, also under Vite hot updates. `get()` starts the app once and retries a failed start. On a hot update the old app is disposed, and the replacing module starts its app only after that disposal finished, so two apps never hold the same pool or PGlite directory (`import.meta.hot.dispose` alone does not wait). The started app is hooked to SIGTERM / SIGINT with `hookSignals`. The `dot new` stack template and the monorepo app template use it.
- 232d3e8: Own resources and child work through typed descriptors. Replace imperative `scoped` registration with `resource`, `cleanup`, `child`, `scoped(plan, body)`, `openScope` and checked dynamic scopes. Preserve exact callback failures and canonical cancellation, deadline and defect outcomes; keep cleanup members private when serializing aggregate failures.

  Dot owns partial plugin construction, publishes services atomically, joins children before disposal and retains finalizer failures. Lazy services coalesce initialization, retry only on a later explicit get, and expose only successful values through peek. Lifecycle callers, HMR and CLI supervision now inspect resolved ownership failures. Existing static/configure and legacy start/stop exception migration continues separately.

  Breaking upgrade: see `@arki/dot/docs/upgrade-ownership.md` and `@arki/async/README.md`. Check boot/start/get/dispose results before using them; deadlines request cancellation and wait for admitted work to settle before releasing resources.

  `ProvidesFactories` now describes raw callback returns, including promises. Infer factory records at their definitions; handles and lifecycle callbacks continue to receive resolved service values.

- d9864f3: Every usecase from `defineFeature(...).usecases(...)` now runs in an OpenTelemetry span named `feature.<feature>.<usecase>`. A returned `@arki/failure` failure sets the span status to ERROR with `failure.code` and `failure.status`, and records no exception. A throw or rejection is recorded as an exception, sets ERROR, and is rethrown unchanged. Anything else sets OK. The span is active, so spans started inside the usecase nest under it. With no SDK registered, calls go straight through with the same `this`, arguments and return value. Usecase types do not change. `rpc()` adds no span: oRPC's own `call_procedure` span covers each procedure once `@orpc/otel` is registered. `@arki/dot` now depends on `@arki/failure`.
- 115aa87: Nested features and infra that receives the feature's needs.

  - `.features(...children)` after `.infra()`: a child is named by its path (`digest.compile`), its provides are scoped (`digest.compile.ranker`) and private to the parent's scope, and the parent sees them by identity in `.needs()`. `allFeatures`, `ownUnits`, `mountFeatures` (assembly ownership check, `FEATURE_E005`), `override('compile.ranker')` by path, depth-aware `fake()`, and shutdown in reverse boot order.
  - Infra plugins declare their needs unbound (`service<T>()`); `.infra()` binds each alias to a sibling's key first, then to the feature's own need of that alias. An infra need the feature does not declare, or binds to another handle, is a compile error and a runtime refusal.
  - `entrypointOnly(handle)` in `.needs()`: entrypoints see it, usecases never do.
  - Breaking: `.needs()` takes a record of aliases only (a bare handle is refused); feature services are published under one bag key, `<name>.services`, and `needsMiddleware` reads that key.
  - `rpc()` mounts a declared child's router once, at the path the parent's contract gives it.

- 6e4d7da: One file per usecase, one procedure tree per feature (`entrypoints/procedures.ts`). Breaking (pre-1.0):

  - `.usecases()` now takes an object of factories, `{ signup, markInvited }`, each `(deps) => usecase`. Each factory may ask for any subset of the deps (`Pick<Deps, 'repos'>`); one that asks for a dep the feature lacks is a compile error naming it (`'DOT: a usecase asks for a dep the feature does not provide'`). The single-factory form `.usecases(create)` is removed. New types: `UsecaseFactories`, `Usecases`, `UsecaseGuard`.
  - `DepsOf<typeof waitlistDeps>` on the stage before `.usecases()` is now exactly what a usecase may ask for (needs + infra), without an empty `usecases` key.
  - `rpc(contract, router)` becomes `rpc(contract, implementer, factories)`: a tree of factories shaped like the contract (a group is a nested object), each leaf `(impl) => impl.<path>.handler(…)`. Keep the whole tree in one `entrypoints/procedures.ts`; each leaf takes the implementer as a typed parameter (`import type`), so it never imports the feature at runtime. Keys must match the contract exactly: an extra key is `'DOT: a procedure key is not in the contract'`; a missing key or a procedure that does not implement its key does not compile. New types: `ProcedureFactories`, `BuiltRouter`, `ContractKeysGuard`.

  Migrate: split `createUsecases` into one exported factory per key (one file each) and pass `{ a, b }`; turn `procedures(os)` into one tree `export const waitlistProcedures = { name: (impl: typeof rpcImplementer) => impl.name.handler(…) }` and pass `rpc(waitlistRpcContract, rpcImplementer, waitlistProcedures)`.

- 8b3cc80: `rpc(contract, router)` now emits one manifest action per procedure (binding `rpc`, id `<feature>.<path>`), so `dot explain` lists a feature's procedures with their HTTP route, declared errors and contract `meta` (where a policy such as `{ auth: 'admin' }` is declared). Contract meta that is not plain JSON throws `FEATURE_E010` at `rpc()`. Entrypoint descriptors may declare `actionsOf(feature)` for actions whose ids need the feature name. `RPC_ACTION_META_SCHEMA` names the meta layout.

### Patch Changes

- dcf2cef: Docs standard: the README now opens with install, quick start, when not to use Dot, runtime support, public imports, failure behaviour and limits. The dependency-injection material moved to `docs/di.md`, the complex setup to `docs/complex-setup.md`, and the CLI, testing and operations sections to their own pages. The quickstart is a task-first tutorial whose command output is checked by the doc tests. New: `AGENTS.md`, `docs/recipes/deploy.md`, `docs/recipes/upgrade.md`, `@fix`/`@verify` on every error code. Internal plans under `docs/plans/` no longer ship in the tarball.

  The `dot.app_lifecycle_failed` remediation now says to read `error.data.underlyingCode` and apply that code's remediation. It used to blame a `configure` hook that throws or returns a Promise, which was wrong when the cause is `ARKI_DOT_E020` (a provider mounted after its consumer).

  no demo impact: documentation and doc-example changes, plus one CLI remediation string; no runtime behaviour changes

- 9a4babb: `.usecases()` no longer rejects an inline factory whose returned function has an untyped or defaulted parameter, such as `({ repos }: Pick<Deps, 'repos'>) => (fail = false) => …`. Such a factory is context-sensitive, so TypeScript checks the call twice; in the first pass `F` is still its constraint and the guard wrongly flagged every key as "a usecase asks for a dep the feature does not provide". A factory that asks for `never` now counts as asking for nothing. A factory that really asks for a dep the feature lacks is still a compile error, inline or not.
- 69d054f: `feature()` now exposes typed `provides` handles: `billing.provides.entitlements` is a `Token` on the wire key that
  billing's `boot` returns, typed from that implementation. A consumer declares `needs: { access: billing.provides.entitlements }`
  and never restates the service type. `dot new` templates now pin `@arki/env` 0.0.11, `@arki/db` 0.3.1 and
  `@arki/journal` 0.2.1.
- 7b19289: `.infra()` refuses two plugins that provide the same service key at compile time (`DOT: two infra plugins provide the same key`, naming the key). The runtime already threw `ARKI_DOT_E027` for the pair; the types used to intersect the two records silently.
- 923124f: The app builder's list checks (`.features()`, `.useAll()`, `.infra()`, `.entrypoints()`) walk the list by index instead of re-slicing it at every step, which made type-checking quadratic in the number of units. Mounting 100 chained features costs 0.94M type instantiations instead of 2.65M; 200 features type-check instead of hitting the compiler's limit. A list longer than 1024 units is refused with a `DOT:` label. New `src/tests/typecheck-budget.test.ts` keeps the ceilings (400k at 50 features, 1.1M at 100).
- 5721742: `@arki/dot`, `/plugin`, `/feature`, `/log` and `/test-harness` now run on Node, Bun, Deno, browsers and Hermes. `bun run test:runtimes` proves it.

  - Durations use `Date.now()` where the runtime has no `performance` (bare Hermes).
  - `hookSignals` reads the global `process` at call time and hooks nothing where there is none. The `SignalTarget` listener type is now `() => void`.
  - `./cli` is an adapter entry (Node only). Lint now runs with the shared library preset, and the existing lint errors in the package are fixed.

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

- 3230f02: `errorCaptureMiddleware({ report })` in `@arki/dot/orpc`: an oRPC middleware that reports a procedure's unexpected failures to `report(error, { path })` and rethrows every error unchanged. An `ORPCError` below 500 is not reported; a reporter that throws is logged at warn on `arki:dot:orpc` and never replaces the procedure's error. Written on an empty context, so it fits any implementer. New type `ErrorCaptureInfo`.
- 232d3e8: Propagate exact Clock sleep failures through retry policies, composition, fallback helpers and Dot services. Retry stops on a failed wait. Owned scopes recognize canonical Clock cancellation only with their private cancellation cause. Callers must inspect retry outcomes; success remains unwrapped.

  Transactions and HTTP clients map wait refusals to their existing cancellation/defect contracts without repeating the operation.

- ff8e384: The `app-stack` template's `.gitignore` now ignores `.local/`, so a new app's local PGlite data (`./.local/db`) can no longer be committed.
- 847f025: docs describe `dot new --json`; correct JSON paths; ship agent docs
- 742f4c3: `dot dev` runs every preflight in a fresh process (hidden `dot _preflight`, same runtime and env as the runner) and reads back one JSON report: the plugin counts, the migrations the boot applied, and the doctor verdict or failure. A restart now checks the app file and env as they are now, not the module cached at the first import, and the supervisor never configures the app itself. A preflight process that crashes, hangs past `preflightTimeoutMs` (default 120 s) or prints no valid report fails with `dot.dev_preflight_failed` (`DevPreflightFailed`); stopping `dot dev` kills it.
- Updated dependencies [2faafcb]
- Updated dependencies [dcf2cef]
- Updated dependencies [232d3e8]
  - @arki/cli@0.1.0

## 0.6.1

### Patch Changes

- Updated dependencies [0e2ed57]
  - @arki/contracts@0.1.0

## 0.6.0

### Minor Changes

- 228b4f5: Features moved into Dot, and the app builder is now a hexagon. `@arki/feature` is merged into `@arki/dot/feature`: `defineFeature()` is now `feature()`, and `composeRouter`, `composeRepos` and the feature types come from `@arki/dot/feature`. `plug`, `plugs` and `tokens` are gone — the builder mounts features itself. `feature()` throws `FEATURE_E003` when `use` holds two slices with the same key (the second used to silently replace the first).

  Apps wire in three steps, checked at compile time: `.use(...)` for driven adapters (what features need), `.features([...])` once for the domain, then `.serve(...)` for driving adapters (what calls the features). `.use()` after `.features()` does not compile, a feature is not a plugin, and adapters declare their side: `driver(features => plugin(...))` is accepted only by `.serve()`, `driven(features => plugin(...))` only by `.use()`. Driven adapters read the features' declarations and boot before them; driving adapters get each feature's slice record with `sliceOf(ctx, f)`. Guard errors are plain sentences, and `dot explain --graph` draws the driven, features and driving groups numbered in boot order (`PluginManifest.role`).

  `@arki/http`: `http()` is a driver for `.serve()` and serves every bound feature's `routes` slice; the `features` option and `HttpFeatureToken` / `HttpFeatureNeeds` are removed. A malformed `routes` slice fails boot with `ARKI_HTTP_E010`.

  `@arki/journal`: the journal splits like the queue. `journal({ j, tables })` is a `driven(...)` adapter for `.use()`: it composes from every feature's `journalHandlers` declarations and boots before the features, so features can write through it. `journalWorker(opts?)` is a driver for `.serve()` that runs projections and effects, getting each feature's effect services from its slice. Inline projections only receive the transaction and the event, so writes never wait for feature services. `journal({ journal })` publishes an app-composed journal and no longer runs a worker; add `.serve(journalWorker())`. Core: `j.compose({ ..., services: 'worker' })` defers effect and tap services, which `journal.worker(db, { services })` and `journal.drain(db, { services })` supply per handler (`HandlerRef`, `HandlerServices`). Removed: the `features` option, the `worker`/`pollMs` options on `journal()`, and the `JournalHandlers` type.

### Patch Changes

- 9fa13ce: Dot plugin error codes join the `ARKI_` scheme: `KV_PLUGIN_E001` is now `ARKI_KV_PLUGIN_E001`, `DB_PLUGIN_E001` is `ARKI_DB_PLUGIN_E001` and `JOURNAL_PLUGIN_E001` is `ARKI_JOURNAL_PLUGIN_E001`. Code that matches on the old strings must update; the `*_PLUGIN_ERROR_CODES` constants carry the new values. The kv and db `docsUrl` slugs follow the codes. `@arki/dot` documents `ARKI_<PKG>_PLUGIN_E<NNN>` as the recommended prefix.

## 0.5.0

### Minor Changes

- `dot new my-app` now creates a full-stack app by default: TanStack Start, an oRPC API, Postgres through `@arki/db`, writes through `@arki/journal` commands, and `@arki/ui` with the workbench design system, all composed with `defineApp`. The app ships one example feature (`notes`), a first migration, `/api/health`, a `docker-compose.yml` for local Postgres, a production `Dockerfile`, tests on in-memory PGlite, and a README and AGENTS.md. It installs from npm alone. The old skeleton is still there with `--template minimal`; any other template name fails with `DOT_CLI_E005`. `dot --version` now prints the real package version.

- 2854df5: `@arki/log` is rebuilt. It has zero dependencies, runs on Node, Bun, Deno, browsers and React Native, and importing it does nothing: no env read, no output, no listener. Libraries log with `getLogger('arki:...')`; apps switch logging on once, in their entry file.

  **Apps must now switch logging on.** Until an app calls `configure()` (or mounts `log()` in a Dot app), only the first 64 records at `warn` and above are kept, and nothing else is written.

  ```ts
  import { configure } from '@arki/log';
  import { asyncContext, fromEnv, stdout } from '@arki/log/node';

  configure({
    ...fromEnv(), // LOG_LEVEL, DEBUG=arki:kv:*
    context: asyncContext(),
    channels: { stdout: stdout() },
    default: { level: 'info', channels: ['stdout'] },
  });
  ```

  A Dot app does the same as its first `.use(...)`:

  ```ts
  import { log } from '@arki/dot/log';

  defineApp('checkout').use(
    log(() => ({
      ...fromEnv(),
      context: asyncContext(),
      channels: { stdout: stdout() },
      default: { level: 'info', channels: ['stdout'] },
    })),
  );
  ```

  How to migrate a call site:

  | Before                               | After                                                                                 |
  | ------------------------------------ | ------------------------------------------------------------------------------------- |
  | `createLogger('x')`                  | `getLogger('x')`                                                                      |
  | `createLogger('x', attrs)`           | `getLogger('x').with(attrs)`                                                          |
  | `new Logger(name, attrs)`            | `getLogger(name).with(attrs)`                                                         |
  | `.withAttribute(k, v)`               | `.with({ [k]: v })`                                                                   |
  | `.child(name, attrs)`                | `.child(name).with(attrs)`                                                            |
  | `log.info('text', attrs)`            | unchanged (the text is now a template; `{name}` reads a field)                        |
  | `log.info({ ...object })`            | `log.emit({ level: 'info', eventName: '<category>.<what>', body: {...} })`            |
  | `log.warn(err)`                      | `log.warn('<what failed>', { error: err })`                                           |
  | `debug('ns')` from `@arki/log/debug` | `getLogger('ns')`, then `.debug('text {field}', { field })` instead of `%s` arguments |
  | `Attributes`, `Body` types           | `Fields`; a `Body` caller uses a string or `emit`                                     |

  Removed: `@arki/log/debug`, `@arki/log/core` (now `@arki/log` itself), the `Logger` class, `rootLogger`, `createLogger`, `configuration`, batching, the Google Cloud formatter, and the `pino` and `debug` dependencies. `DEBUG=arki:*` still works through `fromEnv()`.

  New entry points: `@arki/log/node` (`stdout`, `stderr`, `file`, `fromEnv`, `asyncContext`), `@arki/log/otel` (`otelTrace`, `otelSink`; the `@opentelemetry/*` packages are optional peers) and `@arki/log/testing` (`fakeLog`).

  `@arki/dot`: plugins can fill a new logging slot (`plugin({ logging: ({ appName }) => handle })`). The kernel switches logging on before its first lifecycle record and closes it after its last one, also when boot fails. Two logging plugins in one app is `DOT_LIFECYCLE_E018`. `@arki/dot/log` exports `log()`, which fills the slot, names the service after the app and publishes the handle as the `logging` service. Hook spans now stamp their trace on log records through `@arki/log`, and importing `@arki/dot` reads no env and writes nothing.

### Patch Changes

- 0685dfa: Mistakes in declarations are now caught as early as possible: by TypeScript when the types can say it, otherwise by a coded error when the module loads.

  - `@arki/feature`: `composeRouter` and `composeRepos` reject a key claimed by two features at compile time. The runtime check stays as a backstop and now throws `FeatureError` with code `FEATURE_E001` (router) or `FEATURE_E002` (repo) and a `remediation`. Messages are unchanged.
  - `@arki/http`: mount paths for `rpcMount(...)` and `.mount(...)` are typed `MountPath` (`` `/${string}` ``), so a path without a leading `/` is a compile error. The runtime check stays.
  - `@arki/db`: the projection builder's two "call .named() / .on() first" errors are now `DbCompositionError` with codes `DB_COMPOSITION_E002` and `DB_COMPOSITION_E003`. `DbCompositionError` gains an optional `remediation`.
  - `@arki/dot`: when `dot explain` or `dot doctor` cannot import the app because a declaration threw a coded error, the output shows that error's code and its fix, not only "import failed".

- Fix: `import '@arki/dot'` failed under Node with "Unknown file extension .ts". The `import` condition of the root, `/cli`, `/log` and `/test-harness` entries pointed at the TypeScript source in `src/`. They now point at the compiled `dist/*.js`, like every other `@arki/*` server package.
- Updated dependencies [2854df5]
  - @arki/log@0.1.0

## 0.4.1

### Patch Changes

- Dependency refresh: `@opentelemetry/api` ^1.9.1, `zod` 4.6.5; internal `@arki/assert`, `@arki/contracts`, `@arki/log` pins updated. No API changes.

## 0.4.0

### Minor Changes

- BREAKING: the composition unit is renamed pip → plugin across the kernel.

  - `pip()` → `plugin()`, `Pip<>` → `Plugin<>`, `initPips` → `initPlugins`, `testPip` → `testPlugin`, `PipManifest` → `PluginManifest`, `DotPipError` → `DotPluginError`, `*_PIP_E*` error codes → `*_PLUGIN_E*`.
  - Subpath export `@arki/dot/pip` → `@arki/dot/plugin`.
  - CLI/OTel identifiers follow (`dot.plugin.*` spans, PLUGIN columns).
  - Docs: composition doctrine (`docs/composition-doctrine.md`) — inert declarations, one-way dependencies, lazy singletons, deferred adapter config, client-surface rules, import-purity + browser-purity enforcement.

  Migrate with a find/replace of the symbol names; runtime semantics are unchanged.

### Patch Changes

- Updated dependencies
  - @arki/contracts@0.0.3

## 0.3.0

### Minor Changes

- 4b1c59f: Route manifest metadata + `dot explain --openapi`. `registerRoute` accepts
  optional `description`, `input` (per-location JSON Schemas: `query`/`body`),
  `output`, and `streaming` fields that flow into `manifest.routes` untouched
  — adapters convert their validation schemas at `configure` time so the
  manifest stays plain serializable data. `dot explain --openapi` renders an
  OpenAPI 3.1 document straight from the static manifest (no boot): path
  params, query parameters with required flags, JSON request/response bodies,
  and `text/event-stream` responses for streaming routes. Mutually exclusive
  with `--graph`; explain-only; composes with `--json`. Built for
  `@arki/http`'s `registerRoutes`, usable by any adapter.

  Also fixes a provides-inference hole: a `boot` that returns `void` gave
  `TProvides` no inference candidate, so TypeScript substituted the
  constraint (`ServiceRecord`, whose `keyof` is `string`) instead of the
  declared `EmptyShape` default — poisoning the app builder's collision
  check for every later `.use()`. `pip()` now normalizes the fallback
  (`InferredProvides`): a void-booting pip provides nothing, as documented.

## 0.2.0

### Minor Changes — testing, operations, introspection (48a8733)

- **`testPip` — typed unit-test builder.** Satisfy a pip's needs directly
  with fakes; every `.provide()` is compile-checked (token or anonymous
  key form) and `boot()` refuses to compile while needs remain unprovided.
  Runs the real kernel underneath, so teardown order, lazy lifting, and
  `$config` behave as in production. Exported from the package root and
  `@arki/dot/test-harness` alongside the existing erased `testApp`.
- **`hookSignals(app)` — graceful-shutdown wiring.** First SIGTERM/SIGINT
  drains via `dispose()` (bounded by `timeoutMs`, default 10 s) and
  re-raises the signal for standard exit semantics; a second signal falls
  through to the runtime default. Returns an unhook function; the process
  target is injectable for tests.
- **`hookTimeoutMs` watchdog (`DOT_LIFECYCLE_E015`).**
  `defineApp(name, { hookTimeoutMs })` bounds every async hook invocation;
  a hook exceeding the budget fails with E015 naming the pip and hook, and
  the kernel applies its normal boot-rollback / start-cascade / teardown-
  aggregation rules. Off by default.
- **`dot explain --graph` / `dot doctor --graph`.** Renders the pip graph
  as Mermaid flowchart source — declaration-ordered nodes, observed
  dependency edges (doctor boots; explain shows boot order). Composes
  with `--json` (`data.source`).

## 0.1.4

### Patch Changes

- Docs-only release: README rewritten around the v2 dependency-injection model — needs-as-witnesses with inferred provides, the compile-time wiring guard, tokens (`token`/`provide`/`Token.instance`), multi-instance `rename()`, lazy services (`lazy`/`service.lazy`), the reserved `$` kernel namespace, a 12-pip commerce-platform walkthrough, and the E011–E014 runtime error-code table. No runtime changes.

## 0.1.3

### Kernel hardening (external review findings) — 9871fce

- **Lifecycle transitions are serialized.** `boot()` / `start()` / `stop()` /
  `dispose()` now run on a single transition queue: concurrent calls to the
  same transition coalesce onto one in-flight promise (hooks never
  double-run — this previously held for boot/stop/dispose but not `start`),
  and calls to _different_ transitions wait their turn and re-check state at
  the head of the queue. Previously a `dispose()` completing while `start()`
  awaited a hook could be overwritten by the resuming start — the app ended
  `started` after being disposed.
- **Lazy auto-dispose tracks ownership.** A `Lazy<T>` handle republished by
  a downstream pip (identity pass-through via `service.lazy`) is now cleaned
  up only by its _first_ publisher, after that pip's own `dispose` hook.
  Previously the republisher's record — disposed earlier under reverse
  order — closed the handle out from under the provider's dispose hook.
- **`$`-prefixed service keys are enforced as reserved**
  (`DOT_LIFECYCLE_E014`). `pip()` now rejects `$`-prefixed needs aliases and
  publish keys at compile time (constraint-level — no new unsafe casts), and
  the kernel validates aliases, publish keys, and `rename()` targets at
  runtime, so `$app` / `$pip` / `$config` can never be shadowed. Docs
  previously claimed this; now the kernel guarantees it.

## 0.1.2

### Patch Changes

- Ship TypeScript source in the npm tarball (`src/**` added to `files`). npm installs and the read-only GitHub mirrors now carry the original `.ts` source alongside compiled `dist/` — better debuggability on the experimental track. No runtime changes.
- Updated dependencies
  - @arki/assert@0.0.2
  - @arki/contracts@0.0.2
  - @arki/log@0.0.2

## 0.1.1

### v2 pip contract — typed dependency injection (BREAKING on the experimental track)

- **`pip(config)` replaces `defineDotPip`.** Pips declare consumed services
  as a `needs` shape of type witnesses (`service<T>()` app-local,
  `token<T>()('key')` cross-package); hooks destructure them fully typed
  (`async boot({ db, log })`). Provides are inferred from `boot`'s return
  value — a plain record, no `{ services: ... }` wrapper, no generic
  arguments.
- **Compile-time wiring guard.** `.use(pip)` fails to typecheck when the
  pip's needs aren't satisfied by earlier `.use()` calls or its provides
  collide with an existing wire key. Declaration order IS boot order — the
  topological sort and name-based `dependencies` array are gone
  (`DOT_LIFECYCLE_E009`/`E010` retired; `E012` UnsatisfiedNeed and `E013`
  ServiceCollision added for erased/dynamic composition).
- **`rename(pip, map, name?)`** is the multi-instance primitive — mounting
  two `db(...)` pips now either renames or fails loudly, instead of the
  previous silent last-writer-wins overwrite of `app.services.db`. Adapter
  `name` options were removed accordingly.
- **Manifest dependency edges are observed**, not declared: the kernel
  records which pip's published service satisfied which need during boot.
- Hook contexts carry `$app` / `$pip` / `$config` kernel keys; `start` /
  `stop` / `dispose` see the pip's own provides plus its needs (reverse
  teardown keeps needs alive through `dispose`).
- Adapters migrated: `@arki/env/dot`, `@arki/kv/dot`, `@arki/db/dot`,
  `@arki/event-sourcing/dot`.
- **`lazy(init, { dispose? })`** — deferred service initialization. Publish
  `{ db: lazy(() => openDb(), { dispose: db => db.close() }) }` from `boot`;
  the typed `Lazy<T>` handle initializes on first `get()` (memoized,
  single-flight, failed attempts retry). Never-touched handles never
  initialize; the kernel auto-disposes initialized handles in reverse
  declaration order during `dispose()`/rollback — after the publishing
  pip's own `dispose` hook, and without requiring one.
- **`service.lazy<T>()`** — lifting needs witness. The consumer always
  receives a `Lazy<T>` handle whether the provider published a plain `T`
  (lifted into a pre-initialized wrapper via `lazyOf`, also exported) or a
  `Lazy<T>` (passed through by identity) — consumers stop caring about the
  provider's eager-vs-lazy strategy, and the wiring guard accepts both.

## 0.1.0

### Initial release

- First public publication on npm (experimental track) — 2026-05-21.

  **`@arki/dot`** is the application composition kernel — "the dot at the center" that every ARKI app boots through. It defines:

  - **`defineApp`** — the contract every consumer uses to declare an app shape
  - **5-hook lifecycle** — `configure` → `boot` → `start` → `stop` → `dispose`
  - **`DotAppManifest` + `DotDiagnosticsSnapshot`** — the 5-array introspection contract every adapter contributes to (`env`, `database`, `cache`, `events`, `jobs`)
  - **`DotPipError`** — structured error envelope for hook failures
  - **OTel-first observability** — `dot.app.<phase>` + `dot.pip.<hook>` spans, two duration histograms, `arki:dot:lifecycle` logger with trace correlation
  - **`dot` CLI** — `dot new`, `dot explain`, `dot doctor`, all emitting agent-native JSON envelopes

  **Why `0.1.x`, not `0.0.x`**: Wave 1's foundation packages shipped at `0.0.x` because they're zero-dependency utilities — the "this is just a function library" tier. `@arki/dot` is the layer above: experimental in its own right (no API stability promise yet), but the boot contract has been exercised through multiple internal apps and verified by the scorecard's `dot-gates` probe (3-adapter boot + manifest/diagnostics 5-array check + CLI envelope shape). The `0.1.x` stream signals "kernel layer, experimental but past first integration." API breakage may still happen at any `0.1.x` boundary.

  **Dependencies** (all live on npm at `0.0.1`):

  - `@arki/assert` `0.0.1`
  - `@arki/contracts` `0.0.1`
  - `@arki/log` `0.0.1`

  Wave 3 adapters (`@arki/db`, `@arki/kv`, `@arki/event-sourcing`) ship together with this release.
