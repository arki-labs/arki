---
'@arki/auth': patch
---

New entry `@arki/auth/schema`: Drizzle column sets `authUserColumns`, `authSessionColumns`, `authAccountColumns` and `authVerificationColumns` for the four Better Auth tables, plus `createAuthTables(schema, { ids })` that builds them in the standard shape for a new app. The app passes its own id columns; `naming` is `'snake'` or `'camel'`.
