---
'@arki/db': minor
---

The column kit: a package writes each table once, against `ColumnKit<D>` (`@arki/db/columns`), and the app passes `pgColumns(schema?)` (`@arki/db/pg`) or `sqliteColumns({ prefix? })` (`@arki/db/sqlite`). Kit tables have exactly the types of hand-written `pgTable` / `sqliteTable` tables, and on Postgres drizzle-kit sees no difference, so moving tables to the kit needs no migration. On SQLite, `varchar(n)` / `char(n)` keep their limit as a `length()` `CHECK`, and index names take the prefix. `@arki/db/sqlite` also gains `instant`, a `Temporal.Instant` column stored as integer milliseconds.
