---
'@arki/http': minor
---

`endpoints(core, build, { contracts })` in `@arki/http/dot`: a `defineFeature` feature's HTTP surface, for its `.entrypoints(...)`. `build` gets the feature's needs, private infra and `usecases`, typed from the core; `contracts` become the feature's manifest actions. `http()` serves chain and object-form features from one route table.
