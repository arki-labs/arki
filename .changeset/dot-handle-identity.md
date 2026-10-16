---
'@arki/dot': minor
---

Handles carry the identity of the service they name, and the feature builder reads it. `Plugin` gains two type parameters: `TShape` (the `needs` record as written, alias → witness) and `TOwner` (the plugin's name as a literal); `plugin()` infers both, so `database.provides.db.provider` is `'database'`, not `string`. `rename()` is generic over the plugin and keeps the shape; without a new name the handles keep the original provider. New type exports: `PluginProviderIdentities<P>`, `PluginOwner<P>`.

Two graphs that compiled and failed at runtime are compile errors now: a nested feature whose need names a global handle is no longer remapped onto a same-shaped private infra of its parent (`UnsatisfiedNeed` at boot before), and an infra plugin bound to another plugin's same-shaped handle is refused at `.infra()` in the types (`E026` at runtime before). An infra plugin whose shape is known is checked by need alias, as the runtime resolves it, so a bound need whose alias differs from its key (`clusters: dedup.provides.clusterDetails`) compiles. Plugins annotated `Plugin<N, P>` erase shape and name and keep the previous wire-key checks. Migrate: `expectTypeOf(...).toEqualTypeOf<Handle<T, K>>()` assertions on `plugin()` handles need the third argument (`Handle<T, K, 'name'>`); `ChildUnits` takes the parent's infra owners as its third type parameter.
