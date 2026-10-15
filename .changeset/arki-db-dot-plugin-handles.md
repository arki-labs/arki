---
'@arki/db': patch
---

`db()` publishes through a `provides` factory (`database.provides.db` is a typed handle before boot) and the pg driver takes `url?: () => string | undefined`, read at boot and falling back to `DB_URL`. `createDb()` accepts an optional `url` that overrides `DB_URL`.
