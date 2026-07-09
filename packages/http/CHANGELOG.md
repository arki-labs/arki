# @arki/http

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
