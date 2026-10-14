# @arki/dot

## 0.5.0

### Minor Changes

- `dot new my-app` now creates a full-stack app by default: TanStack Start, an oRPC API, Postgres through `@arki/db`, writes through `@arki/journal` commands, and `@arki/ui` with the workbench design system, all composed with `defineApp`. The app ships one example feature (`notes`), a first migration, `/api/health`, a `docker-compose.yml` for local Postgres, a production `Dockerfile`, tests on in-memory PGlite, and a README and AGENTS.md. It installs from npm alone. The old skeleton is still there with `--template minimal`; any other template name fails with `DOT_CLI_E005`. `dot --version` now prints the real package version.

- 2854df5: `@arki/log` is rebuilt. It has zero dependencies, runs on Node, Bun, Deno, browsers and React Native, and importing it does nothing: no env read, no output, no listener. Libraries log with `getLogger('arki:...')`; apps switch logging on once, in their entry file.

  **Apps must now switch logging on.** Until an app calls `configure()` (or mounts `log()` in a Dot app), only the first 64 records at `warn` and above are kept, and nothing else is written.

  ```ts
  import { configure } from '@arki/log';
  import { asyncContext, fromEnv, stdout } from '@arki/log/node';

  configure({
    ...fromEnv(), // LOG_LEVEL, DEBUG=arki:kv:*
    context: asyncContext(),
    channels: { stdout: stdout() },
    default: { level: 'info', channels: ['stdout'] },
  });
  ```

  A Dot app does the same as its first `.use(...)`:

  ```ts
  import { log } from '@arki/dot/log';

  defineApp('checkout').use(
    log(() => ({
      ...fromEnv(),
      context: asyncContext(),
      channels: { stdout: stdout() },
      default: { level: 'info', channels: ['stdout'] },
    })),
  );
  ```

  How to migrate a call site:

  | Before                               | After                                                                                 |
  | ------------------------------------ | ------------------------------------------------------------------------------------- |
  | `createLogger('x')`                  | `getLogger('x')`                                                                      |
  | `createLogger('x', attrs)`           | `getLogger('x').with(attrs)`                                                          |
  | `new Logger(name, attrs)`            | `getLogger(name).with(attrs)`                                                         |
  | `.withAttribute(k, v)`               | `.with({ [k]: v })`                                                                   |
  | `.child(name, attrs)`                | `.child(name).with(attrs)`                                                            |
  | `log.info('text', attrs)`            | unchanged (the text is now a template; `{name}` reads a field)                        |
  | `log.info({ ...object })`            | `log.emit({ level: 'info', eventName: '<category>.<what>', body: {...} })`            |
  | `log.warn(err)`                      | `log.warn('<what failed>', { error: err })`                                           |
  | `debug('ns')` from `@arki/log/debug` | `getLogger('ns')`, then `.debug('text {field}', { field })` instead of `%s` arguments |
  | `Attributes`, `Body` types           | `Fields`; a `Body` caller uses a string or `emit`                                     |

  Removed: `@arki/log/debug`, `@arki/log/core` (now `@arki/log` itself), the `Logger` class, `rootLogger`, `createLogger`, `configuration`, batching, the Google Cloud formatter, and the `pino` and `debug` dependencies. `DEBUG=arki:*` still works through `fromEnv()`.

  New entry points: `@arki/log/node` (`stdout`, `stderr`, `file`, `fromEnv`, `asyncContext`), `@arki/log/otel` (`otelTrace`, `otelSink`; the `@opentelemetry/*` packages are optional peers) and `@arki/log/testing` (`fakeLog`).

  `@arki/dot`: plugins can fill a new logging slot (`plugin({ logging: ({ appName }) => handle })`). The kernel switches logging on before its first lifecycle record and closes it after its last one, also when boot fails. Two logging plugins in one app is `DOT_LIFECYCLE_E018`. `@arki/dot/log` exports `log()`, which fills the slot, names the service after the app and publishes the handle as the `logging` service. Hook spans now stamp their trace on log records through `@arki/log`, and importing `@arki/dot` reads no env and writes nothing.

### Patch Changes

- 0685dfa: Mistakes in declarations are now caught as early as possible: by TypeScript when the types can say it, otherwise by a coded error when the module loads.

  - `@arki/feature`: `composeRouter` and `composeRepos` reject a key claimed by two features at compile time. The runtime check stays as a backstop and now throws `FeatureError` with code `FEATURE_E001` (router) or `FEATURE_E002` (repo) and a `remediation`. Messages are unchanged.
  - `@arki/http`: mount paths for `rpcMount(...)` and `.mount(...)` are typed `MountPath` (`` `/${string}` ``), so a path without a leading `/` is a compile error. The runtime check stays.
  - `@arki/db`: the projection builder's two "call .named() / .on() first" errors are now `DbCompositionError` with codes `DB_COMPOSITION_E002` and `DB_COMPOSITION_E003`. `DbCompositionError` gains an optional `remediation`.
  - `@arki/dot`: when `dot explain` or `dot doctor` cannot import the app because a declaration threw a coded error, the output shows that error's code and its fix, not only "import failed".

- Fix: `import '@arki/dot'` failed under Node with "Unknown file extension .ts". The `import` condition of the root, `/cli`, `/log` and `/test-harness` entries pointed at the TypeScript source in `src/`. They now point at the compiled `dist/*.js`, like every other `@arki/*` server package.
- Updated dependencies [2854df5]
  - @arki/log@0.1.0

## 0.4.1

### Patch Changes

