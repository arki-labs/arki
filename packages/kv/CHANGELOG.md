# @arki/kv

## 0.3.0

### Minor Changes

- 3064b6a: Keep unresolved HTTP idempotency reservations until reconciliation and return precise canonical cache failures. Replay retention starts at confirmed persistence; all bounded responses, including error statuses, are stored. Oversized requests are refused before execution, and unreplayable responses retain their reservation.

  ResponseCache.begin no longer accepts a TTL; finish requires it. Postgres/Redis adapters confirm ownership and preserve unresolved claims; Journal pruning respects their lifecycle. Coordinate writer upgrades and reconcile legacy expiring reservations. See @arki/http/docs/upgrade-idempotency.md.

- 536d17d: Idempotency keys on HTTP and oRPC. `@arki/http/idempotency` adds `idempotent({ cache, scope, routes, ttl, ... })`, a middleware that runs a listed request once per `Idempotency-Key` and replays the stored response (status, body, allowlisted headers) on a repeat. `@arki/journal/http` stores responses on `journal_receipts`, and `@arki/kv/redis/idempotency` on Redis. `@arki/journal/orpc` adds `idempotent()`, which turns the header into receipt keys for every command of a procedure, and `journal.bind` takes `keyPerCommand`.

  Migration: `journal_receipts` gains three nullable columns, `owner`, `expires_at` and `response`. Run `drizzle-kit generate` and apply the migration before using `@arki/journal/http`. Existing command receipts are unchanged. New error codes `ARKI_HTTP_E410`, `E411`, `E412`.

- f2e9f69: Breaking: `defineEnv` now validates in every environment. `CI` and `lint` runs no longer skip validation. The only implicit opt-out is `SKIP_ENV_VALIDATION=1` (exactly `1`); set it only in build stages that run without secrets. `options.skipValidation` still overrides it. The `@arki/env/dot` plugin now validates at boot and fails with `ARKI_ENV_PLUGIN_E001` (new `ENV_PLUGIN_ERROR_CODES`), and `EnvServices['env']` is derived from `defineEnv` without a cast.

### Patch Changes

