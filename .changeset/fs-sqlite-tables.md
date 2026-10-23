---
'@arki/fs': minor
---

The files table runs on SQLite (libSQL) as well as Postgres. `filesTable` is written once against the `@arki/db` column kit, and the new `@arki/fs/sqlite` entry has the same `filesTable`, `fileStorage`, sweep and types as `@arki/fs/pg`. On Postgres the DDL is unchanged, so no migration is needed.

**Breaking:** `filesTable` takes the kit first, and the Postgres schema moves into it. Migrate each call:

```ts
filesTable({ owner: userId, schema }); // before
filesTable(pgColumns(schema), { owner: userId }); // after; pgColumns from '@arki/db/pg'
```

On SQLite: `filesTable(sqliteColumns({ prefix? }), { owner })` from `@arki/db/sqlite`, and `fileStorage(db, adapter, options)` from `@arki/fs/sqlite` with the root `createLibsqlDb` handle. `FilesTable<D, TOwner>` now names the dialect; plain `FilesTable` means either. SQLite limits:

- Cleanup workers in different processes take turns instead of running in parallel: SQLite has one writer and no `SKIP LOCKED`, so the sweep claims rows with one `UPDATE … RETURNING` inside a write transaction.
- Timestamps keep milliseconds (Postgres keeps them too: `timestamptz(3)`).
- The `char(64)` limit on `sha256` is enforced by the kit's `length()` CHECK; the hex check uses `regexp`.
