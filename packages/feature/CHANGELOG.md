# @arki/feature

## 0.0.2

### Patch Changes

- 50d4c41: Fix: a feature whose `boot` returns nothing (seed, warm a cache) was projected into a plugin that "provides every key". `defineFeature` had no inference candidate for `TProvides`, fell back to its open `ServiceRecord` constraint, and `.use(plug(feature))` / `.useAll(plugs(features))` then failed with a collision against whatever was already mounted (`db`, `kv`, …). Void-boot features now provide nothing, as intended.

  Found while building the Drop Studio demo (catalog feature: boot = seed).

## 0.0.1

### Patch Changes

- Initial public release of @arki/feature — declare a backend feature once (router fragment, repository factory, adapter slices, needs, boot) as an inert value; fold app artifacts from the single feature list (`composeRouter`, `composeRepos`); project onto the `@arki/dot` kernel via `plug`/`plugs`/`tokens` from `./dot`.
