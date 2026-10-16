---
'@arki/auth': minor
---

The lib owns the Better Auth table shapes; an app builds them with one call each.

- `createAuthTables(schema, { naming, fill, ids, columns })` gains `fill` (`'app'`: Drizzle `$defaultFn` in the app; `'database'`: `DEFAULT now()` / `DEFAULT false` in the database, `NOT NULL`) and `columns` (the app's own columns per table, merged after the standard ones; a standard key replaces that column; the row types include them). It no longer adds the `tweaks` column: an app that wants it passes `columns: { user: { tweaks: tweaksColumn().notNull().default(EMPTY_TWEAKS) } }`.
- Breaking: `fill` is required, on `createAuthTables` and on the column sets `authUserColumns`, `authSessionColumns`, `authAccountColumns`, `authVerificationColumns`. Existing callers pass `fill: 'app'` to keep their shape.
- New `createWorkspaceTables(schema, { naming, fill, user, ids })` in `@arki/auth/workspaces` builds the five organization-plugin tables (`organizations`, `members`, `invitations`, `teams`, `team_members`) and returns them with `orgForeignKeys` / `teamForeignKeys` already bound.
