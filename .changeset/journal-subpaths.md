---
'@arki/journal': minor
---

Two new entries. `@arki/journal/errors` exports `CommandError`, `JournalError`, `isCommandError`, `isJournalError` and the code types with no Drizzle import, so browser code can match on codes. `@arki/journal/testing` exports `openJournalDb(schema)`, an in-memory PGlite with the schema pushed; `@electric-sql/pglite` and `drizzle-kit` become optional peers.
