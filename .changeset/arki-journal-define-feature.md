---
'@arki/journal': minor
---

Journal handlers for `defineFeature` features, the actor-bound runner, and `dot explain` event → effect edges.

- `journalProjections(...projections)` for a feature's `.infra(...)` and `journalEffects(core, { effects, taps })` for its `.entrypoints(...)`, in `@arki/journal/dot`. The journal reads both from the feature value before boot and folds them into one declaration per feature; object-form `journalHandlers` keeps working next to them. An effect's needs are checked against the core at the call (a missing service is a named compile error).
- `actorRun(select)` in `@arki/journal/orpc`: middleware that adds `context.run`, bound to the context's `db` and to the meta the app's `select` returns. The context must carry `journal` and a `db` the journal can write through.
- `@arki/journal/projection` and the `journal-flow` format: `dot explain --as journal-flow` lists which event starts which effect, from the effects' existing action meta. `journal(...)` registers it.
