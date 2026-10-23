---
'@arki/auth': minor
---

`@arki/auth` now runs on SQLite (libSQL) as well as Postgres. The auth and workspace tables are written once against the column kit of `@arki/db`, and the new entries `@arki/auth/sqlite` and `@arki/auth/sqlite/workspaces` build them on SQLite. `createAuth` reads Better Auth's adapter dialect from `db`; `AuthDb` accepts a libSQL database, and `AuthTables` takes tables of either dialect. `testAuth(definition, { tables, database: 'libsql' })` runs a test auth on in-memory libSQL. The Postgres tables are unchanged: drizzle-kit sees no difference, and their row types are the same.

Breaking: `createAuthTables`, `createWorkspaceTables` and the `auth*Columns` helpers take a column kit instead of a `PgSchema`, and their columns are kit specs. Migrate `createAuthTables(schema, { ids: { user: userIdColumns, session: sessionIdColumns, account: accountIdColumns, verification: verificationIdColumns }, columns: { user: { tweaks: tweaksColumn().notNull().default(EMPTY_TWEAKS) } } })` to `const c = pgColumns(schema); createAuthTables(c, { ids: authIdSources, columns: { user: { tweaks: tweaksSpec(c).notNull().default(EMPTY_TWEAKS) } } })`, with `pgColumns` from `@arki/db/pg`. Extra columns become `c.text(...)`, `c.timestamp(...)`, `c.json(...)`; a custom id is `{ primaryColumn: () => c.text('id')... }` or `c.id(declaration)`. `createWorkspaceTables(schema, …)` becomes `createWorkspaceTables(pgColumns(schema), …)`. `tweaksColumn()` and the `*IdColumns` helpers for an app's own Postgres tables are unchanged.

SQLite limits: timestamps keep milliseconds, not microseconds; case-insensitive matching covers ASCII letters only; unique-violation errors carry no constraint name. The workspace scoping kernel stays on `@arki/auth/pg/workspaces`.
