---
'@arki/dot': minor
---

`@arki/dot/orpc`: `rpcFor<RequestContext>()` makes the app's `implement` (and `bind`) once; a feature's implementer is `implement(contract).with(logic)` instead of `implement(contract).$context<RequestContext>().use(bind(logic))`. oRPC's config still passes through (`implement(contract, config).with(logic)`). New type `FeatureImplementer`.

Breaking: `rpc(contract, implementer, procedures)` takes one function of the implementer that returns the router (`(impl) => ({ ping: impl.ping.handler(…) })`) instead of a tree of per-leaf factories; a mounted child is `child.router`, no longer `() => child.router`. `Procedures` replaces `ProcedureFactories` and `BuiltRouter`; `ContractKeysGuard` now reads the returned router. A procedures file annotates `impl` once: `export const xProcedures = (impl: typeof rpcImplementer) => ({ … })`.
