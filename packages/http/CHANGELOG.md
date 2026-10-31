# @arki/http

## 0.4.0

### Minor Changes

- 5d55e12: `storedResponse` is now typed as a Standard Schema, not a Zod object, so `@arki/http/idempotency` no longer exposes Zod. `parse(storedResponse, value)` from `@arki/schema` works as before. Calling Zod methods on it (`storedResponse.parse(value)`, `.safeParse`) no longer compiles. `StoredResponse` is the same shape, now written as a plain type that an exact type test locks to the schema.

  No demo impact: the only uses in the monorepo go through `parse(storedResponse, value)`.

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

- c36e614: `buildEngine` now routes with its own compiled router and keeps Hono behind it. Each route whose path is static segments and `:name` segments is matched by a `Map` or a segment trie built once; mounts, rpc mounts, routes under a mount prefix, optional placeholders (`:x?`), wildcards and the 404 still go to Hono. Every route runs the same pipeline as before, so responses and error envelopes are unchanged. Measured on the package's new server benchmark (`bun run bench:server`): about 10 % less server CPU per request on Bun and Node, and up to 40 % more throughput on parameter routes on Bun.

  New: `buildHonoEngine` builds the Hono-only engine, for running both side by side. `Engine.bunRoutes` carries the routes Bun can match natively; `listen(engine, options)` accepts an engine and passes them to `Bun.serve({ routes })` (`listen(fetch, options)` still works). `composeMiddleware(engine, middleware)` wraps an engine, including its Bun route handlers, and returns an engine; the `http()` Dot plugin uses it so the in-flight gauge and app middleware see every request. Zod schemas in contracts are compiled once with `z.compile()` when first used; the request context parses `url` on first read; a route that declares no params, headers, query or body skips input decoding; the request span costs nothing when no tracer records it.

  Breaking: the ambient request context (`requestContext()` from `@arki/http/context`) is opt-in. Build the engine with `buildEngine(bundles, { requestContext: true })` or pass `requestContext: true` to `http()`; an engine built without it never enters the `AsyncLocalStorage`, which every request paid for. Calling `requestContext()` when engines exist but none opted in throws `ARKI_HTTP_E014`; outside any engine it still returns `undefined`. See `docs/upgrades/0.3.0-to-0.4.0.md`.

