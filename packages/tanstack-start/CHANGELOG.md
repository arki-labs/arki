# @arki/tanstack-start

## 0.2.0

### Minor Changes

- e132ad3: `@arki/tanstack-start/dot` adds `tanstackStart()`, the TanStack Start entrypoint of a Dot app. It takes typed `needs`, a `session` and an `rpc` function, and declares the `rpc`, `auth`, `cron` and `health` mounts at their `at` paths, so `dot explain` lists them. `rpcHandlers()`, `authHandlers()`, `cronHandlers()` and `healthHandlers()` make each mount a one-line server route. `startServer(app, { hot, eager, handler })` from `@arki/tanstack-start/server` owns the app runtime and hands every Start request a typed context (`services`, `rpc`, `session()`, `requestId`, `signal`); type it once with `RequestContextOf<typeof app>` in a `Register` augmentation of `@tanstack/react-start`.

  Breaking: `createServerHandler` is removed; use `startServer`. The cron mount's `secret` and the `cors` option are functions read at boot (`secret: () => env.CRON_SECRET`), so `vite build` runs without the server env; a bad value stops the boot with `ARKI_TANSTACK_START_PLUGIN_E001` (cron secret) or `ARKI_TANSTACK_START_PLUGIN_E002` (CORS).

  `@arki/dot`: `createAppRuntime(app, { eager: true })` starts the app when the runtime is created, so a production server boots before its first request.

- a900ccc: `@arki/tanstack-start/vite` gains three build-time helpers: `reactCompiler()` runs the React Compiler on every component and hook (Babel plugin through `@rolldown/plugin-babel`); `zodCompiled()` makes every Zod schema the server constructs parse through a compiled validator by loading `zod/compile` first in the server bundle; `oneChunkPerRoute` is the `codeSplittingOptions` that keeps a route's loader in the route's own chunk instead of the entry.
- 2ef7e3a: Breaking: `reactCompiler()` is removed from `@arki/tanstack-start/vite`, with its Babel dependencies (`@babel/core`, `@rolldown/plugin-babel`, `babel-plugin-react-compiler`). Use `@vitejs/plugin-react`'s own option instead: `viteReact({ compiler: true })`, which runs the Rust React Compiler (`oxc-transform-react`; add it as a dev dependency of the app). It is much cheaper at build time than the Babel plugin, and it has to live in `viteReact()` because it replaces that plugin's JSX and Fast Refresh step.
- Breaking: the root entry `@arki/tanstack-start` no longer re-exports `RootErrorComponent` and `DevTools`, so it imports in plain Node. Import them from `@arki/tanstack-start/error` and `@arki/tanstack-start/devtools`. `./error`, `./devtools` and `./pwa/sw` are listed in `arki.bundlerOnly`; the release smoke checks them with a Vite build.

### Patch Changes

- Every entry now ships compiled JavaScript from `dist/` instead of TypeScript source, so the server entries import in plain Node. `./pwa/client` loads `virtual:pwa-register` inside `registerPwa()`, and `./pwa/sw` precaches only inside a service worker, so both import outside Vite without throwing.
- 5a20a58: `@arki/tanstack-start/pwa/client` adds `clearCachesOnUserChange(userId)` and `useClearCachesOnUserChange(userId)`. They delete the service worker's user-tied caches (every cache but the Workbox precache of built files) when the signed-in user differs from the one the caches were filled for: a sign-out, a deleted account, or a new session that replaced another user's. Who filled the caches is one Cache Storage entry holding only the user id. `clearCachesOnUserChange` resolves `true` when the caches belonged to another known user, so the app can drop that user's other offline data (such as a persisted query cache) on the same decision; pass `undefined` to the hook while the session is loading or failed to load, so an offline reload never reads as a sign-out.
- a07bccc: Remove the retired Clock abort exception code; cancellation remains the canonical SleepCancelled value. Preserve prototype-shaped operation keys in TanStack client utilities, and run Contracts native/provider inspections through identity-preserving source schemas. Forged array methods no longer bypass operation identity validation.

  Docs describe the retired code and identity guarantees. No demo impact: existing demos use live cancellation outcomes and ordinary operation keys.

- b1a89bf: `fleetVite()` stops a missing `/assets/*` file from being cached as a 404 for a year.

  Nitro serves `/assets` as part of the root public folder, so a missing chunk fell through to the app's not-found page, and that page kept Nitro's `public, max-age=31536000, immutable` header. A CDN then kept the 404 for a year. One deploy swap was enough to break every page's JS.

  `fleetVite()` now registers `/assets` as its own Nitro public-asset folder that does not fall through. A missing file gets Nitro's plain 404 with no `Cache-Control`. Production builds only. `nitro` is a new optional peer dependency (types only).

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

- fcd8e65: `<DevTools />` now contains a failed load of its lazy panel. When the devtools chunk cannot be fetched (a proxy cut a large dependency short, a stale Vite optimize hash), it renders nothing and logs a warning on `arki:tanstack-start`. Before, the rejected `import()` reached the root route and the whole page stopped rendering.

  no docs impact: behaviour fix, no API change.
  no demo impact: dev-only component.

- 8bc688e: New `withForwardedProto(request)` on `@arki/tanstack-start/server`. Behind a TLS proxy (`X-Forwarded-Proto: https`), it rebuilds GET and HEAD requests with an `https:` URL, so a locale redirect built from `request.url` (Paraglide's `/` → `/ro`) keeps the browser on HTTPS. Other requests come back unchanged.

  no demo impact: server-entry helper with no demo surface.

- ff85471: Go to Definition works on mapped keys again. Handle maps (`unit.provides.x`, feature handles), `PolicyTree`, `SessionValues`, `CronPolicy.respond`, `ChartConfig.theme`, `Operations` and the oRPC utils tree now map `[K in keyof T as K & string]` instead of `[K in keyof T & string]`. The old form cut the link from each key back to its declaration, so the editor found no definition. Types are otherwise unchanged.
- 5d55e12: Docs only: README sections follow the library layout, and the package now ships `llms.txt`, an agent guide and `AGENTS.md`. No code change.
- Updated dependencies [2c57c1c]
- Updated dependencies [a83e735]
- Updated dependencies [a905468]
- Updated dependencies [f3c95a0]
- Updated dependencies [289ba73]
- Updated dependencies [d16933c]
- Updated dependencies [2c57c1c]
- Updated dependencies [a077b15]
- Updated dependencies [f43313b]
- Updated dependencies [d9d791f]
- Updated dependencies [5d55e12]
- Updated dependencies [ff85471]
- Updated dependencies [11c5bc2]
- Updated dependencies [792768a]
- Updated dependencies [440c75f]
- Updated dependencies [745a2c3]
- Updated dependencies [57e9b4b]
- Updated dependencies [c3e63ba]
- Updated dependencies [94a1ee6]
- Updated dependencies [e132ad3]
- Updated dependencies [2be84c9]
- Updated dependencies [49517e2]
- Updated dependencies [cac4bc6]
- Updated dependencies [2c57c1c]
- Updated dependencies [88daaeb]
- Updated dependencies [40e21b4]
- Updated dependencies [c1ed2a3]
- Updated dependencies [3468b2d]
- Updated dependencies [1a897f8]
- Updated dependencies [17e86d3]
  - @arki/schedule@0.1.0
  - @arki/dot@0.9.0

## 0.1.2

### Patch Changes

- Updated dependencies
  - @arki/ts@0.0.2
  - @arki/content@0.1.2
  - @arki/meter@0.1.1

## 0.1.1

### Patch Changes

- Updated dependencies
  - @arki/ts@1.0.0
  - @arki/content@0.1.1
