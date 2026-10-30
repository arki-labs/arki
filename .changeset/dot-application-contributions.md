---
'@arki/dot': minor
---

`.usecases(factories, ...contributions)` takes application contributions (`ApplicationContribution`, `AnyApplicationContribution` from `@arki/dot/feature`). A contribution is application code that is not a usecase handle: the journal's effects, taps and workflows (`journalHandlers(core, …)` from `@arki/journal/dot`).

- Its static declarations are read before boot from `feature.contributions`, which `DefinedFeature` and `AnyDefinedFeature` now carry.
- `bind(deps)` runs once at the feature's boot with the usecase-level deps: needs that are not `entrypointOnly`, infra, domain services, children. Its payload lands in the slice record under its `key`; `sliceOf` reads it. A contribution and an entrypoint may not share a key (`ARKI_DOT_E024`, as for two entrypoints).
- It is never a `usecases` member and has no lifecycle hooks. Entrypoints still see only the usecases and the `entrypointOnly` needs.
- `ProjectionManifest` gains `meta`: adapter-owned JSON a projection module reads, checked for a JSON round trip at configure. A projection module may export `render(document)`; `dot explain --as <format>` prints its string, and `--json` keeps the document.
- `DomainServiceValues` is exported from `@arki/dot/feature`, so a declaration file can name `typeof core` for a feature with domain services.

docs: `docs/adapter-authoring.md` (Application contributions, Projection data), `docs/composition-doctrine.md`, `docs/agent-guide.md`, `docs/upgrades/0.7.0-to-0.8.0.md`.
no demo impact: no demo declares a contribution or a projection module.
