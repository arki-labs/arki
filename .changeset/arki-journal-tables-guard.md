---
'@arki/journal': minor
---

`ExportsEveryJournalTable<Module>` in `@arki/journal/pg`: a compile-time check that a schema module exports every `journalTables()` table at the top level, where drizzle-kit looks. It fails and names each missing table, so a table added by a later journal version can no longer go unmigrated. Tables match by type, not name, and a nested object such as `allJournalTables` does not count.
