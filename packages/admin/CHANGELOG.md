# @arki/admin

## 0.2.0

### Minor Changes

- 8944628: Expected outcomes of the signed protocol and the Coolify API are returned `@arki/failure` failures, not thrown `AdminError`s. `createForemanClient` calls (`negotiate`, `manifest`, `read`, `preview`, `execute`), `createCoolifyClient`, `createCoolifyEnvWriter`, `confirmHint` and `parseWebhookHint` return the value or an `Admin*` failure (see the Failures section of the README); the dispatcher builds its wire answers from the same failures and keeps the stable `ARKI_ADMIN_E0NN` wire codes. `fetchFleetSnapshot` returns `{ ok: false, failure }` instead of `{ ok: false, error: string }`. `createFleetHandler` no longer puts the provider's error message or the schema issues on the wire: `502 { error: "snapshot_failed" }` and `500 { error: "invalid_snapshot" }`. `AdminError` is thrown for bugs only. Docs: README updated.

### Patch Changes

- 17e86d3: Breaking: the object-form feature API is removed. Write every feature as a `defineFeature(name).needs().infra().usecases().provides().entrypoints()` chain.

  - `@arki/dot`: removed `feature()`, `plug`, `composeRouter`, `composeRepos`, `tokenOf`, `entrypointsOf` and the types `AnyFeature`, `MountedFeature`, `UnitOf`, `MountedUnitsOf`, `FeatureConfig`, `ComposedRouter`, `ComposedRepos`. `defineApp().features()` takes chain features only. Use `routerFor(rpcContract, features)` instead of `composeRouter`, and a feature's own `repos({...})` store instead of `composeRepos`. Read `f.entrypoints` instead of `entrypointsOf(f)`. Lifecycle hooks (`boot`, `start`, `stop`) live on an infra unit inside the feature.
  - `@arki/http`: removed `endpoints(build)` and `EndpointsFeatureSlice` from the root export. Use `endpoints(core, build, { contracts })` from `@arki/http/dot` in `.entrypoints()`.
  - `@arki/schedule`: removed the `schedules(needs, defs)` overload. Use `schedules(core, defs)` in `.entrypoints()`.
  - `@arki/queue`, `@arki/journal`, `@arki/admin`: dropped their object-form branches. The chain API is unchanged.

- f2ba7ac: Add `createForemanRoute` (`./server`), the one mount for `/api/foreman/*`. It builds the handler on the
  first request, takes one store for both nonces and receipts, and namespaces the receipts by the app's
  audience. With no store it answers 404 while the keys are unset and throws `ARKI_ADMIN_E014` once they
  are set. Also add `memoryForemanStore` for single-instance apps, and a new `./pg` entry with
  `foremanStoreTable` and `pgForemanStore`: a Postgres store for apps without a KV (`drizzle-orm` is an
  optional peer).

  no demo impact: no demo mounts Foreman.

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

- 23e9f49: `createCoolifyEnvWriter` writes environment variables to a Coolify application, runtime-only, literal and outside previews, with `secret` entries shown once. It stores a probe variable first and checks Coolify kept it runtime-only, so a Coolify that would store a key build-time never receives a real value. It never reads values back or puts a body in an error or a log line. Docs: the Coolify connection README has an "Env writer" section. No demo impact: the Coolify connection has no demo.
- 5d55e12: The `fetch` option of `createForemanClient` and `fetchFleetSnapshot` now takes a plain `(url, init) => Promise<Response>` instead of `typeof fetch`. Where Bun's types are loaded, even through a dependency, `typeof fetch` also requires `fetch.preconnect`, so a wrapper around fetch did not compile. The global `fetch` still fits. No docs impact: the option is not documented beyond its JSDoc. No demo impact: no demo overrides fetch.
- 23e153b: The Coolify env writer deletes the preview copies Coolify makes of every new variable, so a production key never reaches PR previews unhidden, and the probe leaves nothing behind. `removePreviewCopies(applicationUuid, keys)` cleans variables written before. Docs: the Coolify connection README explains why. No demo impact: the Coolify connection has no demo.
- 7711722: New `@arki/admin/panels` entry: the answer shapes of two generic panels Foreman bundles. `arki.board` draws number cards with a tone (`boardOutputSchema`); `arki.rows` draws a table whose panel actions become row buttons (`rowsOutputSchema`). `PANEL_RENDERER` names both renderer ids. Docs: README "Generic panels". No demo impact: the admin package has no demo.
- 5d55e12: Docs only: README sections follow the library layout, and the package now ships `llms.txt`, an agent guide, `AGENTS.md` and a `LICENSE`. No code change.
- 43bef40: The Coolify client reads projects and their environments (`listProjects`, `listEnvironments`), so a caller can name an application's project from its `environment_id`. Applications now also carry `environment_id`, `base_directory`, `dockerfile_location`, `docker_compose_location` and `watch_paths`. No docs impact beyond the Coolify connection README. No demo impact: the Coolify connection has no demo.
- Updated dependencies [5d55e12]
- Updated dependencies [a905468]
- Updated dependencies [c36e614]
- Updated dependencies [b992897]
- Updated dependencies [440c75f]
- Updated dependencies [c3e63ba]
- Updated dependencies [e132ad3]
- Updated dependencies [1e47612]
- Updated dependencies [49517e2]
- Updated dependencies [8944628]
- Updated dependencies [88daaeb]
- Updated dependencies [36b4da8]
- Updated dependencies [5d55e12]
- Updated dependencies [1a897f8]
- Updated dependencies [e80211d]
- Updated dependencies [17e86d3]
  - @arki/http@0.4.0

