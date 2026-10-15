---
'@arki/dot': minor
---

Adds the chain form of a feature and contract-first composition, next to the existing API (RFC `docs/rfcs/2026-10-15-dot-feature-builder.md`). The old `feature()`, `.use()`, `.serve()`, `plug`, `composeRouter` and `composeRepos` stay for now; a later changeset removes them.

- `defineFeature(name).needs().infra().usecases().provides().entrypoints()` in `@arki/dot/feature`. Stage order is a compile error; usecases get `{ ...needs, ...infra }`; provides factories and entrypoints also get `usecases`, built once per boot. Feature infra is private: keys are published as `<feature>.<key>` from units named `<feature>/<plugin>`, and sibling needs follow the qualified key. `session`, `headers`, `services` and `usecases` are reserved; infra/need and entrypoint/provides collisions are compile errors and `FEATURE_E006` at runtime.
- A finished feature has `plugins()` (a typed tuple the app builder guard checks), `override(values)` (swaps infra services in place, keeps entrypoints; `FEATURE_E007` for an unknown key), `handles`, `provides`, `entrypoints`, and `contract` / `router` from its `rpc` entrypoint.
- Entrypoint descriptor protocol `{ kind, key, actions, resolve }` (`Entrypoint`, `RpcEntrypoint`, `DepsOf<typeof core>`) for adapter packages.
- `routerFor(appContract, features)`: mount keys written once in the app contract, features found by contract identity; unmatched keys and contracts are compile errors and `FEATURE_E008` / `FEATURE_E009` at runtime.
- `defineApp(...).infra(...units)` and `.entrypoints(...adapters)` (variadic, checked like `.useAll()`); `.features()` accepts `defineFeature` features next to `feature()` values and mounts their infra units.
- `servicesOf` accepts any unit with `provides` (features or plugins). `handleOf` and `AnyHandle` are exported from `@arki/dot/plugin`. `FeatureError` and its codes move to an internal module (same exports).
