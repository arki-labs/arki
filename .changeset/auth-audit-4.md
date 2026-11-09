---
"@arki/auth": patch
---

`@arki/auth/testing/integration-tester`: `clearTables`, `clearAllTables`, `clearTablesExcept` and `clearTablesByPattern` empty their tables in one statement, so two tables that reference each other, both holding rows, now clear together (separate deletes were refused with a raw 23503 whatever the order). The JSDoc of the clear helpers and `seed` now names every input that throws: a set that leaves out a referencing table (invariant failure), a table missing from the database, and `seed` records Postgres refuses (a missing referenced row, a repeated key, a missing NOT NULL column). `seed` inserts in the key order of its argument.