- Dependency refresh: `@opentelemetry/api` ^1.9.1, `zod` 4.6.5; internal `@arki/assert`, `@arki/contracts`, `@arki/log` pins updated. No API changes.

## 0.4.0

### Minor Changes

- BREAKING: the composition unit is renamed pip → plugin across the kernel.

  - `pip()` → `plugin()`, `Pip<>` → `Plugin<>`, `initPips` → `initPlugins`, `testPip` → `testPlugin`, `PipManifest` → `PluginManifest`, `DotPipError` → `DotPluginError`, `*_PIP_E*` error codes → `*_PLUGIN_E*`.
  - Subpath export `@arki/dot/pip` → `@arki/dot/plugin`.
  - CLI/OTel identifiers follow (`dot.plugin.*` spans, PLUGIN columns).
  - Docs: composition doctrine (`docs/composition-doctrine.md`) — inert declarations, one-way dependencies, lazy singletons, deferred adapter config, client-surface rules, import-purity + browser-purity enforcement.

  Migrate with a find/replace of the symbol names; runtime semantics are unchanged.

### Patch Changes

- Updated dependencies
  - @arki/contracts@0.0.3

## 0.3.0

### Minor Changes

- 4b1c59f: Route manifest metadata + `dot explain --openapi`. `registerRoute` accepts
  optional `description`, `input` (per-location JSON Schemas: `query`/`body`),
  `output`, and `streaming` fields that flow into `manifest.routes` untouched
  — adapters convert their validation schemas at `configure` time so the
  manifest stays plain serializable data. `dot explain --openapi` renders an
  OpenAPI 3.1 document straight from the static manifest (no boot): path
  params, query parameters with required flags, JSON request/response bodies,
  and `text/event-stream` responses for streaming routes. Mutually exclusive
  with `--graph`; explain-only; composes with `--json`. Built for
  `@arki/http`'s `registerRoutes`, usable by any adapter.

  Also fixes a provides-inference hole: a `boot` that returns `void` gave
  `TProvides` no inference candidate, so TypeScript substituted the
  constraint (`ServiceRecord`, whose `keyof` is `string`) instead of the
  declared `EmptyShape` default — poisoning the app builder's collision
  check for every later `.use()`. `pip()` now normalizes the fallback
  (`InferredProvides`): a void-booting pip provides nothing, as documented.

## 0.2.0

### Minor Changes — testing, operations, introspection (48a8733)

- **`testPip` — typed unit-test builder.** Satisfy a pip's needs directly
  with fakes; every `.provide()` is compile-checked (token or anonymous
  key form) and `boot()` refuses to compile while needs remain unprovided.
  Runs the real kernel underneath, so teardown order, lazy lifting, and
  `$config` behave as in production. Exported from the package root and
  `@arki/dot/test-harness` alongside the existing erased `testApp`.
- **`hookSignals(app)` — graceful-shutdown wiring.** First SIGTERM/SIGINT
  drains via `dispose()` (bounded by `timeoutMs`, default 10 s) and
  re-raises the signal for standard exit semantics; a second signal falls
  through to the runtime default. Returns an unhook function; the process
  target is injectable for tests.
- **`hookTimeoutMs` watchdog (`DOT_LIFECYCLE_E015`).**
  `defineApp(name, { hookTimeoutMs })` bounds every async hook invocation;
  a hook exceeding the budget fails with E015 naming the pip and hook, and
  the kernel applies its normal boot-rollback / start-cascade / teardown-
  aggregation rules. Off by default.
- **`dot explain --graph` / `dot doctor --graph`.** Renders the pip graph
  as Mermaid flowchart source — declaration-ordered nodes, observed
  dependency edges (doctor boots; explain shows boot order). Composes
  with `--json` (`data.source`).

## 0.1.4

### Patch Changes

- Docs-only release: README rewritten around the v2 dependency-injection model — needs-as-witnesses with inferred provides, the compile-time wiring guard, tokens (`token`/`provide`/`Token.instance`), multi-instance `rename()`, lazy services (`lazy`/`service.lazy`), the reserved `$` kernel namespace, a 12-pip commerce-platform walkthrough, and the E011–E014 runtime error-code table. No runtime changes.

## 0.1.3

### Kernel hardening (external review findings) — 9871fce

- **Lifecycle transitions are serialized.** `boot()` / `start()` / `stop()` /
  `dispose()` now run on a single transition queue: concurrent calls to the
  same transition coalesce onto one in-flight promise (hooks never
  double-run — this previously held for boot/stop/dispose but not `start`),
  and calls to _different_ transitions wait their turn and re-check state at
  the head of the queue. Previously a `dispose()` completing while `start()`
  awaited a hook could be overwritten by the resuming start — the app ended
  `started` after being disposed.
- **Lazy auto-dispose tracks ownership.** A `Lazy<T>` handle republished by
  a downstream pip (identity pass-through via `service.lazy`) is now cleaned
  up only by its _first_ publisher, after that pip's own `dispose` hook.
  Previously the republisher's record — disposed earlier under reverse
  order — closed the handle out from under the provider's dispose hook.
- **`$`-prefixed service keys are enforced as reserved**
  (`DOT_LIFECYCLE_E014`). `pip()` now rejects `$`-prefixed needs aliases and
  publish keys at compile time (constraint-level — no new unsafe casts), and
  the kernel validates aliases, publish keys, and `rename()` targets at
  runtime, so `$app` / `$pip` / `$config` can never be shadowed. Docs
  previously claimed this; now the kernel guarantees it.

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
