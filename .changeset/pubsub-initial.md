---
'@arki/pubsub': minor
---

New package `@arki/pubsub`: publish and subscribe with one contract over memory (`./memory`), a polled message table on Postgres or SQLite (`./poll`), Postgres LISTEN/NOTIFY (`./pg`) and Redis (`./redis`). `pollPubSub` and `pgPubSub` also have `publishIn(tx, …)`, sent at commit; their types say so. `./testing` exports the conformance suite, `describePubSubContract`.
