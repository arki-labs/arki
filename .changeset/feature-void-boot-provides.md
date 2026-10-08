---
'@arki/feature': patch
---

Fix: a feature whose `boot` returns nothing (seed, warm a cache) was projected into a plugin that "provides every key". `defineFeature` had no inference candidate for `TProvides`, fell back to its open `ServiceRecord` constraint, and `.use(plug(feature))` / `.useAll(plugs(features))` then failed with a collision against whatever was already mounted (`db`, `kv`, …). Void-boot features now provide nothing, as intended.

Found while building the Drop Studio demo (catalog feature: boot = seed).
