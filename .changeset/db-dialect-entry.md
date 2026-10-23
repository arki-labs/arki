---
'@arki/db': patch
---

`dialectOf`, `isTransaction`, `isLibsql` and `DIALECTS` are now public through `@arki/db/dialect`; the SQLite release named them but no entry exported them. `@arki/db/pg` exports `PgTableOf` and `@arki/db/sqlite` exports `SqliteTableOf`, so a package that emits declarations can name the type of a table built with a column kit.

`@arki/db/errors` exports `findDatabaseError(error)` and its `DatabaseErrorFacts` type: the SQL-standard SQLSTATE (and, on Postgres, the constraint) of a database error, read the same way on Postgres and SQLite.
