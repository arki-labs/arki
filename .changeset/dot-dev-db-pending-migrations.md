---
'@arki/db': minor
---

`pendingMigrations(db, options)` (from `@arki/db/migrate`) lists the migrations `migrateDb` would apply now, in order. It is read only and uses drizzle's own rule. `dbMigrations()` now provides `migrations: { pending }`: the names its boot found pending, read before it applied them. `dot dev` prints them.
