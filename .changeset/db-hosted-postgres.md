---
'@arki/db': minor
---

Hosted Postgres behind a connection pooler (Neon, Supabase, PlanetScale Postgres, self-hosted PgBouncer). The `db()` plugin takes a `directUrl` thunk, falling back to the new `DB_DIRECT_URL` env var, and publishes `sessionPool`: a small pool on the direct URL for `LISTEN`, session locks and migrations. On a known pooled `DB_URL` (Neon `-pooler`, Supabase port `6543`) with no direct URL, the app still boots, and `sessionPool.connect()` rejects with `ARKI_DB_PLUGIN_E004` naming the host and the fix. `@arki/db/pg` exports `pooledHostOf`, `resolveDirectUrl`, `POOLED_HOSTS` and the `db.session_needs_direct_url` failure for apps without Dot. CockroachDB is checked by an opt-in test (`ARKI_DB_CRDB=1`): queries, `40001` retries, unique-violation errors and migrations work; `LISTEN` does not.
