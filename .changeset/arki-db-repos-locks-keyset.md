---
'@arki/db': minor
---

First-class repositories, ids, locks and keyset pagination (RFC `docs/rfcs/2026-10-15-dot-feature-builder.md`, phase 1c).

- `@arki/db/dot`: `repos(database.provides.db, factories)` — a feature's repositories as one plugin, built once per boot and bound to the database the handle names (its type must be one the factories accept). `repos.withTx(tx)` rebinds the set to a transaction (a fresh set per call; nested transactions rebind the original set). `withTx` is a reserved name (compile error and `ARKI_DB_PLUGIN_E002`). `reader(repo, ['get'])` publishes bound methods for other features (`ARKI_DB_PLUGIN_E003` for a non-method). `advisoryLocks(handle, { namespace })` publishes a `locks` service.
- `@arki/db/lock` (new): `withAdvisoryLock(db, key, fn)` and `advisoryLocks(db, { namespace })` — PostgreSQL advisory locks held for the whole job on one pinned connection; same key hash as Avocabo's `withCronLock`.
- `@arki/db/pagination` (new): `keysetQuery(keyset, columns)` — `orderBy`, `after(cursor)`, `take(limit)` (`limit + 1`) and `page(rows, limit)` for a `keyset()` from `@arki/contracts`.
- `@arki/db/id`: `idColumns(defineId('sty_'))` — the column helpers of `createIdFactory` for an id declared in `@arki/contracts`. `createIdFactory` now builds its columns through it (same output).