- 5e4c630: `transactions(handle)` takes the feature's database handle instead of a type argument: `transactions(database.provides.db)` replaces `transactions<Db>()`. The database and transaction types are read off the handle, and `.infra()` refuses a feature whose `db` need is another database's handle (compile error; `E026` at runtime). `db()` keeps its plugin name in the type (`Plugin<…, 'db'>`), `dbMigrations()` and `kv()` return what `plugin()` infers, so their handles carry `provider: 'db' | 'db-migrations' | 'kv'` instead of `string` and the feature builder's identity checks apply around them. Library plugins that need an app handle take it as a parameter, like `transactions(handle)`; a feature's own infra plugins may name handles directly in `needs` (the `arki-feature-layers/infra-runtime-imports` lint now allows the imports and bans only a plugin's own `feature.ts`, `usecases/` and `entrypoints/`).
- 2c0b668: Make failure the acyclic validation foundation. Schema parsing now returns exact typed validation failures, and failure revival returns typed protocol/validator defects instead of throwing. Add validated versioned JSON envelopes; retain legacy envelope reads while rejecting non-JSON data and changing output transforms. oRPC error maps validate output-only wire data.

  Migrate consumers to check failures, propagate them through Journal event/write/replay and queue/mail operations, and use explicit exception bridges at foreign callbacks. Journal rejects invalid event entries before inserting them. See `@arki/failure/docs/upgrade-typed-validation.md` for breaking API and stored-data migration details.

- 0c73d42: `kv.optional(options)` in `@arki/kv/dot`: the same plugin as `kv()` for apps where Redis is optional. With no URL it publishes `kv` as `null` and opens no client instead of failing boot; with a URL it opens the same client, and `dispose` closes it. The published type is `KV | null`. Both variants also take `probe: true` (with `probeTimeoutMs`, default 5000): a set/get/delete round trip at boot, so a bad or unreachable URL fails boot with `ARKI_KV_PLUGIN_E002` instead of the first request. `kv()` without `probe` behaves as before.
- 5bc6390: `kv()` publishes through a `provides` factory, so `cache.provides.kv` is a typed handle before boot (`@arki/dot` plugin handles).
- cbefc52: Dot plugins no longer pass a hard-coded `version` (the field was removed from `@arki/dot`).
- 953991a: Docs standard: new `AGENTS.md`, `llms.txt` and agent guide, a README in the standard section order with `Limits`, `Failure behaviour` and a compiled quick start, and `@fix` and `@verify` tags on every error code. The docs now ship in the package.

  no demo impact: documentation and doc-example changes only, runtime behaviour unchanged

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

## 0.2.1

### Patch Changes

- Updated dependencies [0e2ed57]
  - @arki/contracts@0.1.0
  - @arki/dot@0.6.1
  - @arki/env@0.0.11

## 0.2.0

### Minor Changes

- 9fa13ce: Dot plugin error codes join the `ARKI_` scheme: `KV_PLUGIN_E001` is now `ARKI_KV_PLUGIN_E001`, `DB_PLUGIN_E001` is `ARKI_DB_PLUGIN_E001` and `JOURNAL_PLUGIN_E001` is `ARKI_JOURNAL_PLUGIN_E001`. Code that matches on the old strings must update; the `*_PLUGIN_ERROR_CODES` constants carry the new values. The kv and db `docsUrl` slugs follow the codes. `@arki/dot` documents `ARKI_<PKG>_PLUGIN_E<NNN>` as the recommended prefix.

### Patch Changes

- Updated dependencies [228b4f5]
- Updated dependencies [9fa13ce]
  - @arki/dot@0.6.0
  - @arki/env@0.0.10

## 0.1.8

### Patch Changes

- 0fac2e0: `getRateLimiter(id, options)` finds its cached limiter faster. Limiters are now kept per id, and options that hold only plain values are compared field by field instead of being turned into JSON on every call. Which limiter you get back is unchanged: the same id and options that serialise to the same JSON still share one limiter.
- Updated dependencies [0685dfa]
- Updated dependencies
- Updated dependencies [91efd52]
- Updated dependencies [2854df5]
  - @arki/dot@0.5.0
  - @arki/env@0.0.9
  - @arki/log@0.1.0

## 0.1.7

### Patch Changes

- Dependency refresh: `ioredis` ^5.11.1, `rate-limiter-flexible` ^9.1.1, `@t3-oss/env-core` ^0.13.11, `zod` 4.6.5; internal `@arki/*` pins updated. No API changes.

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
  - @arki/ts@0.0.3
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

  **`@arki/kv`** is the key-value store adapter for the ARKI kernel — the Wave 3 infrastructure layer that plugs into `@arki/dot` via the pip-and-adapter contract. It provides:

  - **Pluggable backend** — embedded (in-memory + on-disk) or remote (Redis/Upstash) drivers
  - **DOT lifecycle integration** — registers as a `cache` pip, contributing to `DotAppManifest.cache` + `DotDiagnosticsSnapshot.cache`
  - **Typed key+value operations** — `get`, `set`, `delete`, `scan` with Zod-validated payloads

  **Why `0.1.x`, not `0.0.x`**: same rationale as `@arki/dot` — adapter layer, experimental but past first integration. `0.1.x` signals "kernel-tier component" without claiming API stability.

  **Dependencies** (all live on npm at `0.0.1`):

  - `@arki/contracts` `0.0.1`
  - `@arki/log` `0.0.1`

  **Peer dependencies**:

  - `@arki/dot` `^0.1.0`

  Ships together with `@arki/dot@0.1.0`, `@arki/db@0.1.0`, and `@arki/event-sourcing@0.1.0`.
