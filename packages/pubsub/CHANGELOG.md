# @arki/pubsub

## 0.2.0

### Minor Changes

- 5bc51ab: New package `@arki/pubsub`: publish and subscribe with one contract and a dedicated integration per backend, each on its own entry: memory (`./memory`), Postgres LISTEN/NOTIFY (`./pg`), SQLite with a polled message table (`./sqlite`) and Redis (`./redis`). `pgPubSub` and `sqlitePubSub` also have `publishIn(tx, …)`, sent at commit; their types say so. `./testing` exports the conformance suite, `describePubSubContract`.

### Patch Changes

- f3c95a0: A subscriber that returns a rejecting promise no longer becomes an unhandled rejection: it is logged at warn like a throwing one, on every backend. SQLite poll failures and Redis subscriber connection errors are logged at warn instead of debug.
