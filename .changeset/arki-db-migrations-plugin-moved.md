---
'@arki/db': minor
---

Move the `dbMigrations` DOT plugin from `@arki/db/migrate` to `@arki/db/dot`. `@arki/db/migrate` keeps `migrateDb`, `readMigrations` and the types, and no longer imports `@arki/dot`. Replace `import { dbMigrations } from '@arki/db/migrate'` with `import { dbMigrations } from '@arki/db/dot'`.
