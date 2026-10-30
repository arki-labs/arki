---
'@arki/admin': patch
---

Breaking: the object-form feature API is removed. Write every feature as a `defineFeature(name).needs().infra().usecases().provides().entrypoints()` chain.

- `@arki/dot`: removed `feature()`, `plug`, `composeRouter`, `composeRepos`, `tokenOf`, `entrypointsOf` and the types `AnyFeature`, `MountedFeature`, `UnitOf`, `MountedUnitsOf`, `FeatureConfig`, `ComposedRouter`, `ComposedRepos`. `defineApp().features()` takes chain features only. Use `routerFor(rpcContract, features)` instead of `composeRouter`, and a feature's own `repos({...})` store instead of `composeRepos`. Read `f.entrypoints` instead of `entrypointsOf(f)`. Lifecycle hooks (`boot`, `start`, `stop`) live on an infra unit inside the feature.
- `@arki/http`: removed `endpoints(build)` and `EndpointsFeatureSlice` from the root export. Use `endpoints(core, build, { contracts })` from `@arki/http/dot` in `.entrypoints()`.
- `@arki/schedule`: removed the `schedules(needs, defs)` overload. Use `schedules(core, defs)` in `.entrypoints()`.
- `@arki/queue`, `@arki/journal`, `@arki/admin`: dropped their object-form branches. The chain API is unchanged.
