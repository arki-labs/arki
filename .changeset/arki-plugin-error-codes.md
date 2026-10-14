---
'@arki/kv': minor
'@arki/db': minor
'@arki/journal': minor
'@arki/dot': patch
---

Dot plugin error codes join the `ARKI_` scheme: `KV_PLUGIN_E001` is now `ARKI_KV_PLUGIN_E001`, `DB_PLUGIN_E001` is `ARKI_DB_PLUGIN_E001` and `JOURNAL_PLUGIN_E001` is `ARKI_JOURNAL_PLUGIN_E001`. Code that matches on the old strings must update; the `*_PLUGIN_ERROR_CODES` constants carry the new values. The kv and db `docsUrl` slugs follow the codes. `@arki/dot` documents `ARKI_<PKG>_PLUGIN_E<NNN>` as the recommended prefix.
