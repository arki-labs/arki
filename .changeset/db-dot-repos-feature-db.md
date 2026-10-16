---
'@arki/db': minor
---

`@arki/db/dot` stores take the database from the feature, not from a handle argument.

- Breaking: `repos(factories)` and `advisoryLocks(options)` drop the handle parameter. Both need `db` unbound; the feature declares it: `defineFeature('highlights').needs({ db: entrypointOnly(database.provides.db) }).infra(repos({ … }))`. A feature that declares no `db`, or one of another type, fails at `.infra()` (compile and runtime).
- New `txRepos(factories)`: the same store for a scope that owns its transactions. The published `repos` has `withTx(tx)` only (`TxRepos<F>`), so no usecase can reach a database-bound repository.
