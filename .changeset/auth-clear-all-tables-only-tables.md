---
"@arki/auth": patch
---

`IntegrationTester.clearAllTables()` now clears only the Drizzle tables of the schema. It no longer hands relations, enums or other exports of the schema module to `db.delete`, which threw.
