# @arki/env

## 0.1.0

### Minor Changes

- 1e15576: `defineEnv()` `server`, `client` and `shared` take records of any Standard Schema (Zod, Valibot, ArkType, hand-written), not only `ZodType`; values are typed as each schema's output.
  `@arki/env/dot`: `EnvDotOptions`, `EnvServices` and `env()` take `Record<string, StandardSchemaV1>` instead of `Record<string, ZodType>`.
- 75d6fb9: **Validation now runs in production by default.** `defineEnv` used to skip validation whenever `NODE_ENV !== 'development'`, so an app without an explicit `skipValidation` booted production on an unchecked config. The default now skips only when `CI` is set (Docker build stages) or during `lint` runs, the same rule most apps already passed by hand. Apps that set `options.skipValidation` are unaffected.

  New `secret(schema)`, `reveal(value)` and `Redacted` (from `@arki/env/core`): a secret variable becomes a `Redacted` value that prints as `[redacted]` in logs, JSON, template strings and `util.inspect`, and is read with a deliberate `reveal(env.KEY)`. `reveal` also accepts the raw string, for runs where validation is skipped.

- cc7facf: Breaking: `defineEnv` now validates in every environment. `CI` and `lint` runs no longer skip validation. The only implicit opt-out is `SKIP_ENV_VALIDATION=1` (exactly `1`); set it only in build stages that run without secrets. `options.skipValidation` still overrides it. The `@arki/env/dot` plugin now validates at boot and fails with `ARKI_ENV_PLUGIN_E001` (new `ENV_PLUGIN_ERROR_CODES`), and `EnvServices['env']` is derived from `defineEnv` without a cast.
- a67cd66: `secret()` takes any Standard Schema (zod, valibot, arktype, hand-written) and returns a Standard Schema, not a zod schema. `.optional()` is still there: it accepts a missing variable and leaves `undefined` unwrapped. The result no longer has zod methods such as `.parse`; use `secret(schema)['~standard'].validate(value)`.

  A rejected secret's issues keep their path but get a fixed message, because some validators (valibot) repeat the received value in theirs and `defineEnv` logs issues.

### Patch Changes

- 064e096: Make failure the acyclic validation foundation. Schema parsing now returns exact typed validation failures, and failure revival returns typed protocol/validator defects instead of throwing. Add validated versioned JSON envelopes; retain legacy envelope reads while rejecting non-JSON data and changing output transforms. oRPC error maps validate output-only wire data.

  Migrate consumers to check failures, propagate them through Journal event/write/replay and queue/mail operations, and use explicit exception bridges at foreign callbacks. Journal rejects invalid event entries before inserting them. See `@arki/failure/docs/upgrade-typed-validation.md` for breaking API and stored-data migration details.

- 652eb4b: `env()`, `resilience()`, `auth()`, `journal()`, `journalProjections()`, `queue()`, `durableScheduler()` and `outboxPlugin()` keep their plugin name in the type, so their handles carry `provider: 'env' | 'resilience' | …` instead of `string` and the feature builder's handle-identity checks apply around them. The three queue plugins gain an overload: with no `name` option the type carries the default name (`'queue'`, `'durable-scheduler'`, `'outbox'`); with `name: 'jobs'` it carries `'jobs'`.
- cbefc52: Dot plugins no longer pass a hard-coded `version` (the field was removed from `@arki/dot`).
- 5bc6390: `env()` publishes through a `provides` factory, so `envPlugin.provides.env` is a typed handle before boot (`@arki/dot` plugin handles).
- fd18765: `defineEnv` reads `globalThis.process?.env` instead of the bare `process` global, so it no longer throws a ReferenceError on engines without `process` (React Native Hermes, browsers). It still reads nothing at import. Pass `runtimeEnv` on those engines. Added the library lint preset and a cross-runtime smoke test.
- fe5a391: README follows the docs standard (install, quick start, limits, failure behaviour), with `llms.txt`, an agent guide, `AGENTS.md`, `test:docs` and the 0.0.11 to 0.1.0 upgrade guide. `ARKI_ENV_PLUGIN_E001` gains `@fix` and `@verify` tags.

  no demo impact: documentation and doc-example changes only, runtime behaviour unchanged

