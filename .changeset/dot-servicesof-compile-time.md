---
'@arki/dot': minor
---

`servicesOf(ctx, units)` now rejects a `provides` factory context at compile time instead of throwing ARKI_DOT_E026 at boot, and `feature.instance(name, rebind)` keeps `entrypointOnly` on a rebound need.
