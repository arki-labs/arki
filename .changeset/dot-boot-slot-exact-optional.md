---
'@arki/dot': patch
---

Units built by another package now mount in apps that turn on `exactOptionalPropertyTypes`. A package's emitted `.d.ts` wrote an authored unit's `boot` member out as `boot?: Fn | undefined`, so `.infra(...)` refused `log()`, `db()` and `dbMigrations()` with TS2345 in such apps. The member is now the exported `BootSlot` type, which the emitted declarations name instead.