- Updated dependencies [dcf2cef]
- Updated dependencies [afecc7a]
- Updated dependencies [5bc6390]
- Updated dependencies [899d0a9]
- Updated dependencies [ce8d707]
- Updated dependencies [92b38ed]
- Updated dependencies [9a4babb]
- Updated dependencies [80a4aa5]
- Updated dependencies [232d3e8]
- Updated dependencies [69d054f]
- Updated dependencies [cbefc52]
- Updated dependencies [7b19289]
- Updated dependencies [923124f]
- Updated dependencies [5721742]
- Updated dependencies [01400a0]
- Updated dependencies [0ab11d8]
- Updated dependencies [a531063]
- Updated dependencies [9b35520]
- Updated dependencies [5721742]
- Updated dependencies [232d3e8]
- Updated dependencies [9192d0e]
- Updated dependencies [3230f02]
- Updated dependencies [232d3e8]
- Updated dependencies [232d3e8]
- Updated dependencies [932c9e4]
- Updated dependencies [232d3e8]
- Updated dependencies [cc656e3]
- Updated dependencies [ff8e384]
- Updated dependencies [ce8d707]
- Updated dependencies [847f025]
- Updated dependencies [232d3e8]
- Updated dependencies [d9864f3]
- Updated dependencies [742f4c3]
- Updated dependencies [115aa87]
- Updated dependencies [6e4d7da]
- Updated dependencies [8b3cc80]
  - @arki/dot@0.7.0

## 0.0.11

### Patch Changes

- @arki/dot@0.6.1

## 0.0.10

### Patch Changes

- Updated dependencies [228b4f5]
- Updated dependencies [9fa13ce]
  - @arki/dot@0.6.0

## 0.0.9

### Patch Changes

- 91efd52: Reading a value from a `defineEnv()` env is faster once the env is in regular use. After 64 reads, an env whose values are private to it (validated on the server, or skipped with the runtime env `defineEnv` built itself) copies its values into the lazy object and reads them directly, instead of going through two proxies on every read. Writes and deletes through the env update the copy too. An env over your own `runtimeEnv` with validation skipped still reads it live.
- Updated dependencies [0685dfa]
- Updated dependencies
- Updated dependencies [2854df5]
  - @arki/dot@0.5.0

## 0.0.8

### Patch Changes

- Dependency refresh: `@t3-oss/env-core` ^0.13.11, `zod` 4.6.5. No API changes.

## 0.0.7

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

## 0.0.6

### Patch Changes

- Updated dependencies [4b1c59f]
  - @arki/dot@0.3.0

## 0.0.5

### Patch Changes

- Updated dependencies [48a8733]
  - @arki/dot@0.2.0

## 0.0.4

### Patch Changes

- Updated dependencies [9871fce]
  - @arki/dot@0.1.3

## 0.0.3

### Patch Changes

- Ship TypeScript source in the npm tarball (`src/**` added to `files`). npm installs and the read-only GitHub mirrors now carry the original `.ts` source alongside compiled `dist/` — better debuggability on the experimental track. No runtime changes.
- Updated dependencies
  - @arki/dot@0.1.2

## 0.0.2

### Patch Changes

- DOT v2 pip contract — typed dependency injection (BREAKING on the experimental track).

  `pip()` replaces `defineDotPip`: pips declare consumed services as `needs` shapes of type witnesses (`service<T>()` app-local, `token<T>()('key')` cross-package) and hooks destructure them fully typed; provides are inferred from `boot`'s return value. `.use()` is compile-time guarded (unsatisfied needs, type mismatches, wire-key collisions fail at the call site). Declaration order is boot order — the topological sort and name-based `dependencies` are gone; manifest dependency edges are observed from actual wiring. `rename(pip, map, name?)` is the multi-instance primitive, replacing the adapters' silent last-writer-wins `name` options. `lazy(init, { dispose? })` defers expensive opens behind a memoized single-flight `Lazy<T>` handle the kernel auto-disposes; `service.lazy<T>()` lifts eager or lazy providers into a uniform handle. The four `/dot` adapters (`@arki/env`, `@arki/kv`, `@arki/db`, `@arki/event-sourcing`) are migrated to the new contract.

- Updated dependencies
  - @arki/dot@0.1.1

## 0.0.1

### Initial release

- First public publication on npm (experimental track) — 2026-05-21.

  Part of **Wave 1**, the ARKI foundation: zero-dependency utilities and runtime primitives shipped together because every downstream wave (DOT kernel, infrastructure adapters) consumes them. Wave 1 packages: `assert`, `clock`, `contracts`, `date`, `env`, `log`, `resilience`, `slugify`, `string`, `ts`.

  **Why 0.0.x, not 1.0.0**: ARKI is on an experimental track. The 0.0.x prefix is an honest signal — APIs may change without semver discipline until the kernel is field-tested. The release scorecard (metadata, privacy, dependencies, build-output, packlist, docs, fixtures, DOT gates, agent-native gates) is satisfied at this version; the gate certifies _the artifact_, not _API stability_. Stability is earned through reuse, not declared at first publication.

  Wave 2 (`@arki/dot`) and Wave 3 (`@arki/db`, `@arki/kv`, `@arki/event-sourcing`) publish in subsequent releases once their inter-package transitive resolution against the public npm registry is verified.