- c3e63ba: Entrypoint handlers are now typed with what they really receive at every builder stage. `EntrypointServicesOf<typeof core>` is new in `@arki/dot`: a feature's `entrypointOnly` needs plus its `usecases`. `endpoints(core, build)` and `schedules(core, defs)` use it, so a feature with no `.usecases()` can now read its `entrypointOnly` needs in a route or schedule, and can no longer read plain needs that never arrive. A rebound `entrypointOnly` lazy need (`feature.instance(name, rebind)`) now stays entrypoint-only.
- 8944628: `validatePublicURL`, `safeFetchBytes` and `publicFetch` from `@arki/http/public-fetch` no longer throw for expected refusals. `validatePublicURL` and `safeFetchBytes` return `UnsafeUrl` (with a `reason`), `RedirectLimit`, `ResponseTooLarge`, `NetworkFailure`, `RequestTimeout` or `RequestCancelled`; `UnsafeUrlError` and error code `ARKI_HTTP_E430` are removed. `publicFetch` still has to resolve a `Response` or reject, so it rejects the way `fetch` does for a network error: a `TypeError` whose `cause` is the failure (a caller abort rejects with the signal's reason). The 500 envelope of an unexpected handler error now shows its message only under `NODE_ENV=development`; every other value, including `test` and an unset variable, answers `internal error`. No docs impact beyond the updated README section. No demo impact.
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

- 36b4da8: Auth checks are plain steps (RFC `docs/rfcs/2026-10-21-dot-middleware.md`, step 4).

  - `@arki/auth` adds `authed`, `verified` and `role(name)`: plain functions that read `ctx.principal` and narrow it to non-null, or refuse with `auth.unauthenticated` (401) / `auth.forbidden` (403). Attach them with the transport's `step()`: `impl.x.use(step(authed))` (`@arki/dot/orpc`), `routes().use(step(authed))` (`@arki/http`). The handler keeps the app's own principal type.
  - `@arki/auth/http` adds `principalFromHeaders(auth)`, a step that adds `principal` (`null` for a guest) from the request's credentials.
  - Breaking: `guards<C>()` is removed from `@arki/auth/orpc`. `const { authed } = guards<C>()` → `import { authed } from '@arki/auth'` and `.use(step(authed))`. `can(policies)(name, load)` is now imported directly from `@arki/auth/orpc`, same call shape.
  - Breaking: `withPrincipal(auth, options)` and `withOptionalPrincipal(auth)` are removed from `@arki/auth/http`. Use `.use(step(principalFromHeaders(auth), { failureHeaders: authFailureHeaders }))`, then `.use(step(authed, { failureHeaders: authFailureHeaders }))` (or `verified`, `role(name)`) on routes that need a signed-in caller.
  - Breaking: `@arki/http` removes `derive(key, fn)`, the bundle's `.derive()`, `Deriver`, `ErasedDeriver`, `BASE_CTX_KEYS` and `ARKI_HTTP_E007`. A keyed deriver becomes a step that returns an object: `.derive('db', fn)` → `.use(step(ctx => ({ db: fn(ctx) })))`. `verifyWebhook({ scheme })` is a step: `.use(step(verifyWebhook({ scheme })))` adds `ctx.webhook`. A route bundle's `derivers` field is renamed `stages` (it holds steps and arounds).
  - Fix: `@arki/http` steps after the first one see `ctx.url` and `ctx.signal` again (they were dropped when the context was extended). This fixes `@arki/live`'s endpoint, which reads `ctx.url` in its second stage.

- 1a897f8: Handler events (RFC `docs/rfcs/2026-10-21-dot-middleware.md`, step 3). Every handler a Dot app mounts — an oRPC procedure through `bind`, an HTTP route or `rpc()` mount, a queue job, a schedule run — now reports to the app's lifecycle observers:

  - A handler event has `kind: 'handler'`, `transport` (`'rpc' | 'http' | 'job' | 'schedule'`), `feature` (the owning unit) and `name` (the oRPC path, `METHOD /path`, the job or schedule name). Its `status` is `starting`, then `completed` (with `durationMs` and `outcome: 'ok' | 'refused'`; a refusal carries its `failure`) or `failed` (a throw, with `error`). A returned failure or a step's refusal is `completed/refused`, never `failed`. On oRPC, a thrown error below 500 is a refusal.
  - `@arki/dot` adds two observers for `defineApp(name, { observers })`: `reportErrors({ report })` calls `report(error, { transport, feature, name })` for every `failed` handler, and `logHandlers()` writes one DEBUG line per handler on `arki:dot:handlers`. With no observer registered, a handler call costs nothing extra.
  - Transport adapters reach the emitter through `handlerObserverOf(services)` from `@arki/dot/feature` (`watching()`, `run(ref, work, outcome?)`); the kernel context carries it as `$handlers`.
  - Breaking: `errorCaptureMiddleware` is removed from `@arki/dot/orpc`. Register `reportErrors({ report })` instead; it keeps the same rule (a 4xx is traffic, anything else is reported).
  - Breaking: `@arki/queue` removes its standard middleware (`timingMiddleware`, `loggingMiddleware`, `errorHandlingMiddleware`, `validationMiddleware` and the other `src/middleware` exports). Timing and logging are `logHandlers()`, error reporting is `reportErrors()`, validation is `.input(schema)`, timeouts are `options.timeoutMs`, and a per-job logger is a `step`.
  - `@arki/failure/orpc`: the `ORPCError` that `rpcError` and `orThrowRpc` throw carries the failure as its `cause`, on the server only (oRPC never sends `cause` to the client).

- e80211d: Return exact canonical engine refusals and final defects while preserving raw throw retry/fallback provenance. Remove obsolete operational error classes and guards; preserve static backoff diagnostics. Capture timeout/caller cancellation before observation. Infer heterogeneous policy unions.

  Migrate HTTP response/network mapping, DB exhausted SQLSTATE conflicts, Embeddings defect admission and RPC consumers together. See the Resilience 0.2.0-to-0.3.0 upgrade guide. No demo impact: the affected app callers and generator admission guidance are migrated in place.

- 17e86d3: Breaking: the object-form feature API is removed. Write every feature as a `defineFeature(name).needs().infra().usecases().provides().entrypoints()` chain.

  - `@arki/dot`: removed `feature()`, `plug`, `composeRouter`, `composeRepos`, `tokenOf`, `entrypointsOf` and the types `AnyFeature`, `MountedFeature`, `UnitOf`, `MountedUnitsOf`, `FeatureConfig`, `ComposedRouter`, `ComposedRepos`. `defineApp().features()` takes chain features only. Use `routerFor(rpcContract, features)` instead of `composeRouter`, and a feature's own `repos({...})` store instead of `composeRepos`. Read `f.entrypoints` instead of `entrypointsOf(f)`. Lifecycle hooks (`boot`, `start`, `stop`) live on an infra unit inside the feature.
  - `@arki/http`: removed `endpoints(build)` and `EndpointsFeatureSlice` from the root export. Use `endpoints(core, build, { contracts })` from `@arki/http/dot` in `.entrypoints()`.
  - `@arki/schedule`: removed the `schedules(needs, defs)` overload. Use `schedules(core, defs)` in `.entrypoints()`.
  - `@arki/queue`, `@arki/journal`, `@arki/admin`: dropped their object-form branches. The chain API is unchanged.

### Patch Changes

- b992897: Return canonical retry cancellation before dispatch and after cancelled rejected work, preserving completed outcomes and actual clock failure identity. Propagate the exact inferred RetryFailure union through helpers, composition and Dot; update Embeddings and HTTP policy types, RPC failure declarations and application template guidance. DB maps retry cancellation to its existing TransactionCancelled; Games Platform persists it as cancellation.

  no demo impact: no demo declares the narrower retry-wait outcome type; application failure admission is migrated. Embeddings changes only its existing optional policy type/schema binding.

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

- e132ad3: Hand-written object guards now come from `@arki/schema` (`is(value, recordSchema)` or `plainObjectSchema`), per A-39. Replaced: the `isRecord`/`isPlainObject`/`isObject` helpers in `dot`, `cli`, `http`, `expr`, `lock`, `mail`, `embeddings` (its internal `isRecord`, not a public export), `testing` and `payments`, plus inline `typeof x === 'object' && x !== null` checks on unknown values. Behaviour is the same, except that the inline checks and `lock`'s guard no longer let arrays through. `@arki/expr` and `@arki/lock` now depend on `@arki/schema`.
- 1e47612: `Lazy<T>` and `resolveLazy` move from `@arki/ts` to `@arki/dot/plugin` as `Deferred<T>` and `resolveDeferred`. They are the "value now, or a thunk the adapter calls at boot" shape that Dot adapters accept, and the old name clashed with Dot's own `Lazy<Value, Cleanup>` service handle. Behaviour is unchanged. `@arki/ts` no longer exports them; to upgrade, import `Deferred` and `resolveDeferred` from `@arki/dot/plugin`.

  `@arki/http` (`port`) and `@arki/kv` (`kv()`, `kv.optional()`) now type their deferred options as `Deferred<T>`, the same shape as before, and no longer depend on `@arki/ts`. `@arki/env` drops an `@arki/ts` dependency it never imported.

  demo impact: none (neither demo imports `Lazy` or `resolveLazy`).

- 49517e2: The build no longer compiles type tests (`*.test-d.ts`). They stay in `typecheck`, but a type test can no longer fail the build, and the published `dist` no longer holds compiled type tests.

  `@arki/db` exports the `OnDelete` type from `@arki/db/id` and `@arki/db/sqlite`. A package whose types come from `idColumns` (such as `@arki/auth`) can now build its declarations. Before, TypeScript could not name `OnDelete` and stopped with TS2883.

  `@arki/ai` drops a `@ts-expect-error` above the `@huggingface/transformers` import. That package is now always installed, so the comment had no error to hide and failed the build.

- 5d55e12: Docs only: the agent guide names the Dot action migration guide in plain text instead of a link that leaves the package. No code change.
- Updated dependencies [289ba73]
- Updated dependencies [c1ed2a3]
  - @arki/dot@0.9.0
  - @arki/resilience@0.3.1

## 0.3.0

### Minor Changes

- 5d05b9c: Contracts take any Standard Schema (zod, valibot, arktype, hand-written), not only zod.

  - Breaking: `params`, `headers` and `query` are records with one field per key (`{ id: OrderId }`), not one `z.object`. A field is a schema, a `codec()`, or `optional(...)` around either; the `optional` marker decides `?:` and a missing optional key reaches the handler as `undefined`.
  - Breaking: a bare schema is its own encoder. Two-way fields (ISO string <-> `Date`) use the new `codec(decode, encode)`, whose pair must reverse each other's types; a zod `z.codec` inside a bare schema no longer encodes.
  - Breaking: an optional path placeholder (`:x?`) needs an `optional(...)` field and vice versa, checked at declaration (E011).
  - Breaking: a 400 now lists every failing field as `where.key: message` (`request validation failed: query.page: …`); a schema that throws answers 500.
  - Breaking: removed `SchemaLike`, `HeaderSchema`, `ParamSchema`; `RouteInput` moved to the contract types; `ResponseSchemas` holds `Wire` values.
  - Breaking: OpenAPI and manifest JSON Schema come from each schema's `~standard.jsonSchema`; a schema with none (or a failed conversion) throws the new `ARKI_HTTP_E013` naming `withJsonSchema`. `$defs` are kept as `components.schemas`.
  - Breaking: `storedResponse` (`@arki/http/idempotency`) is typed `StandardSchemaV1<unknown, StoredResponse>`: read it with `parse` from `@arki/schema`.
  - New: a cross-field `check` hook on routes and SSE routes; its issues answer 400.
  - New: `codec`, `optional`, `Codec`, `Wire`, `Field`, `Fields`, `FieldsOf`, `Optional`, `Reversible`, `ValueOf`, `WireValue`, `CheckResult`, `ErasedInput` exports.

- 8e55924: The typed client retries and times out. `createClient` takes `policy` (any `@arki/resilience` policy without a fallback), `retryOn` (default `retryTransient`: network failures and 408/429/502/503/504, only for GET, HEAD, OPTIONS, PUT, DELETE or a request with an `idempotency-key`) and `timeoutMs` (throws `HttpError` 408, new code `ARKI_HTTP_E408`). Only what `retryOn` accepts goes back into the policy, so a POST is never sent twice by accident. `@arki/http/public-fetch` adds `publicFetch()`, the DNS-pinned SSRF guard as a `fetch` for the client, with a `timeoutMs` deadline (default 30 s); `safeFetchBytes` now shares its code, and a timeout during DNS rejects with the signal's reason instead of `Fetch timed out.`.
- 47d296b: Infer nominal request and idempotency owner IDs from canonical declarations.
  Return precise generation failures before protected work, admit framework
  request failures in typed clients, and add default request/idempotency OTel spans.

  ResponseCache owner fixtures must use idempotencyOwnerId.schema. Keep the whole
  IDEMPOTENCY_FAILURES tuple on protected routes; it now includes generation
  failures. Stored/header strings are unchanged. See docs/upgrade-identities.md.

- f56ab9f: A route contract now describes the whole request and response. `route.*()` takes `params` (a zod object with one key per path placeholder), `headers` (lower-case names; only the declared names are read) and `responses` (status to body schema). A handler answers a listed status with `reply(status, body, { headers? })`. An optional last path segment (`/orders/:id?`) serves both paths and appears twice in OpenAPI. `route.sse` takes `params` and `headers` too. The client sends typed params and headers, drops a missing optional segment, and decodes a body by `responses[status]` before `output`.

  New exports: `raw`, `reply`, and the types `RawOutput`, `Reply`, `RouteDef`, `SseDef`, `ResponseSchemas`, `ParamSchema`, `HeaderSchema`.

  Breaking changes:

  - `RouteContract` and `SseContract` take `<TPath, TDef>` (the literal def) instead of positional `TQuery, TBody, TOutput, TFailures`. `RouteInput`, `RouteHandler`, `SseHandler` and `HandlerResult` follow. `ParamsOf` marks an optional placeholder's key optional.
  - A contract with no `output` now answers 204 with an empty body, and its handler returns nothing. It used to return a `Response`. Manifests regenerate from code, so `action-meta` stays `@1`; its meaning changes from 200 to 204.
  - Returning a `Response` needs `output: raw()`. Without it the engine answers 500 `ARKI_HTTP_E510`, and a plain value from a `raw()` route is `E510` too. The engine never validates a raw `Response`. `responses` may still document it (`x-arki-raw: true` in OpenAPI).
  - A result that does not fit the contract (undeclared `reply` status, a value on a no-output route) answers 500 `ARKI_HTTP_E511`.
  - An inconsistent contract throws `HttpConfigError` `ARKI_HTTP_E011` from `route.*()` (params not matching the path, bad optional placeholder, upper-case header, `responses` key outside 200-599 or 204/304, `responses[200]` next to a schema `output`).
  - OpenAPI describes the wire form (`io: 'input'`), lists every declared status, and `createClient` resolves `undefined` for a no-output route and the `Response` for `raw()`.

  `@arki/admin`: the four Foreman routes and the fleet snapshot route declare `output: raw()`. The fleet route documents its payload with `responses: { 200: fleetSnapshotSchema }`.

- 3064b6a: Keep unresolved HTTP idempotency reservations until reconciliation and return precise canonical cache failures. Replay retention starts at confirmed persistence; all bounded responses, including error statuses, are stored. Oversized requests are refused before execution, and unreplayable responses retain their reservation.

  ResponseCache.begin no longer accepts a TTL; finish requires it. Postgres/Redis adapters confirm ownership and preserve unresolved claims; Journal pruning respects their lifecycle. Coordinate writer upgrades and reconcile legacy expiring reservations. See @arki/http/docs/upgrade-idempotency.md.

- af3d5a1: Handlers can return `@arki/failure` failures. A contract lists them by definition: `route.get('/posts/:id', { id, output, failures: [PostNotFound] })`. When a handler returns or resolves to a failure, the server answers with the failure's status and the usual error envelope, which now carries the failure's `data` too. The output schema does not run on a failure. A handler that can return a failure the contract does not list does not compile. `RouteFailure<typeof contract>` is the union of the listed failures.

  `createClient` resolves to the failure instead of throwing when the answer's code is one the contract lists. It rebuilds it with `revive` and checks its data with the definition's schema. The call's type is `Output | the listed failures`, so the frontend can `match` on it. Other error answers still throw `HttpError`.

  Security fix: `createClient` refuses a path param that is empty, `.` or `..` and throws `ARKI_HTTP_E400` before sending. Before, `..` in `/orders/:id/cancel` sent the request to `/cancel`, a different endpoint, with the user's cookies.

- 932c9e4: `endpoints(core, build, { contracts })` in `@arki/http/dot`: a `defineFeature` feature's HTTP surface, for its `.entrypoints(...)`. `build` gets the feature's needs, private infra and `usecases`, typed from the core; `contracts` become the feature's manifest actions. `http()` serves chain and object-form features from one route table.
- 966efcd: Feature instances (`feature.instance('eu', rebind)`) now serve their routes, mounts and rpc prefixes under `/<instance>`, so two copies of one feature no longer collide (`GET /reports` becomes `GET /eu/reports`). Set `instancePath: (instance, path) => string` on `http(...)` to change the shape. Plain features are unchanged, and the duplicate-route check still applies.
- f6a15d0: Breaking: `FailureDefinitionLike.dataSchema` is now the strict Standard Schema type from `@arki/schema` (new dependency), instead of `@arki/failure`'s removed loose copy.
- 2c0b668: Make failure the acyclic validation foundation. Schema parsing now returns exact typed validation failures, and failure revival returns typed protocol/validator defects instead of throwing. Add validated versioned JSON envelopes; retain legacy envelope reads while rejecting non-JSON data and changing output transforms. oRPC error maps validate output-only wire data.

  Migrate consumers to check failures, propagate them through Journal event/write/replay and queue/mail operations, and use explicit exception bridges at foreign callbacks. Journal rejects invalid event entries before inserting them. See `@arki/failure/docs/upgrade-typed-validation.md` for breaking API and stored-data migration details.

- 49a339e: RPC error maps retain their original failure definitions for exact revival by another contract adapter. Use `rpcFailureDefinitions` to read these references; wire JSON remains unchanged.

  Add reusable browser-safe action contracts, server execution ownership and scoped
  OpenTelemetry helpers. Native RPC/HTTP adapters parse and encode once while
  sharing canonical failures and explicit exposure, principal and approval policies.

  Breaking: HTTP boundaries and auth policies return typed canonical failure values;
  update callers that inspect legacy strings or expect thrown refusals. Retry
  ownership is explicit. MCP adds browser-safe contract annotations and callable
  tools that reuse the gateway's typed native client, preserve canonical failures,
  and enforce access, approval and result budgets. Hosts provide approval authority;
  the full MCP server and durable confirmation store remain separate work.

- 536d17d: Idempotency keys on HTTP and oRPC. `@arki/http/idempotency` adds `idempotent({ cache, scope, routes, ttl, ... })`, a middleware that runs a listed request once per `Idempotency-Key` and replays the stored response (status, body, allowlisted headers) on a repeat. `@arki/journal/http` stores responses on `journal_receipts`, and `@arki/kv/redis/idempotency` on Redis. `@arki/journal/orpc` adds `idempotent()`, which turns the header into receipt keys for every command of a procedure, and `journal.bind` takes `keyPerCommand`.

  Migration: `journal_receipts` gains three nullable columns, `owner`, `expires_at` and `response`. Run `drizzle-kit generate` and apply the migration before using `@arki/journal/http`. Existing command receipts are unchanged. New error codes `ARKI_HTTP_E410`, `E411`, `E412`.

- d11c9fb: Output is now encoded, not parsed. The server runs each output schema (and each SSE event schema) in Zod's encode direction, so a codec works: a handler can return a `Date` and the wire carries the ISO string. Plain schemas behave as before. An output schema with a one-way `.transform()` now fails with a 500, because it has no encode direction; use `z.codec` instead. `SchemaLike` gains an `encode` method, which every zod schema already has.

  New: `createClient` from `@arki/http/client` builds a typed fetch client from the same contracts. Params, query and body are typed and encoded the way the server decodes them, the output is decoded with the output schema, and failures throw `HttpError` with the server's error code. It uses only `fetch`, so it runs in browsers and React Native.

- ee69f29: The SSRF guard in `@arki/http/public-fetch` now throws `UnsafeUrlError` (code `ARKI_HTTP_E430`, with a `remediation`) for every URL it refuses: not http(s), not a URL, refused credentials, or a private, loopback or link-local address, whether typed, in the DNS answer, or behind a redirect. `safeFetchBytes`, `publicFetch` and `validatePublicURL` all throw it, and it is exported from `@arki/http/public-fetch` and the root entry. A refused URL is refused every time, so a caller can now tell it apart from a network failure and not retry it. Network failures, the size limit and the redirect limit keep throwing what they threw before. Messages are unchanged.
- b9d0a86: Return precise HTTP idempotency preparation failures before cache acquisition or application execution. Scope callbacks can return inferred canonical failures; every protected route must declare them alongside the complete IDEMPOTENCY_FAILURES tuple.

  Unreadable request bodies, unavailable SHA-256 and observed cancellation have distinct outcomes. Thrown scopes and broken hashing providers become supervised defects with private causes. Key and fingerprint bytes remain compatible. See docs/upgrade-idempotency.md.

- fce3e8c: Return exact canonical webhook signing, verification and request-preparation
  failures, supervise Web Crypto and add safe default tracing. Declare
  WEBHOOK_FAILURES on protected HTTP routes and narrow direct results before
  accepting a delivery. Payments fails closed on returned verification failures;
  the Journal inbox declares the new contract and outbound delivery returns signing failures without sending or acknowledging jobs. Returned signing failures need an explicit backoff retry predicate.
- a1d4ee6: Signed webhooks in. `@arki/http/webhooks` adds `verifyWebhook({ scheme })`, a deriver that checks a request's signature over a clone of its body, and three schemes: `standardWebhooks`, `stripe` and `hmac` (GitHub, Slack, Shopify and most others). Each scheme also has `verify` and `sign`. Several secrets are accepted at once for rotation, the signed time must be within a tolerance, and `webhook.id` comes only from signed bytes (for `hmac`, the SHA-256 of the body), ready to be a journal idempotency key. New error codes `ARKI_HTTP_E012`, `E413`, `E420`, `E421`, `E422`.

  `@arki/payments` checks Stripe signatures through `stripe()` from `@arki/http/webhooks` and now depends on `@arki/http`. Results are unchanged, except that a `t=` that is not Unix seconds now reports `Invalid signature format` instead of a time outside the window.

### Patch Changes

- cbefc52: Dot plugins no longer pass a hard-coded `version` (the field was removed from `@arki/dot`).
- ddcc363: SSE heartbeats work outside Node and Bun. `sseResponse` called `.unref()` on the heartbeat timer, which throws where `setInterval` returns a number (browsers, Deno's web API, Hermes), so any SSE route with `heartbeatMs` failed to open there. It now unrefs the timer only when the timer has an `unref` method.
- 232d3e8: Propagate exact Clock sleep failures through retry policies, composition, fallback helpers and Dot services. Retry stops on a failed wait. Owned scopes recognize canonical Clock cancellation only with their private cancellation cause. Callers must inspect retry outcomes; success remains unwrapped.

  Transactions and HTTP clients map wait refusals to their existing cancellation/defect contracts without repeating the operation.

- 28cd943: `validatePublicURL` and `safeFetchBytes` take `allowCredentials` (`user:pass@` accepted, sent as a Basic `Authorization` header, stripped from the request URL, dropped on a cross-origin redirect; refused by default). The module's top level no longer imports `node:` modules (the resolver and undici load on first use), so the pure checks also load in a browser. `safeFetchBytes` takes `method` and `body` (a redirected POST follows browser rules: 301/302/303 become a bodiless GET, 307/308 replay the body, every hop re-validated) and a `transport` (`lookup` + `fetch`) so a consumer's test can fake the network while the address checks stay real. `systemTransport` is the default.
- 953991a: Docs standard: new `AGENTS.md`, `llms.txt` and agent guide, a README in the standard section order with a tested quick start, `Limits` and `Failure behaviour`, and `@fix` and `@verify` tags on every error code. The docs now ship in the package.

  no demo impact: documentation and doc-example changes only, runtime behaviour unchanged

- 5bc6390: `http()` publishes `httpServer` through a `provides` factory (`@arki/dot` plugin handles); docs show route bundles published from `provides`.
- 00519da: `fetchAllowedHosts()` in `@arki/http/public-fetch`: the env variable `FETCH_ALLOW_HOSTS` (comma-separated `host:port`) lists hosts the public-fetch guard lets through even at a private or loopback address, so an end-to-end test can fetch from a local fixture server. Any other private address is still refused, and it throws when `NODE_ENV=production`, so it can never open the guard in a deployment.

## 0.2.1

### Patch Changes

- @arki/dot@0.6.1

## 0.2.0

### Minor Changes

- 228b4f5: Features moved into Dot, and the app builder is now a hexagon. `@arki/feature` is merged into `@arki/dot/feature`: `defineFeature()` is now `feature()`, and `composeRouter`, `composeRepos` and the feature types come from `@arki/dot/feature`. `plug`, `plugs` and `tokens` are gone — the builder mounts features itself. `feature()` throws `FEATURE_E003` when `use` holds two slices with the same key (the second used to silently replace the first).

  Apps wire in three steps, checked at compile time: `.use(...)` for driven adapters (what features need), `.features([...])` once for the domain, then `.serve(...)` for driving adapters (what calls the features). `.use()` after `.features()` does not compile, a feature is not a plugin, and adapters declare their side: `driver(features => plugin(...))` is accepted only by `.serve()`, `driven(features => plugin(...))` only by `.use()`. Driven adapters read the features' declarations and boot before them; driving adapters get each feature's slice record with `sliceOf(ctx, f)`. Guard errors are plain sentences, and `dot explain --graph` draws the driven, features and driving groups numbered in boot order (`PluginManifest.role`).

  `@arki/http`: `http()` is a driver for `.serve()` and serves every bound feature's `routes` slice; the `features` option and `HttpFeatureToken` / `HttpFeatureNeeds` are removed. A malformed `routes` slice fails boot with `ARKI_HTTP_E010`.

  `@arki/journal`: the journal splits like the queue. `journal({ j, tables })` is a `driven(...)` adapter for `.use()`: it composes from every feature's `journalHandlers` declarations and boots before the features, so features can write through it. `journalWorker(opts?)` is a driver for `.serve()` that runs projections and effects, getting each feature's effect services from its slice. Inline projections only receive the transaction and the event, so writes never wait for feature services. `journal({ journal })` publishes an app-composed journal and no longer runs a worker; add `.serve(journalWorker())`. Core: `j.compose({ ..., services: 'worker' })` defers effect and tap services, which `journal.worker(db, { services })` and `journal.drain(db, { services })` supply per handler (`HandlerRef`, `HandlerServices`). Removed: the `features` option, the `worker`/`pollMs` options on `journal()`, and the `JournalHandlers` type.

### Patch Changes

- Updated dependencies [228b4f5]
- Updated dependencies [9fa13ce]
  - @arki/dot@0.6.0

## 0.1.0

### Minor Changes

- 0685dfa: Mistakes in declarations are now caught as early as possible: by TypeScript when the types can say it, otherwise by a coded error when the module loads.

  - `@arki/feature`: `composeRouter` and `composeRepos` reject a key claimed by two features at compile time. The runtime check stays as a backstop and now throws `FeatureError` with code `FEATURE_E001` (router) or `FEATURE_E002` (repo) and a `remediation`. Messages are unchanged.
  - `@arki/http`: mount paths for `rpcMount(...)` and `.mount(...)` are typed `MountPath` (`` `/${string}` ``), so a path without a leading `/` is a compile error. The runtime check stays.
  - `@arki/db`: the projection builder's two "call .named() / .on() first" errors are now `DbCompositionError` with codes `DB_COMPOSITION_E002` and `DB_COMPOSITION_E003`. `DbCompositionError` gains an optional `remediation`.
  - `@arki/dot`: when `dot explain` or `dot doctor` cannot import the app because a declaration threw a coded error, the output shows that error's code and its fix, not only "import failed".

### Patch Changes

- 4ef7b3e: Faster request handling for bound routes. Responses and error envelopes are unchanged.

  - A route with no derivers and no body now runs its handler without extra promises: a handler that returns a value is answered synchronously, and only a returned promise is awaited.
  - JSON output is written as a string body with `content-type: application/json`, the same response `Response.json` builds, at a lower cost per request.

- Updated dependencies [0685dfa]
- Updated dependencies
- Updated dependencies [2854df5]
  - @arki/dot@0.5.0
  - @arki/log@0.1.0

## 0.0.4

### Patch Changes

- New `@arki/http/public-fetch` subpath: `validatePublicURL`, `isPublicAddress`, `safeFetchBytes` — fetch that only reaches public unicast addresses (DNS-pinned via an undici Agent), with size and timeout caps. Adds `ipaddr.js` and `undici` dependencies. Dependency refresh: `hono` ^4.13.13, `@hono/node-server` ^2.1.4, `zod` 4.6.5; internal `@arki/log` pin updated.

## 0.0.3

### Patch Changes

- Docs-only: READMEs updated to the plugin() nomenclature (the pip → plugin rename shipped in @arki/dot 0.4.0); examples import from `@arki/dot/plugin`.

## 0.0.2

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
  - @arki/ts@0.0.3

## 0.0.1

### Patch Changes

- Initial public release of @arki/http — typed HTTP for ARKI.

  Route contracts as pure data (`route.get/.post/…/.sse`) with zod-validated
  query/body/output and typed path params; `routes()` bundles with
  request-scope deriver accumulation; SSE streaming (per-yield validation,
  coded error frames, signal-driven cleanup); fetch-shaped middleware;
  `toOpenApi` document generation; dual Bun/Node engine (Hono internal);
  and the DOT `http()` pip — bundle tokens as needs, ingress mounted last
  so it drains first on shutdown, coded `ARKI_HTTP_E*` diagnostics.

- Updated dependencies [4b1c59f]
  - @arki/dot@0.3.0
