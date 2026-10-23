---
'@arki/ai': minor
---

The tombstone table now runs on SQLite (libSQL) as well as Postgres. `createTombstoneTable` takes a column kit instead of a `PgSchema`, and `@arki/ai/drizzle/sqlite` adds `sqliteTombstoneOutbox`, the SQLite twin of `tombstoneOutbox`. The Postgres table is unchanged: drizzle-kit sees no difference.

Breaking: the first argument is a column kit, and the user-id type now comes from a value instead of a type argument, so the call takes no type arguments. Migrate `createTombstoneTable<UserId, 'vtmb_'>(schema, { name, idPrefix })` to `createTombstoneTable(pgColumns(schema), { name, idPrefix, userId: defineId('usr_') })`, with `pgColumns` from `@arki/db/pg` (use `pgColumns()` for no schema). Any declaration with a `schema` works as `userId`.

SQLite limits: timestamps keep milliseconds, and `varchar` limits become `CHECK` constraints.
