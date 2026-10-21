# @arki/http

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
