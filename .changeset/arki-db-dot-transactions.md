---
'@arki/db': minor
---

`@arki/db/dot`: `transactions<Db>()`, an infra plugin that needs `db` unbound and publishes one function, `transaction(fn)`: `fn` runs inside a transaction of the feature's database, committed on return and rolled back on a throw. Nothing else leaves it (no query builder, no `db`), so with `db` entrypoint-only a usecase may open a transaction but never run raw SQL. The `tx` it hands out is the database's own transaction type (`TxOf<Db>`); `OpenTransaction<Tx>` is the published function's type.
