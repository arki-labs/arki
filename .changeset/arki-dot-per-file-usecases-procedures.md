---
'@arki/dot': minor
---

One file per usecase, one procedure tree per feature (`entrypoints/procedures.ts`). Breaking (pre-1.0):

- `.usecases()` now takes an object of factories, `{ signup, markInvited }`, each `(deps) => usecase`. Each factory may ask for any subset of the deps (`Pick<Deps, 'repos'>`); one that asks for a dep the feature lacks is a compile error naming it (`'DOT: a usecase asks for a dep the feature does not provide'`). The single-factory form `.usecases(create)` is removed. New types: `UsecaseFactories`, `Usecases`, `UsecaseGuard`.
- `DepsOf<typeof waitlistDeps>` on the stage before `.usecases()` is now exactly what a usecase may ask for (needs + infra), without an empty `usecases` key.
- `rpc(contract, router)` becomes `rpc(contract, implementer, factories)`: a tree of factories shaped like the contract (a group is a nested object), each leaf `(impl) => impl.<path>.handler(…)`. Keep the whole tree in one `entrypoints/procedures.ts`; each leaf takes the implementer as a typed parameter (`import type`), so it never imports the feature at runtime. Keys must match the contract exactly: an extra key is `'DOT: a procedure key is not in the contract'`; a missing key or a procedure that does not implement its key does not compile. New types: `ProcedureFactories`, `BuiltRouter`, `ContractKeysGuard`.

Migrate: split `createUsecases` into one exported factory per key (one file each) and pass `{ a, b }`; turn `procedures(os)` into one tree `export const waitlistProcedures = { name: (impl: typeof rpcImplementer) => impl.name.handler(…) }` and pass `rpc(waitlistRpcContract, rpcImplementer, waitlistProcedures)`.
