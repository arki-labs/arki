---
'@arki/ai': minor
---

The tombstone table now runs on SQLite (libSQL) as well as Postgres. `createTombstoneTable` takes a column kit instead of a `PgSchema`, and `@arki/ai/drizzle/sqlite` adds `sqliteTombstoneOutbox`, the SQLite twin of `tombstoneOutbox`. The Postgres table is unchanged: drizzle-kit sees no difference.

Breaking: the first argument changed. Migrate `createTombstoneTable<UserId, 'vtmb_'>(schema, options)` to `createTombstoneTable<'pg', UserId, 'vtmb_'>(pgColumns(schema), options)`, with `pgColumns` from `@arki/db/pg` (use `pgColumns()` for no schema).

SQLite limits: timestamps keep milliseconds, and `varchar` limits become `CHECK` constraints.
