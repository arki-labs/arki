---
'@arki/db': patch
---

Add `@arki/db/migrate`: `migrateDb(db, { migrationsFolder })` applies drizzle migrations to a handle from either driver, and `dbMigrations()` is the DOT plugin that does so at boot (mount it after `db()`, before features). Consumers no longer import drizzle's migrator modules themselves, which outside the monorepo pulled in a second `drizzle-orm` with mismatched types.

Both also accept `{ migrations }` — a list already in memory — and `readMigrations(folder)` produces that list at build time. A bundled server (Nitro, `.output/`) has no `drizzle/` folder next to it, so the app commits a generated module instead.

Fix: the PGlite driver (`db({ driver: 'pglite' })` and `initDbRuntimeLocal`) now honours the `logger` option like the pg driver does; before, it was silently dropped.

Found while building the Drop Studio demo against the published packages.
