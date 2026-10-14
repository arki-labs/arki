# @arki/feature

## 0.1.0

### Minor Changes

- 0685dfa: Mistakes in declarations are now caught as early as possible: by TypeScript when the types can say it, otherwise by a coded error when the module loads.

  - `@arki/feature`: `composeRouter` and `composeRepos` reject a key claimed by two features at compile time. The runtime check stays as a backstop and now throws `FeatureError` with code `FEATURE_E001` (router) or `FEATURE_E002` (repo) and a `remediation`. Messages are unchanged.
  - `@arki/http`: mount paths for `rpcMount(...)` and `.mount(...)` are typed `MountPath` (`` `/${string}` ``), so a path without a leading `/` is a compile error. The runtime check stays.
  - `@arki/db`: the projection builder's two "call .named() / .on() first" errors are now `DbCompositionError` with codes `DB_COMPOSITION_E002` and `DB_COMPOSITION_E003`. `DbCompositionError` gains an optional `remediation`.
  - `@arki/dot`: when `dot explain` or `dot doctor` cannot import the app because a declaration threw a coded error, the output shows that error's code and its fix, not only "import failed".

### Patch Changes

- Updated dependencies [0685dfa]
- Updated dependencies
- Updated dependencies [2854df5]
  - @arki/dot@0.5.0

## 0.0.2

### Patch Changes

- 50d4c41: Fix: a feature whose `boot` returns nothing (seed, warm a cache) was projected into a plugin that "provides every key". `defineFeature` had no inference candidate for `TProvides`, fell back to its open `ServiceRecord` constraint, and `.use(plug(feature))` / `.useAll(plugs(features))` then failed with a collision against whatever was already mounted (`db`, `kv`, …). Void-boot features now provide nothing, as intended.

  Found while building the Drop Studio demo (catalog feature: boot = seed).

## 0.0.1

### Patch Changes

- Initial public release of @arki/feature — declare a backend feature once (router fragment, repository factory, adapter slices, needs, boot) as an inert value; fold app artifacts from the single feature list (`composeRouter`, `composeRepos`); project onto the `@arki/dot` kernel via `plug`/`plugs`/`tokens` from `./dot`.
