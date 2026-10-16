---
'@arki/db': minor
'@arki/kv': patch
---

`transactions(handle)` takes the feature's database handle instead of a type argument: `transactions(database.provides.db)` replaces `transactions<Db>()`. The database and transaction types are read off the handle, and `.infra()` refuses a feature whose `db` need is another database's handle (compile error; `E026` at runtime). `db()` keeps its plugin name in the type (`Plugin<…, 'db'>`), `dbMigrations()` and `kv()` return what `plugin()` infers, so their handles carry `provider: 'db' | 'db-migrations' | 'kv'` instead of `string` and the feature builder's identity checks apply around them. Library plugins that need an app handle take it as a parameter, like `transactions(handle)`; a feature's own infra plugins may name handles directly in `needs` (the `arki-feature-layers/infra-runtime-imports` lint now allows the imports and bans only a plugin's own `feature.ts`, `usecases/` and `entrypoints/`).
