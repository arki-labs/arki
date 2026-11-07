---
'@arki/db': minor
'@arki/journal': minor
'@arki/live': minor
---

A Postgres listener that cannot start now returns its failure instead of rejecting.

- `@arki/db`: `listenOnPool(pool, channel)(onMessage)` resolves to `ListenUnavailable` (`db.listen_unavailable`) when the first connection or `LISTEN` fails. It no longer rejects with an `UnexpectedFailure`. The raw pool error stays its private `cause`. Nothing retries: call the start again.
- `@arki/journal`: a `WakeListener` may return a `Failure`. `worker.start()` resolves to that failure and leaves the worker stopped, so a later `start()` tries again. A `listen` that throws also leaves it stopped (before, the worker stayed marked running and every later `start()` did nothing). The failure type is inferred: a worker without `listen` returns no failure. In Dot, `journalWorker()` returns the failure from `start`, so the app's start fails with it.
- `@arki/pubsub`: `PubSub` and `TransactionalPubSub` take a `SubscribeFailure` type (`never` by default). `pgPubSub`'s `subscribe` resolves to `db.listen_unavailable` when the channel's listener cannot start; nothing stays subscribed, and the next `subscribe` tries again.
- `@arki/live`: a `LiveSource`'s `start` may return a failure, and `hub.start()` resolves to it (`pgSource`: `db.listen_unavailable`). The hub stays `idle` and stopped, so a later `hub.start()` on the same hub tries again; a successful start happens once. `liveQueries()` returns it from its Dot `start`.

Upgrade: check the result of `worker.start()`, `hub.start()` and pg `subscribe()` where a listener is wired, for example `orThrow(await worker.start())` in a script, or return it from a Dot `start` hook.
