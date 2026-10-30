---
'@arki/journal': minor
---

An effect is application code, not an entrypoint. In a Dot app a feature's effects, taps and workflows are an application contribution of `.usecases(...)`. Breaking (0.x, no shims):

- `journalHandlers(core, { effects, taps, workflows })` takes the feature core first and is mounted as `core.usecases({ ...factories }, journalHandlers(core, { … }))`. It binds once at the feature's boot to the usecase-level deps: needs that are not `entrypointOnly`, private infra, domain services. It no longer takes `projections`: list those with `journalProjections(...)` in `.infra(...)`.
- Removed: the entrypoint helpers `journalEffects(core, …)` and `journalWorkflows(core, defs)`, and the types `JournalEffectsEntrypoint` and `JournalFeatureSlice` (now `JournalHandlers`). `journalWorker()` is the only journal entrypoint.
- New: `needsOf((_: Deps) => ['mailer'])`, the needs record of an effect, tap or workflow in a Dot feature, typed from the selector's parameter annotation with no type arguments. It refuses an `entrypointOnly` key and a key the feature lacks. A key missing at runtime fails the feature's boot and names it. A reaction file is a plain exported value and imports `Deps` from the feature as a type only. New type `UsecaseCore`.
- `dot explain --as journal-flow` is now one graph for the whole app: `nodes` (event, entity, projection, effect, tap, workflow, feature) and typed `edges` (`folds`, `projects`, `reacts`, `owned-by`), with each edge to an event carrying its `timing` and `delivery`, and each reaction its deps and retry policy. The text view prints it per event. It is derived from the declarations at configure; the old `edges: [{ event, effect, plugin, entities }]` shape is gone.
- New in `@arki/journal/orpc`: `orThrowCommand(result, errors)`. A contract-first procedure answers `context.run(command, input)` with it: the contract lists its business failures only, and the journal's own `CommandFailure`s answer through `toORPCError`.

See `docs/upgrades/0.3.0-to-0.4.0.md`, step 11.

docs: README (Dot, A `defineFeature` feature, Workflows in Dot, the actor), `docs/agent-guide.md` (Dot, task map), `llms.txt`.
no demo impact: no demo mounts the journal in a Dot feature.