## 0.1.0

### Minor Changes

- d0c502a: One environment vocabulary: `prod`, `staging`, `dev`. The manifest `app.environment`, the audience (`pizzeria:prod`) and the receipts namespace now accept only these. `production`, `development` and `preview` are refused. New exports: `foremanEnvironmentSchema`, `ForemanEnvironment` (`@arki/admin/server`) and `foremanEnvironmentFromNodeEnv(nodeEnv, override?)` (`@arki/admin/env`), which maps `production` to `prod` and anything else to `dev`. New optional env var `FOREMAN_ENVIRONMENT` (in `foremanEnvShape`) overrides it, for staging. `createForemanHandlerFromEnv` and `foreman()` take `environment: ForemanEnvironment`. Migrate: use the helper, and rename audiences and receipt namespaces in your committed identities.
- 481a2a7: Execution receipts. Every execute now claims the permit's `executionId` in a `ReceiptStore` before the action runs and settles the receipt (`applied` with the result and its `sha256:` hash, or `failed` with the wire-safe error) before the response is sent. A repeated execute with the same id never runs the action again: it answers from the receipt, or `ARKI_ADMIN_E018` while the receipt is still `pending`; the same id on another action is refused (`E010`). The new `core.receipts` module serves `core.receipts.get({ executionId })` (scope `core:read`) so Foreman can settle a lost answer; `withCoreModules`, `createForemanHandlerFromEnv` and `foreman()` add it when given `receipts`. Two stores: `kvReceiptStore(kv, { namespace })` on `@arki/kv` (the namespace is the app's audience, `slug:environment`, and is part of every key so apps sharing one KV stay apart) (`@arki/admin/receipts`, also re-exported from `./server`; TTL 30 days by default, never below Foreman's 5-minute receipt window) and `journalReceiptStore(...)` + `foremanReceiptTables()` on `@arki/journal` (import them from `@arki/journal/foreman`; `@arki/admin` is an optional peer of `@arki/journal`).

  Breaking: with `writes: 'on'` and no `receipts`, every execute is now refused with the new `ARKI_ADMIN_E017` (fail closed); a store that cannot take the claim is refused the same way, before the action runs. `ForemanEnv` now matches what `foremanEnvShape` parses to (every key optional), so an app passes its validated env as is.

- 232d3e8: A route contract now describes the whole request and response. `route.*()` takes `params` (a zod object with one key per path placeholder), `headers` (lower-case names; only the declared names are read) and `responses` (status to body schema). A handler answers a listed status with `reply(status, body, { headers? })`. An optional last path segment (`/orders/:id?`) serves both paths and appears twice in OpenAPI. `route.sse` takes `params` and `headers` too. The client sends typed params and headers, drops a missing optional segment, and decodes a body by `responses[status]` before `output`.

  New exports: `raw`, `reply`, and the types `RawOutput`, `Reply`, `RouteDef`, `SseDef`, `ResponseSchemas`, `ParamSchema`, `HeaderSchema`.

  Breaking changes:

  - `RouteContract` and `SseContract` take `<TPath, TDef>` (the literal def) instead of positional `TQuery, TBody, TOutput, TFailures`. `RouteInput`, `RouteHandler`, `SseHandler` and `HandlerResult` follow. `ParamsOf` marks an optional placeholder's key optional.
  - A contract with no `output` now answers 204 with an empty body, and its handler returns nothing. It used to return a `Response`. Manifests regenerate from code, so `action-meta` stays `@1`; its meaning changes from 200 to 204.
  - Returning a `Response` needs `output: raw()`. Without it the engine answers 500 `ARKI_HTTP_E510`, and a plain value from a `raw()` route is `E510` too. The engine never validates a raw `Response`. `responses` may still document it (`x-arki-raw: true` in OpenAPI).
  - A result that does not fit the contract (undeclared `reply` status, a value on a no-output route) answers 500 `ARKI_HTTP_E511`.
  - An inconsistent contract throws `HttpConfigError` `ARKI_HTTP_E011` from `route.*()` (params not matching the path, bad optional placeholder, upper-case header, `responses` key outside 200-599 or 204/304, `responses[200]` next to a schema `output`).
  - OpenAPI describes the wire form (`io: 'input'`), lists every declared status, and `createClient` resolves `undefined` for a no-output route and the `Response` for `raw()`.

  `@arki/admin`: the four Foreman routes and the fleet snapshot route declare `output: raw()`. The fleet route documents its payload with `responses: { 200: fleetSnapshotSchema }`.

- d80a024: A module can declare its own errors. `moduleError(code, status, message, remediation)`, `ModuleError` and `isModuleError` (from `@arki/admin/module`) build a coded 4xx refusal. The dispatcher answers it with the module's own status and code, the client reads them back, and a failed receipt keeps them, so admin never learns a module's concepts. A status outside 400 to 499 is `ARKI_ADMIN_E014`. `redactSecrets` now lives in `@arki/admin/module` (it moved from `@arki/queue/foreman`).

  Breaking (0.x): the wire error `code` and the receipt `code` are now strings (an admin code or a module's own), no longer a closed list. The `./pg` entry is removed, with the `@arki/journal` and `drizzle-orm` dependencies: `journalReceiptStore` and `foremanReceiptTables` are now exported from `@arki/journal/foreman`.

- a727e0b: Foreman protocol 2. `@arki/admin/server` adds `createForemanHandler`: Ed25519-signed envelopes (`aud`, `iat`, nonce, method, path, body hash, scopes, and a permit with the pinned `schemaHash` on executes), separate read and execute key rings with `*_NEXT` rotation overlap, a 60 s clock-skew window, replay protection through any `NonceStore` (an `@arki/kv` `KV` fits), scope checks, and an explicit `writes: 'off'` that refuses every execute. Every response carries a proof signed by the app's identity key. The new `@arki/admin/client` entry adds `createForemanClient` (signs calls, verifies each response proves the expected target, negotiates protocol 1 or 2), `signRequest` and `generateForemanKeyPair`. Protocol 1 (`/api/fleet`) is unchanged. New error codes `ARKI_ADMIN_E007`–`E016`.
- 9caea7e: `defineRead`, `defineAction`, `defineSignal` (and the `Read`, `Action`, `Signal`, `AnyRead`, `AnyAction` types) take any Standard Schema (Zod, Valibot, ArkType, hand-written) instead of `z.ZodType`; the preview schema bound is `StandardSchemaV1<unknown, Revisioned>`. Handler types use `SchemaInput`/`SchemaOutput`.
  Input and output are validated with `parseAsync`; bad data is still `ARKI_ADMIN_E004`/`E005`, now with `SchemaError` as the cause. A validator that throws propagates as `SchemaRunError`.
  The manifest JSON Schema comes from the schema's own converter (`input` for inputs, `output` for results and payloads). A schema without one, or whose conversion throws, fails at define time naming the read/action id and `withJsonSchema`.
  `journalReceiptStore` takes a `Meta` of any Standard Schema with a record output.
- 232d3e8: Add nominal domain kinds to `defineId(prefix, { kind })`, preserving canonical
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

- a727e0b: New `@arki/admin/connections/coolify` entry: a read-only Coolify connection. `createCoolifyClient` is a typed, timeout-bound client (injected `fetch`, explicit base URL and token) with Zod-checked reads for applications, deployments, servers and the installed Coolify version (`probeVersion`). Webhooks are hints: `parseWebhookHint` extracts a hint, `confirmHint` re-reads the Coolify API and only that result becomes a `CoolifySignal` shaped for Foreman's `signals` table. An unverified or spoofed webhook yields no signal.
- a727e0b: Core modules and two ways to attach Foreman. `@arki/admin/core` adds `withCoreModules`: `core.health` (status and checks in the v1 `fleetHealthSchema` shape) and `core.manifest` (the same manifest `GET /api/foreman/manifest` serves). `@arki/admin/env` adds `foremanEnvShape` and `foremanConfigFromEnv`: Foreman v2 is off with no `FOREMAN_*` variables set, and a partial set throws `ARKI_ADMIN_E014`. `@arki/admin/server` adds `createForemanHandlerFromEnv` for plain TanStack apps (a `routes/api/foreman/$.ts` catch-all). `@arki/admin/dot` adds `foreman()`, a `defineFeature` slice for DOT apps. Both attachments give identical manifests and read results.
- a727e0b: New `@arki/admin/module` entry: the isomorphic Foreman module contract. `defineRead`, `defineAction` (preview with a `revision`, execute under a `Permit`), `defineSignal` and `defineModule` describe what operators may see and do once; `describeModule` turns a module into JSON Schemas with a `schemaHash` per read, action and signal (Web Crypto, every runtime); `toDotAction()` puts each capability in the DOT manifest with `binding: 'foreman'`. Failures are `AdminError`s with stable `ARKI_ADMIN_E00x` codes. The package now uses the library lint preset; `./server` stays the Node-only adapter.

### Patch Changes

- dab8eb9: Security: a repeated execute answers from its receipt only when it is the same signed request. Receipts now store `requestHash`, the SHA-256 over the canonical JSON of the envelope's audience, method, path, body hash and permit. Before, only the action id was compared, so the same execution id with other input or another pinned revision was answered "applied" with the first result, though it never ran. A mismatch is refused with `ARKI_ADMIN_E010`. Receipts written before this field are still matched by action id, so an execution that spans the upgrade is not sent back for a second approval.
- 232d3e8: Document actionable fixes and verification commands for canonical error definitions.

  Journal command/workflow failures and Embeddings failures also expose the missing runtime remediation guidance. Existing failure codes, data and inferred unions are unchanged.

- 232d3e8: Make failure the acyclic validation foundation. Schema parsing now returns exact typed validation failures, and failure revival returns typed protocol/validator defects instead of throwing. Add validated versioned JSON envelopes; retain legacy envelope reads while rejecting non-JSON data and changing output transforms. oRPC error maps validate output-only wire data.

  Migrate consumers to check failures, propagate them through Journal event/write/replay and queue/mail operations, and use explicit exception bridges at foreign callbacks. Journal rejects invalid event entries before inserting them. See `@arki/failure/docs/upgrade-typed-validation.md` for breaking API and stored-data migration details.

- be345ee: The signed Foreman client and `fetchFleetSnapshot` no longer follow redirects. They send `redirect: 'manual'` and treat any 3xx answer as a failure (`ARKI_ADMIN_E016` for the client, `{ ok: false }` for `fetchFleetSnapshot`), so a target cannot bounce Foreman to an internal URL.
- Updated dependencies [cbefc52]
- Updated dependencies [5d05b9c]
- Updated dependencies [8e55924]
- Updated dependencies [ddcc363]
- Updated dependencies [47d296b]
- Updated dependencies [f56ab9f]
- Updated dependencies [232d3e8]
- Updated dependencies [3064b6a]
- Updated dependencies [af3d5a1]
- Updated dependencies [28cd943]
- Updated dependencies [932c9e4]
- Updated dependencies [966efcd]
- Updated dependencies [953991a]
- Updated dependencies [f6a15d0]
- Updated dependencies [2c0b668]
- Updated dependencies [49a339e]
- Updated dependencies [536d17d]
- Updated dependencies [d11c9fb]
- Updated dependencies [ee69f29]
- Updated dependencies [b9d0a86]
- Updated dependencies [fce3e8c]
- Updated dependencies [a1d4ee6]
- Updated dependencies [5bc6390]
- Updated dependencies [00519da]
  - @arki/http@0.3.0

## 0.0.2

### Patch Changes

- Updated dependencies
  - @arki/contracts@0.0.2
