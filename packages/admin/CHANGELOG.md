# @arki/admin

## 0.1.0

### Minor Changes

- d0c502a: One environment vocabulary: `prod`, `staging`, `dev`. The manifest `app.environment`, the audience (`novelette:prod`) and the receipts namespace now accept only these. `production`, `development` and `preview` are refused. New exports: `foremanEnvironmentSchema`, `ForemanEnvironment` (`@arki/admin/server`) and `foremanEnvironmentFromNodeEnv(nodeEnv, override?)` (`@arki/admin/env`), which maps `production` to `prod` and anything else to `dev`. New optional env var `FOREMAN_ENVIRONMENT` (in `foremanEnvShape`) overrides it, for staging. `createForemanHandlerFromEnv` and `foreman()` take `environment: ForemanEnvironment`. Migrate: use the helper, and rename audiences and receipt namespaces in your committed identities.
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
