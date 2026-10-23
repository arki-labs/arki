---
'@arki/pubsub': minor
---

New package `@arki/pubsub`: publish and subscribe with one contract and a dedicated integration per backend, each on its own entry: memory (`./memory`), Postgres LISTEN/NOTIFY (`./pg`), SQLite with a polled message table (`./sqlite`) and Redis (`./redis`). `pgPubSub` and `sqlitePubSub` also have `publishIn(tx, …)`, sent at commit; their types say so. `./testing` exports the conformance suite, `describePubSubContract`.
