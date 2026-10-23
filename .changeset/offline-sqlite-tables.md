---
'@arki/offline': minor
---

The oRPC idempotency table now runs on SQLite (libSQL) as well as Postgres. `createIdempotencyTable` takes a column kit instead of a `PgSchema`, and `SqliteIdempotencyRepository` is the SQLite twin of `IdempotencyRepository` (it works with `idempotency(...)` the same way). The Postgres table is unchanged: drizzle-kit sees no difference. `@arki/db` is a new optional peer, needed for the column kits.

Breaking: the first argument changed. Migrate `createIdempotencyTable(schema)` to `createIdempotencyTable(pgColumns(schema))`, with `pgColumns` from `@arki/db/pg`. `idempotencyKeys` (default schema) is unchanged.

SQLite limits: timestamps keep milliseconds, and `varchar` limits become `CHECK` constraints.
