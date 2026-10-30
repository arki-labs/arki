# @arki/ts

## 0.1.0

### Minor Changes

- 10661ce: `Lazy<T>` and `resolveLazy` move from `@arki/ts` to `@arki/dot/plugin` as `Deferred<T>` and `resolveDeferred`. They are the "value now, or a thunk the adapter calls at boot" shape that Dot adapters accept, and the old name clashed with Dot's own `Lazy<Value, Cleanup>` service handle. Behaviour is unchanged. `@arki/ts` no longer exports them; to upgrade, import `Deferred` and `resolveDeferred` from `@arki/dot/plugin`.

  `@arki/http` (`port`) and `@arki/kv` (`kv()`, `kv.optional()`) now type their deferred options as `Deferred<T>`, the same shape as before, and no longer depend on `@arki/ts`. `@arki/env` drops an `@arki/ts` dependency it never imported.

  demo impact: none (neither demo imports `Lazy` or `resolveLazy`).

### Patch Changes

- 49517e2: The build no longer compiles type tests (`*.test-d.ts`). They stay in `typecheck`, but a type test can no longer fail the build, and the published `dist` no longer holds compiled type tests.

  `@arki/db` exports the `OnDelete` type from `@arki/db/id` and `@arki/db/sqlite`. A package whose types come from `idColumns` (such as `@arki/auth`) can now build its declarations. Before, TypeScript could not name `OnDelete` and stopped with TS2883.

  `@arki/ai` drops a `@ts-expect-error` above the `@huggingface/transformers` import. That package is now always installed, so the comment had no error to hide and failed the build.

## 0.0.4

### Patch Changes

- abffdfd: Docs standard: README sections, `AGENTS.md`, `llms.txt`, an agent guide, `src/types.test-d.ts` with one `expectTypeOf` assertion per helper, and a runtimes table. no demo impact: documentation and doc-example changes only, runtime behaviour unchanged
- 0f148f1: Fix lazy-object enumeration and spreads over frozen instances and nonconfigurable properties. Reflection exposes configurable views while writes and deletes continue to obey the original instance.
- 846a013: `PathValue` is cheaper to type-check: it now follows the path it is given instead of listing every path of the object, and only falls back to the full `RecordToPath` list when that walk does not find the path (for example a key that contains a dot). It accepts the same paths and gives the same types as before. In the benchmark it now needs fewer type instantiations than ts-essentials `PathValue` (1,034 against 1,074; it was 2,731). `RecordToPath` drops a condition that was always true, which also makes it slightly cheaper (1,814 instantiations, was 1,872).
- 1668156: Adopts the shared library lint preset and adds a cross-runtime smoke test and `test:runtimes`. README documents runtime support.

## 0.0.3

### Patch Changes

- Lazy primitives family + client-surface hardening.

  - `@arki/ts`: new `once()` (zero-arg memo; memoizes `undefined`, sync throws retry, promises shared), hardened `lazyObject()` (`set`/`deleteProperty`/`getPrototypeOf` traps — writes land on the real instance, `instanceof` answers truthfully), new `Lazy<T>`/`resolveLazy` deferred-config vocabulary, and a `./testing` entry with `expectImportPure()` (subprocess import-purity harness).
  - `@arki/env`: `defineEnv` now delegates its lazy proxy to `lazyObject` (single trap implementation).
  - `@arki/kv`: `kv()` accepts a whole-options thunk — `kv(() => ({ url: env.REDIS_URL }))` — keeping declarations import-pure; per-field `url` thunk kept for compatibility.
  - `@arki/http`: `port` adopts `Lazy<number>`; documented why `bundles`/`features` tokens cannot defer (declaration-time wiring).
  - `@arki/contracts`: `browser` exports condition serves a zod-only build (no `drizzle-orm`) to client bundlers; table wrappers are node-only and fail loudly at bundle time from browser code.
  - `@arki/db` / `@arki/event-sourcing`: republished to align the `@arki/dot` peer range with 0.4.0.

## 0.0.2

### Patch Changes

- Ship TypeScript source in the npm tarball (`src/**` added to `files`). npm installs and the read-only GitHub mirrors now carry the original `.ts` source alongside compiled `dist/` — better debuggability on the experimental track. No runtime changes.

## 0.0.1

### Initial release

- First public publication on npm (experimental track) — 2026-05-21.

  Part of **Wave 1**, the ARKI foundation: zero-dependency utilities and runtime primitives shipped together because every downstream wave (DOT kernel, infrastructure adapters) consumes them. Wave 1 packages: `assert`, `clock`, `contracts`, `date`, `env`, `log`, `resilience`, `slugify`, `string`, `ts`.

  **Why 0.0.x, not 1.0.0**: ARKI is on an experimental track. The 0.0.x prefix is an honest signal — APIs may change without semver discipline until the kernel is field-tested. The release scorecard (metadata, privacy, dependencies, build-output, packlist, docs, fixtures, DOT gates, agent-native gates) is satisfied at this version; the gate certifies _the artifact_, not _API stability_. Stability is earned through reuse, not declared at first publication.

  Wave 2 (`@arki/dot`) and Wave 3 (`@arki/db`, `@arki/kv`, `@arki/event-sourcing`) publish in subsequent releases once their inter-package transitive resolution against the public npm registry is verified.
