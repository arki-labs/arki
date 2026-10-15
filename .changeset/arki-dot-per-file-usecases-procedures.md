---
'@arki/dot': minor
---

One file per usecase, one file per procedure. Breaking (pre-1.0):

- `.usecases()` now takes an object of factories, `{ signup, markInvited }`, each `(deps) => usecase`. Each factory may ask for any subset of the deps (`Pick<Deps, 'repos'>`); one that asks for a dep the feature lacks is a compile error naming it (`'DOT: a usecase asks for a dep the feature does not provide'`). The single-factory form `.usecases(create)` is removed. New types: `UsecaseFactories`, `Usecases`, `UsecaseGuard`.
- `DepsOf<typeof base>` on the stage before `.usecases()` is now exactly what a usecase may ask for (needs + infra), without an empty `usecases` key.
- `rpc(contract, router)` becomes `rpc(contract, os, factories)`: one factory per procedure, `(os) => os.<path>.handler(…)`, shaped like the contract (a group is a nested object). Keys must match the contract exactly: an extra key is `'DOT: a procedure key is not in the contract'`; a missing key or a procedure that does not implement its key does not compile. New types: `ProcedureFactories`, `BuiltRouter`, `ContractKeysGuard`.

Migrate: split `createUsecases` into one exported factory per key and pass `{ a, b }`; split `procedures(os)` into one `<name>Procedure = (o: typeof os) => …` per procedure and pass `rpc(contract, os, { name: nameProcedure })`.
