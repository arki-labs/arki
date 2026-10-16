---
'@arki/db': patch
'@arki/journal': patch
---

New `@arki/db/errors` entry with `isUniqueViolation(error, constraint?)`: the "insert, and answer CONFLICT on a duplicate" check, read the same way for node-postgres, PGlite and Bun SQL, and through Drizzle's `DrizzleQueryError`. Bun SQL puts the SQLSTATE in `errno` and its own name (`ERR_POSTGRES_SERVER_ERROR`) in `code`, so a check that reads `code` never matched there.

Fix: `runTransaction` now retries a `40001` / `40P01` raised by Bun SQL. `retryableSqlState` stopped at Bun's `code` and never saw the SQLSTATE in `errno`, so under Bun a serialization failure or deadlock reached the caller on the first try.

`@arki/journal` uses the shared check in place of its private copy, and no longer matches the error message text.
