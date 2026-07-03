# @arki/dot

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
