---
'@arki/dot': minor
'@arki/http': minor
'@arki/schedule': minor
'@arki/queue': minor
'@arki/journal': minor
---

Features moved into Dot, and the app builder is now a hexagon. `@arki/feature` is merged into `@arki/dot/feature`: `defineFeature()` is now `feature()`, and `composeRouter`, `composeRepos` and the feature types come from `@arki/dot/feature`. `plug`, `plugs` and `tokens` are gone — the builder mounts features itself.

Apps wire in three steps, checked at compile time: `.use(...)` for driven adapters (what features need), `.features([...])` once for the domain, then `.serve(...)` for driving adapters (what calls the features). `.use()` after `.features()` does not compile, a feature is not a plugin, and adapters declare their side: `driver(features => plugin(...))` is accepted only by `.serve()`, `driven(features => plugin(...))` only by `.use()`. Driven adapters read the features' declarations and boot before them; driving adapters get each feature's slice record with `sliceOf(ctx, f)`. Guard errors are plain sentences, and `dot explain --graph` draws the driven, features and driving groups numbered in boot order (`PluginManifest.role`).

`@arki/http`: `http()` is a driver for `.serve()` and serves every bound feature's `routes` slice; the `features` option and `HttpFeatureToken` / `HttpFeatureNeeds` are removed. A malformed `routes` slice fails boot with `ARKI_HTTP_E010`.

`@arki/schedule`: `schedule()` is a driver for `.serve()` and collects every bound feature's `schedules` slice; the `features` option and the feature-token option types are removed. App-level `schedules` are optional. Feature schedules are no longer checked against `context` at compile time (features bind at runtime); a malformed slice fails boot with `ARKI_SCHEDULE_E001`.

`@arki/queue`: `queueRuntime()` is replaced by two units. `queue({ connection, keyPrefix? })` goes in `.use()` and provides `queue: QueueClient` (`enqueue(job, data, opts?)`), so features can enqueue. `queueWorker({ q, needs, context })` goes in `.serve()` and runs the features' `jobs()` slices, using the client's connection and key prefix. `jobs()` slices carry only producer actions; the worker owns the consumer actions. `QueueFeatureToken`, `QueueRuntimeOptions`, `QueueRuntimeFeatureOptions`, `QueueFeatureNeeds`, `QueueRuntimeHandle` and codes `E004`/`E005` are removed; a missing client fails with `ARKI_QUEUE_E006`.

`@arki/journal`: the journal splits like the queue. `journal({ j, tables })` is a `driven(...)` adapter for `.use()`: it composes from every feature's `journalHandlers` declarations and boots before the features, so features can write through it. `journalWorker(opts?)` is a driver for `.serve()` that runs projections and effects, getting each feature's effect services from its slice. Inline projections only receive the transaction and the event, so writes never wait for feature services. `journal({ journal })` publishes an app-composed journal and no longer runs a worker; add `.serve(journalWorker())`. Core: `j.compose({ ..., services: 'worker' })` defers effect and tap services, which `journal.worker(db, { services })` and `journal.drain(db, { services })` supply per handler (`HandlerRef`, `HandlerServices`). Removed: the `features` option, the `worker`/`pollMs` options on `journal()`, and the `JournalHandlers` type.
