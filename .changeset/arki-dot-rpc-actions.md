---
'@arki/dot': minor
---

`rpc(contract, router)` now emits one manifest action per procedure (binding `rpc`, id `<feature>.<path>`), so `dot explain` lists a feature's procedures with their HTTP route, declared errors and contract `meta` (where a policy such as `{ auth: 'admin' }` is declared). Contract meta that is not plain JSON throws `FEATURE_E010` at `rpc()`. Entrypoint descriptors may declare `actionsOf(feature)` for actions whose ids need the feature name. `RPC_ACTION_META_SCHEMA` names the meta layout.
