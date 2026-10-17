---
'@arki/db': minor
---

A PGlite data directory has one owner. `initDbRuntimeLocal` (and so `db({ driver: 'pglite', dataDir })`) takes an owner lock, `<dataDir>/.arki-owner`, before it opens PGlite. A second open while the first handle lives, in another process or in the same one, throws `DbRuntimeLocalError` with code `ARKI_DB_LOCAL_E001` and the owner's `pid` (both exported from `@arki/db/runtime-local`, with `DB_RUNTIME_LOCAL_ERROR_CODES`). A lock left by a process that is gone is taken over; there is no age-based takeover. `pglite.close()` gives the lock back, and so does a PGlite that fails to start (it used to stay open). `memory://` and `idb://` take no lock, and `node:fs` loads only for file paths.

`createDb({ url })` no longer needs `DB_URL`: the pool settings are read without validating it. `getDbConnectionParams()` works without `DB_URL` too.

Breaking (0.x): two handles on one PGlite directory used to open (and corrupt the data); the second now throws.
