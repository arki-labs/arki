---
'@arki/dot': minor
'@arki/journal': minor
'@arki/schedule': minor
'@arki/queue': minor
'@arki/http': minor
---

`infra.fromFeatures` and `entrypoint.fromFeatures` take one declaration, the same one `infra()` and `entrypoint()` take, instead of a callback `features => unit({...})`. Breaking: rewrite each callback (`docs/upgrades/0.7.0-to-0.8.0.md`, step 6).

- Every `provides` factory and lifecycle hook also gets `$features`, the app's mounted features, and `$state`, what the declaration's new `state()` returned for this app. The builder calls `state()` once per app, so two apps built from one binder never share a worker, a timer or a server. Without `state`, `$state` is `undefined`.
- `actions` may be a function of the mounted features.
- The binder has a static `name` and typed `provides` handles, so a feature needs a `fromFeatures` service by handle: `entrypointOnly(appJournal.provides.journal)`. A misplaced binder is reported by its name, not `infra.fromFeatures(...)`.
- New types: `FromFeaturesDefinition` and `FeaturesContext` (`@arki/dot/unit`, `@arki/dot/feature`). `UnitBinder` gains `name` and `provides`.
- `@arki/journal`: `journal({ j })` exposes `provides.journal`; `JournalDriven` is inferred from it. `journalWorker()` keeps its worker in `$state`.
- `@arki/schedule`: `schedule(...)` exposes `provides.scheduler`.
- `@arki/queue` (`queueWorker`) and `@arki/http` (`http`) keep their per-app runtime in `$state`. No change for their callers.

docs: `packages/dot/docs/unit-authoring.md` (Units built from the features), `composition-doctrine.md`, `di.md`, the upgrade note; `@arki/journal` README; `@arki/schedule` `docs/reference/dot.md`.
no demo impact: no demo calls `fromFeatures` directly.
