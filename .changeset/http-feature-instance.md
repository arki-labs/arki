---
'@arki/http': minor
---

Feature instances (`feature.instance('eu', rebind)`) now serve their routes, mounts and rpc prefixes under `/<instance>`, so two copies of one feature no longer collide (`GET /reports` becomes `GET /eu/reports`). Set `instancePath: (instance, path) => string` on `http(...)` to change the shape. Plain features are unchanged, and the duplicate-route check still applies.
