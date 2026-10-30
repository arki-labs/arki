---
'@arki/dot': minor
---

Entrypoint handlers are now typed with what they really receive at every builder stage. `EntrypointServicesOf<typeof core>` is new in `@arki/dot`: a feature's `entrypointOnly` needs plus its `usecases`. `endpoints(core, build)` and `schedules(core, defs)` use it, so a feature with no `.usecases()` can now read its `entrypointOnly` needs in a route or schedule, and can no longer read plain needs that never arrive. A rebound `entrypointOnly` lazy need (`feature.instance(name, rebind)`) now stays entrypoint-only.
