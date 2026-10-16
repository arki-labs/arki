---
'@arki/dot': minor
---

`feature.instance(name, rebind?)`: a second copy of a finished feature, named `<feature>#<instance>` (`reports#eu`), with its own infra units, usecases, services and entrypoints, publishing under `<feature>#<instance>.<key>` so two copies mount side by side (next to the original or not). `rebind` swaps a need's handle for another provider's handle of the same service type (`{ db: databaseEu.provides.dbEu }`); a nested child is re-derived under the copy and a child need on the same handle follows, lazy form included. Each copy's rpc entrypoint has its own contract identity, so the app contract mounts `eu.contract` and `us.contract` under their own keys. `#` is reserved in a declared feature name. New `instanceOf(name)` (`'reports#eu.audit'` → `'eu'`) for adapters, and the types `RebindOf`, `RebindNeeds`, `InstanceChildren`, `FeatureParams`. `WireNeeds` now reads a need's wire key from `key` alone: a handle whose key holds `#` has one wire key, not two.
