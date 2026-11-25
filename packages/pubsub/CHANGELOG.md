# @arki/pubsub

## 0.3.0

### Minor Changes

- 4f24c6d: A Postgres listener that cannot start now returns its failure instead of rejecting.

  - `@arki/db`: `listenOnPool(pool, channel)(onMessage)` resolves to `ListenUnavailable` (`db.listen_unavailable`) when the first connection or `LISTEN` fails. It no longer rejects with an `UnexpectedFailure`. The raw pool error stays its private `cause`. Nothing retries: call the start again.
  - `@arki/journal`: a `WakeListener` may return a `Failure`. `worker.start()` resolves to that failure and leaves the worker stopped, so a later `start()` tries again. A `listen` that throws also leaves it stopped (before, the worker stayed marked running and every later `start()` did nothing). The failure type is inferred: a worker without `listen` returns no failure. In Dot, `journalWorker()` returns the failure from `start`, so the app's start fails with it.
  - `@arki/pubsub`: `PubSub` and `TransactionalPubSub` take a `SubscribeFailure` type (`never` by default). `pgPubSub`'s `subscribe` resolves to `db.listen_unavailable` when the channel's listener cannot start; nothing stays subscribed, and the next `subscribe` tries again.
  - `@arki/live`: a `LiveSource`'s `start` may return a failure, and `hub.start()` resolves to it (`pgSource`: `db.listen_unavailable`). The hub stays `idle` and stopped, so a later `hub.start()` on the same hub tries again; a successful start happens once. `liveQueries()` returns it from its Dot `start`.

  Upgrade: check the result of `worker.start()`, `hub.start()` and pg `subscribe()` where a listener is wired, for example `orThrow(await worker.start())` in a script, or return it from a Dot `start` hook.

### Patch Changes

- d74e617: The README now has a runtime support section with a tested table: the memory pubsub passes on Node, Bun,
  Deno, browsers and Hermes. Code is unchanged.

  no docs impact: README updated in this change.
  no demo impact: code unchanged.

- 2b44ad3: `@arki/pubsub` now reports to OpenTelemetry: a `pubsub.publish` or `pubsub.publish_in` span per publish, a
  `pubsub.deliver` span per message per subscriber, a `pubsub.sqlite.poll` span for each SQLite poll that read rows
  or failed, and the `pubsub.operations` counter. Spans carry the backend name and, on a failure, `error.type`; never
  a channel name or a payload. It uses `@opentelemetry/api` only, so nothing is exported until the app configures an SDK.

  no docs impact: README gains an Observability section; no API changed.
  no demo impact: no demo reads pubsub telemetry.

- 744896d: Add the README standard sections and `AGENTS.md`.

## 0.2.0

### Minor Changes

- 5bc51ab: New package `@arki/pubsub`: publish and subscribe with one contract and a dedicated integration per backend, each on its own entry: memory (`./memory`), Postgres LISTEN/NOTIFY (`./pg`), SQLite with a polled message table (`./sqlite`) and Redis (`./redis`). `pgPubSub` and `sqlitePubSub` also have `publishIn(tx, …)`, sent at commit; their types say so. `./testing` exports the conformance suite, `describePubSubContract`.

### Patch Changes

- f3c95a0: A subscriber that returns a rejecting promise no longer becomes an unhandled rejection: it is logged at warn like a throwing one, on every backend. SQLite poll failures and Redis subscriber connection errors are logged at warn instead of debug.
