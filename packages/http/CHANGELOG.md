# @arki/http

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
